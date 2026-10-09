const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const {test} = require("node:test")
const source = fs.readFileSync(path.join(__dirname, "../src/components/backgroundStore.js"), "utf8")
const context = vm.createContext({module: {exports: {}}, setTimeout, clearTimeout})
vm.runInContext(source.replace("export default", "module.exports ="), context)
const old = "internal://files/bg_100.png"
// JPEG SOF尺寸头：存储层只验证格式/尺寸，完整解码由插件负责。
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]).toString("base64")

function harness() {
  const files = new Map([[old, "old"]])
  const tasks = []
  const calls = []
  let timeout = null
  let failure = ""
  const file = {}
  for (const method of ["list", "readText", "writeText", "writeArrayBuffer", "move", "delete"]) {
    file[method] = (options) => {
      calls.push([method, options.uri || options.srcUri])
      const snapshot = Array.from(files.keys()).map((uri) => ({uri}))
      tasks.push(() => {
        if (failure === method || failure === method + ":" + (options.dstUri || options.uri)) {
          if (method === "writeArrayBuffer") files.set(options.uri, "partial")
          options.fail("io error", 300)
          return
        }
        if (method === "list") { options.success({fileList: snapshot}); return }
        if (method === "readText") {
          if (files.has(options.uri)) options.success({text: files.get(options.uri)})
          else options.fail("not found", 301)
          return
        }
        if (method === "writeText") files.set(options.uri, options.text)
        if (method === "writeArrayBuffer") files.set(options.uri, (options.append ? files.get(options.uri) || "" : "") + Buffer.from(options.buffer).toString("latin1"))
        if (method === "move") { files.set(options.dstUri, files.get(options.srcUri)); files.delete(options.srcUri) }
        if (method === "delete") files.delete(options.uri)
        options.success({})
        // 固件重复成功回调不能让事务执行两次。
        options.success({})
      })
    }
  }
  const store = context.module.exports.createBackgroundStore({file,
    decode: (value) => Uint8Array.from(Buffer.from(value, "base64")).buffer, now: () => 100,
    setTimer: (fn) => { timeout = fn; return 1 }, clearTimer: () => { timeout = null }})
  return {files, tasks, calls, store, file, fail: (method) => { failure = method },
    expire: () => { if (timeout) timeout() }, next: () => tasks.shift()(), flush: () => { while (tasks.length) tasks.shift()() }}
}

test("分片超时/迟到写入、同片冲突和缺片finish均保留旧背景并释放单飞", () => {
  for (const mode of ["idle", "writing", "conflict", "missing"]) {
    const h = harness()
    const identity = {sessionId:"s",requestId:"r",deviceId:"d"}
    const bytes = Buffer.from(jpeg,"base64")
    let hash = 2166136261; for(const b of bytes) hash = Math.imul(hash ^ b,16777619) >>> 0
    let failure
    const done = (error) => { if(error) failure=error }
    h.store.receive({...identity,type:"beginBG",bytes:bytes.length,checksum:hash},done);h.flush()
    const chunk = {...identity,type:"backgroundChunk",offset:0,data:jpeg}
    if(mode==="writing") {h.store.receive(chunk,done);h.expire();h.flush()}
    if(mode==="idle") {h.expire();h.flush()}
    if(mode==="missing") {h.store.receive({...identity,type:"finishBG"},done);h.flush()}
    if(mode==="conflict") {
      h.store.receive(chunk,done);h.flush()
      h.store.receive({...chunk,data:"AAAA"},done);h.flush()
    }
    assert.ok(failure,mode)
    assert.equal(h.files.get(old),"old")
    h.store.reset((error)=>assert.equal(error,null));h.flush()
  }
})

test("G-02：解码、扫描、部分写入和引用提交失败均保留旧图，重启不选中临时图", () => {
  for (const failure of ["decode", "list", "writeArrayBuffer", "move"]) {
    const h = harness()
    h.fail(failure)
    let result
    h.store.save(failure === "decode" ? "!bad" : jpeg, (error) => { result = error })
    h.flush()
    assert.ok(result, failure)
    assert.equal(h.files.get(old), "old")
    assert.equal(h.calls.some(([method, uri]) => method === "delete" && uri === old), false)
    h.fail("")
    let loaded
    h.store.load((error, uri) => { assert.equal(error, null); loaded = uri })
    h.flush()
    assert.equal(loaded, old)
  }
})

