// Node 微基准：比较当前实现与工作区 HEAD 的排序实现，不代表真机耗时。
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const {execFileSync} = require("node:child_process")
const {performance} = require("node:perf_hooks")
const root = path.resolve(__dirname, "..")
function load(source) {
  const module = {exports: {}}
  new Function("module", source.replace("export default", "module.exports ="))(module)
  return module.exports
}
const dates = load(fs.readFileSync(path.join(root, "src/components/dateUtils.js"), "utf8"))
const current = load(fs.readFileSync(path.join(root, "src/components/eventOrder.js"), "utf8"))
const baseline = load(execFileSync("git", ["show", "HEAD:src/components/eventOrder.js"], {cwd: root, encoding: "utf8"}))
const now = new Date(2026, 1, 28, 12)
const lunarDate = {year: 2020, month: 4, day: 29, leap: true}
function run(order, events, period, optimized) {
  let calls = 0
  const counted = {todayParts: dates.todayParts, getRecurringStatus(e, date) { calls++; return dates.getRecurringStatus(e, date || now) }}
  const refresh = optimized ? order.createRefresh(counted, now) : null
  const result = order.select(events, "near", counted, {archived: false, period, refresh})
  // 模拟首页全量展示格式化；列表最多格式化10条只会使旧实现略少调用。
  const statuses = result.map(e => refresh ? refresh.getStatus(e) : counted.getRecurringStatus(e))
  return {ids: result.map(e => e.id), statuses, calls}
}
function medianTime(fn) {
  for (let i = 0; i < 20; i++) fn()
  const samples = []
  for (let i = 0; i < 7; i++) {
    const start = performance.now()
    for (let j = 0; j < 100; j++) fn()
    samples.push((performance.now() - start) / 100)
  }
  return samples.sort((a, b) => a - b)[3].toFixed(3)
}
for (const size of [10, 30, 100, 200]) {
  const events = Array.from({length: size}, (_, i) => i % 4 === 0 ? {
    id: String(i), calendar: "lunar", lunarDate, date: dates.lunarToSolar(lunarDate), repeat: "yearly",
    lunarTableVersion: dates.LUNAR_VERSION, lunarLeapPolicy: "regularFallback", lunarShortMonthPolicy: "lastDay"
  } : {id: String(i), date: dates.formatDate(2026, 1 + i % 5, 1 + (i * 17) % 28),
    repeat: i % 3 === 0 ? "yearly" : "none", pinned: i % 11 === 0, IFStaringDay: i % 7 === 0})
  for (const period of ["all", "upcoming"]) {
    const before = run(baseline, events, period, false)
    const after = run(current, events, period, true)
    assert.deepEqual(after.ids, before.ids)
    assert.deepEqual(after.statuses, before.statuses)
    assert.ok(after.calls <= size)
    console.log(`${size}条/${period}: 调用 ${before.calls} → ${after.calls}; 中位均耗时 ${medianTime(() => run(baseline, events, period, false))} → ${medianTime(() => run(current, events, period, true))} ms`)
  }
}
