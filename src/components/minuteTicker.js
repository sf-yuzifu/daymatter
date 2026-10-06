// 前台分钟级时钟：仅在页面可见时运行，对齐到下一分钟边界触发，
// 隐藏 / 销毁时停止，重新显示按需恢复；跨午夜时向页面报告日期变化，
// 避免新增常驻高频计时器，也不在隐藏页面上继续计时。

const MINUTE_MS = 60000

function getDayKey() {
  const now = new Date()
  return now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate()
}

function createMinuteTicker(onTick) {
  let timerId = null
  let running = false
  let lastDayKey = ""

  function schedule() {
    // 对齐下一分钟边界，长时间前台也不会累计漂移
    timerId = setTimeout(onMinute, MINUTE_MS - (Date.now() % MINUTE_MS))
  }

  function onMinute() {
    timerId = null
    if (!running) return
    const dayKey = getDayKey()
    const dateChanged = dayKey !== lastDayKey
    lastDayKey = dayKey
    onTick(dateChanged)
    if (running) schedule()
  }

  return {
    start() {
      if (running) return
      running = true
      lastDayKey = getDayKey()
      schedule()
    },
    stop() {
      running = false
      if (timerId !== null) {
        clearTimeout(timerId)
        timerId = null
      }
    }
  }
}

export default {createMinuteTicker}