test("背景小分片：逐片ACK/重复不追加、校验失败留旧图、完整后提交", () => {
  for (const corrupt of [false,true]) {
    const h = harness()
    const bytes = Buffer.alloc(6000, 1)
    Buffer.from(jpeg,"base64").copy(bytes)
    let hash = 2166136261
    for (const byte of bytes) hash = Math.imul(hash ^ byte,16777619) >>> 0
    const identity = {sessionId:"s",requestId:"r",deviceId:"d"}
    h.store.receive({...identity,type:"beginBG",bytes:bytes.length,checksum:corrupt ? hash ^ 1 : hash}, (error) => assert.equal(error,null))
    h.flush()
    for (let offset=0;offset<bytes.length;offset+=3072) {
      const frame={...identity,type:"backgroundChunk",offset,data:bytes.subarray(offset,offset+3072).toString("base64")}
      const receive=()=>h.store.receive(frame,(error,result)=>{assert.equal(error,null);assert.equal(result.next,Math.min(offset+3072,bytes.length))})
      receive(); h.flush(); receive(); h.flush()
    }
    h.store.receive({...identity,type:"finishBG"},(error,result)=>{
      if(corrupt) assert.ok(error)
      else {assert.equal(error,null);assert.equal(result.complete,true);assert.deepEqual(Buffer.from(h.files.get(result.uri),"latin1"),bytes)}
    })
    h.flush()
    if(corrupt) assert.equal(h.files.get(old),"old")
  }
})

test("G-02：正式提交后才删除旧图，时钟相同/回退仍生成唯一且更新的文件名", () => {
  const h = harness()
  h.files.set("internal://files/background.json", JSON.stringify({version: 1, uri: old}))
  h.store.load(() => {})
  h.flush()
  let committed
  let callbacks = 0
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri; callbacks++ })
  h.next() // write
  assert.equal(h.files.get(old), "old")
  assert.equal(Array.from(h.files.keys()).some((uri) => /pending/.test(uri)), true)
  h.next() // move
  assert.equal(h.files.get(old), "old")
  assert.equal(h.files.has("internal://files/bg_101.jpg"), true)
  h.flush()
  assert.equal(h.files.has(old), false)
  assert.equal(callbacks, 1)
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri })
  h.flush()
  assert.equal(committed, "internal://files/bg_102.jpg")
  assert.equal(h.files.has(committed), true)
})

test("G-02：清理旧图失败仍保留新提交，加载忽略临时文件", () => {
  const h = harness()
  h.fail("delete:" + old)
  let committed
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri })
  h.flush()
  h.files.set("internal://files/bg_pending_999.tmp", "partial")
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, committed) })
  h.flush()
  assert.equal(h.files.get(old), "old")
})

test("G-02/G-03：在途上传被拒绝且不排队，提交后缓存加载新引用", () => {
  const h = harness()
  let committed
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri })
  h.store.save("b3RoZXI=", (error) => { assert.equal(error.code, "BACKGROUND_BUSY") })
  h.next() // index read
  let loaded
  h.store.load((error, uri) => { assert.equal(error, null); loaded = uri })
  h.flush()
  assert.equal(loaded, old)
  h.store.load((error, uri) => { assert.equal(error, null); loaded = uri })
  assert.equal(loaded, committed)
  assert.equal(h.files.has(committed), true)
})

