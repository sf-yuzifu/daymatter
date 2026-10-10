// 按需诊断：只保存有界标量记录，不持有页面/事件对象；默认不开启。
function start(label) {
  if (global.daymatterPerfEnabled !== true) return null
  const started = Date.now()
  return (detail) => {
    const record = Object.assign({phase: label, ms: Date.now() - started}, detail || {})
    if (!global.daymatterPerfRecords) global.daymatterPerfRecords = []
    const records = global.daymatterPerfRecords
    records.push(record)
    if (records.length > 64) records.shift()
    try { console.info("[daymatter:perf] " + JSON.stringify(record)) } catch (e) { /* 诊断不能阻断业务 */ }
  }
}

export default {start}
