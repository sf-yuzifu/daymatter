// runGC 低频守卫：仅在宿主持有 global.runGC 时调用，且两次调用间隔不低于阈值。
// 供页面销毁、释放大块数据后按需调用；不在按键 / 滚动 / 普通更新等高频路径使用。

const MIN_GC_INTERVAL = 5000

function createGcGuard() {
  let lastRunTime = 0
  return function tryRunGC() {
    if (typeof global.runGC !== "function") return false
    const now = Date.now()
    if (now - lastRunTime < MIN_GC_INTERVAL) return false
    lastRunTime = now
    global.runGC()
    return true
  }
}

export default {createGcGuard}