test("G-01/G-06：真实PNG/JPEG后缀、旧文件兼容、头部尺寸及字节预算", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=", "base64")
  const h = harness()
  h.store.save(png.toString("base64"), (error, uri) => {
    assert.equal(error, null)
    assert.equal(uri, "internal://files/bg_101.png")
  })
  h.flush()
  for (const data of [Buffer.from("not an image"), Buffer.from([255, 216, 255, 192, 0, 255]),
    Buffer.alloc(100 * 1024 + 1)]) {
    h.store.save(data.toString("base64"), (error) => assert.ok(error))
    h.flush()
  }
  const huge = Buffer.from(png)
  huge.writeUInt32BE(513, 16)
  h.store.save(huge.toString("base64"), (error) => assert.ok(error))
  h.flush()
  const hugeJpeg = Buffer.from(jpeg, "base64")
  hugeJpeg.writeUInt16BE(513, 7)
  h.store.save(hugeJpeg.toString("base64"), (error) => assert.ok(error))
  h.flush()
  assert.equal(h.files.has("internal://files/bg_101.png"), true)
  assert.equal(h.calls.filter(([method]) => method === "writeArrayBuffer").length, 1)
})

test("G-06：超限Base64在分配前拒绝，不调用解码器", () => {
  let decoded = false
  const store = context.module.exports.createBackgroundStore({file: {}, decode: () => { decoded = true }})
  store.save("A".repeat(140000), (error) => assert.ok(error))
  assert.equal(decoded, false)
})

test("G-03/G-04：旧图迁移索引、缓存免扫描、恢复默认重启不复活旧图", () => {
  const h = harness()
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, old) })
  h.flush()
  const scans = h.calls.filter(([method]) => method === "list").length
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, old) })
  assert.equal(h.calls.filter(([method]) => method === "list").length, scans)
  h.files.set("internal://files/events.json", "keep")
  h.files.set("internal://files/bg_pending_88.tmp", "partial")
  h.files.set("internal://files/bg_unknown.png", "keep")
  h.fail("delete:" + old)
  h.store.reset((error) => assert.equal(error, null))
  h.flush()
  assert.equal(JSON.parse(h.files.get("internal://files/background.json")).uri, "")
  assert.equal(h.files.has("internal://files/bg_pending_88.tmp"), false)
  assert.equal(h.files.get("internal://files/bg_unknown.png"), "keep")
  assert.equal(h.files.get("internal://files/events.json"), "keep")
  assert.equal(h.files.get(old), "old")
  const restarted = context.module.exports.createBackgroundStore({file: h.file, decode: () => {}})
  restarted.load((error, uri) => { assert.equal(error, null); assert.equal(uri, "") })
  h.flush()
})

test("G-03：索引提交失败回滚旧引用，备份可恢复，损坏/I-O失败不清理图片", () => {
  for (const failure of ["writeText", "move:internal://files/background.json"]) {
    const h = harness()
    h.store.load(() => {})
    h.flush()
    h.fail(failure)
    h.store.save(jpeg, (error) => assert.ok(error))
    h.flush()
    assert.equal(h.files.get(old), "old")
    h.fail("")
    const restarted = context.module.exports.createBackgroundStore({file: h.file, decode: () => {}})
    restarted.load((error, uri) => { assert.equal(error, null); assert.equal(uri, old) })
    h.flush()
  }
  const h = harness()
  h.files.set("internal://files/background.json", "broken")
  h.store.reset((error) => assert.ok(error))
  h.flush()
  assert.equal(h.files.get(old), "old")
  assert.equal(h.calls.some(([method]) => method === "delete"), false)
  h.files.set("internal://files/background.json.bak", JSON.stringify({version: 1, uri: old}))
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, old) })
  h.flush()
  assert.equal(JSON.parse(h.files.get("internal://files/background.json")).uri, old)
  const io = harness()
  io.fail("readText")
  io.store.reset((error) => assert.ok(error))
  io.flush()
  assert.equal(io.calls.some(([method]) => method === "delete" || method === "writeText"), false)
})

test("G-04：恢复默认索引写失败保留背景，在途上传阻止恢复操作", () => {
  const h = harness()
  h.store.load(() => {})
  h.flush()
  h.fail("writeText")
  h.store.reset((error) => assert.ok(error))
  h.flush()
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, old) })
  h.fail("")
  h.store.save(jpeg, (error) => assert.equal(error, null))
  h.store.reset((error) => assert.equal(error.code, "BACKGROUND_BUSY"))
  h.flush()
})
