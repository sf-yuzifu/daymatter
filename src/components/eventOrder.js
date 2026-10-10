// 展示排序不改变存储数组；同值按原始位置稳定排列，定位始终使用 ID。
const MODES = ["created", "near", "manual"]
const CATEGORIES = ["uncategorized", "birthday", "study", "life", "anniversary"]

// 仅在一次刷新内按事件对象复用；null 结果也缓存，不依赖名称或 ID 唯一性。
function createRefresh(dateUtils, now) {
  const today = dateUtils.todayParts(now)
  const date = new Date(today.year, today.month - 1, today.day, 12)
  const statuses = new Map()
  return {
    getStatus(event) {
      if (!statuses.has(event)) statuses.set(event, dateUtils.getRecurringStatus(event, date))
      return statuses.get(event)
    }
  }
}

function select(events, mode, dateUtils, options) {
  const filter = options || {}
  const refresh = filter.refresh || createRefresh(dateUtils)
  return events.map((event, index) => ({event, index}))
    .filter(({event}) => (filter.archived === undefined || !!event.archived === filter.archived) &&
      (!filter.home || event.on_index) && (!filter.category || filter.category === "all" || event.category === filter.category) &&
      (!filter.period || filter.period === "all" || (() => {
        if (event.archived) return false
        const status = refresh.getStatus(event)
        return !!status && (filter.period === "today" ? status.totalDays === 0 : status.totalDays <= 0 && status.totalDays >= -30)
      })()))
    .sort((a, b) => {
      const pin = Number(!!b.event.pinned) - Number(!!a.event.pinned)
      if (pin) return pin
      if (mode === "manual") return (a.event.sortOrder || 0) - (b.event.sortOrder || 0) || a.index - b.index
      if (mode === "near") {
        const sa = refresh.getStatus(a.event)
        const sb = refresh.getStatus(b.event)
        if (!sa || !sb) return Number(!sa) - Number(!sb) || a.index - b.index
        const pa = sa.totalDays > 0, pb = sb.totalDays > 0
        if (pa !== pb) return pa ? 1 : -1
        return (pa ? sa.totalDays - sb.totalDays : sb.totalDays - sa.totalDays) || a.index - b.index
      }
      return a.index - b.index
    }).map(({event}) => event)
}

export default {MODES, CATEGORIES, createRefresh, select}
