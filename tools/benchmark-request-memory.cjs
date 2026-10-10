// --expose-gc；同步阶段采样JS堆，不是Vela峰值或原生内存。
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const {execFileSync} = require("node:child_process")
const root = path.resolve(__dirname, "..")
function source(file, baseline) {
  return baseline ? execFileSync("git", ["show", "HEAD:" + file], {cwd: root, encoding: "utf8"}) : fs.readFileSync(path.join(root, file), "utf8")
}
function extract(text, start, end, name) {
  return new Function(text.slice(text.indexOf(start), text.indexOf(end)) + "\nreturn " + name)()
}
const oldCanonical = extract(source("src/pages/index/index.ux", true), "function canonicalProtocolValue", "const BASE_FONT_SIZES", "canonicalProtocolValue")
const canonical = extract(source("src/pages/index/index.ux", false), "function canonicalProtocolValue", "const BASE_FONT_SIZES", "canonicalProtocolValue")
const oldChecksum = extract(source("src/components/eventStore.js", true), "  function backupChecksum", "  function restoreBackup", "backupChecksum")
const checksum = extract(source("src/components/eventStore.js", false), "  function backupChecksum", "  function restoreBackup", "backupChecksum")
function measure(fn) {
  if (global.gc) global.gc()
  const before = process.memoryUsage().heapUsed
  const value = fn()
  const allocated = process.memoryUsage().heapUsed - before
  if (global.gc) global.gc()
  return {value, sampledKiB: (allocated / 1024).toFixed(1), retainedKiB: ((process.memoryUsage().heapUsed - before) / 1024).toFixed(1)}
}
const events = Array.from({length: 200}, (_, i) => ({id: "e" + i, name: "长名称😀".repeat(8), date: "2026-10-18",
  on_index: true, IFStaringDay: false, themeColor: "", extra: "扩展数据".repeat(80)}))
const data = {version: 2, primaryId: "e0", sortMode: "near", events}
const backup = {format: "daymatter-backup", backupVersion: 1, checksum: checksum(data), data}
const request = {type: "restoreBackup", requestId: "memory", sessionId: "s", deviceId: "d", mode: "replace", conflict: "keep", expectedRevision: 0, backup}
const text = JSON.stringify(request)
assert.ok(text.length < 250 * 1024)
assert.ok(Buffer.byteLength(text) <= 256 * 1024)
for (const [label, beforeFn, afterFn] of [
  ["完整指纹", () => oldCanonical(request), () => canonical(request, 250 * 1024)],
  ["备份校验", () => oldChecksum(data), () => checksum(data)]
]) {
  const old = measure(beforeFn), current = measure(afterFn)
  assert.equal(current.value, old.value)
  console.log(`${label}: 阶段末GC前堆增量 ${old.sampledKiB} → ${current.sampledKiB} KiB；GC后差值 ${old.retainedKiB} → ${current.retainedKiB} KiB`)
}
assert.equal(canonical(request, 16384), null)
const ledger = measure(() => {
  const records = []
  let chars = 0
  for (let i = 0; i < 32; i++) {
    const fingerprint = canonical({...request, requestId: String(i)}, 250 * 1024)
    if (chars + fingerprint.length > 512 * 1024) break
    chars += fingerprint.length
    records.push({fingerprint, response: {ok: true}})
  }
  return {records, chars}
})
console.log(`账本: ${ledger.value.records.length}条大请求，${ledger.value.chars} UTF-16代码单元，GC后保留差值 ${ledger.retainedKiB} KiB；完整指纹仍保留以检测冲突`)
console.log(`请求JSON ${text.length} UTF-16代码单元 / ${Buffer.byteLength(text)} UTF-8字节；阶段采样不是实际峰值，${global.gc ? "已启用GC" : "未启用GC"}`)
