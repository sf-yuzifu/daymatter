// 同步内存文件微基准：只测读取次数与JS解析/校验，不模拟设备I/O或渲染。
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const {execFileSync} = require("node:child_process")
const {performance} = require("node:perf_hooks")
const root = path.resolve(__dirname, "..")
function load(source) {
  const module = {exports: {}}
  new Function("module", source.replace("export default", "module.exports ="))(module)
  return module.exports
}
const dates = load(fs.readFileSync(path.join(root, "src/components/dateUtils.js"), "utf8"))
const before = load(execFileSync("git", ["show", "HEAD:src/components/eventStore.js"], {cwd: root, encoding: "utf8"}))
const after = load(fs.readFileSync(path.join(root, "src/components/eventStore.js"), "utf8"))
for (const count of [10, 30, 100, 200]) {
  const text = JSON.stringify({version: 2, revision: 1, primaryId: "", sortMode: "near", events:
    Array.from({length: count}, (_, i) => ({id: "e" + i, name: "事件" + i, date: "2026-10-18", on_index: true}))})
  function measure(module) {
    let reads = 0
    const files = new Map([["internal://files/events.json", text]])
    const file = {
      readText: ({uri, success, fail}) => { reads++; files.has(uri) ? success({text: files.get(uri)}) : fail("not found", 301) },
      writeText: ({uri, text, success}) => { files.set(uri, text); success() },
      move: ({srcUri, dstUri, success}) => { files.set(dstUri, files.get(srcUri)); files.delete(srcUri); success() },
      delete: ({uri, success}) => { files.delete(uri); success() }
    }
    const store = module.createEventStore({file, dateUtils: dates, watchFace: {sync: (state, name, done) => done(null, {skipped: true})}})
    const run = () => store.read((error, result) => { assert.equal(error, null); assert.equal(result.events.length, count) })
    run()
    reads = 0
    run()
    const readsPerRefresh = reads
    for (let i = 0; i < 20; i++) run()
    const samples = []
    for (let i = 0; i < 7; i++) {
      const start = performance.now()
      for (let j = 0; j < 100; j++) run()
      samples.push((performance.now() - start) / 100)
    }
    return {reads: readsPerRefresh, ms: samples.sort((a, b) => a - b)[3].toFixed(3)}
  }
  const old = measure(before), current = measure(after)
  assert.equal(current.reads, 1)
  console.log(`${count}条: 事件文件读取 ${old.reads} → ${current.reads}; JS读取+校验+维护 ${old.ms} → ${current.ms} ms（无设备I/O/渲染）`)
}
