const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const {test} = require("node:test")
const source = fs.readFileSync(path.join(__dirname, "../src/components/backgroundStore.js"), "utf8")
const context = vm.createContext({module: {exports: {}}})
vm.runInContext(source.replace("export default", "module.exports ="), context)
const old = "internal://files/bg_100.png"
// JPEG SOF尺寸头：存储层只验证格式/尺寸，完整解码由插件负责。
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]).toString("base64")

function harness() {
  const files = new Map([[old, "old"]])
  const tasks = []
  const calls = []
  let failure = ""
  const file = {}
  for (const method of ["list", "writeArrayBuffer", "move", "delete"]) {
    file[method] = (options) => {
      calls.push([method, options.uri || options.srcUri])
      const snapshot = Array.from(files.keys()).map((uri) => ({uri}))
      tasks.push(() => {
        if (failure === method) {
          if (method === "writeArrayBuffer") files.set(options.uri, "partial")
          options.fail("io error", 300)
          return
        }
        if (method === "list") { options.success({fileList: snapshot}); return }
        if (method === "writeArrayBuffer") files.set(options.uri, Buffer.from(options.buffer).toString())
        if (method === "move") { files.set(options.dstUri, files.get(options.srcUri)); files.delete(options.srcUri) }
        if (method === "delete") files.delete(options.uri)
        options.success({})
        // 固件重复成功回调不能让事务执行两次。
        options.success({})
      })
    }
  }
  const store = context.module.exports.createBackgroundStore({file,
    decode: (value) => Uint8Array.from(Buffer.from(value, "base64")).buffer, now: () => 100})
  return {files, tasks, calls, store, fail: (method) => { failure = method },
    next: () => tasks.shift()(), flush: () => { while (tasks.length) tasks.shift()() }}
}

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

test("G-02：正式提交后才删除旧图，时钟相同/回退仍生成唯一且更新的文件名", () => {
  const h = harness()
  let committed
  let callbacks = 0
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri; callbacks++ })
  h.next() // list
  assert.equal(h.files.get(old), "old")
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
  h.fail("delete")
  let committed
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri })
  h.flush()
  h.files.set("internal://files/bg_pending_999.tmp", "partial")
  h.store.load((error, uri) => { assert.equal(error, null); assert.equal(uri, committed) })
  h.flush()
  assert.equal(h.files.get(old), "old")
})

test("G-02：在途上传被拒绝且不排队，迟到扫描不覆盖新提交", () => {
  const h = harness()
  let committed
  h.store.save(jpeg, (error, uri) => { assert.equal(error, null); committed = uri })
  h.store.save("b3RoZXI=", (error) => { assert.equal(error.code, "BACKGROUND_BUSY") })
  h.next() // save list
  let loaded
  h.store.load((error, uri) => { assert.equal(error, null); loaded = uri })
  const stale = h.tasks.pop()
  h.flush()
  stale()
  h.flush()
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
  huge.writeUInt32BE(451, 16)
  h.store.save(huge.toString("base64"), (error) => assert.ok(error))
  h.flush()
  const hugeJpeg = Buffer.from(jpeg, "base64")
  hugeJpeg.writeUInt16BE(451, 7)
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
