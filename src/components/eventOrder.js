// 展示排序不改变存储数组；同值按原始位置稳定排列，定位始终使用 ID。
const MODES = ["created", "near", "manual"]
const CATEGORIES = ["uncategorized", "birthday", "study", "life", "anniversary"]

function select(events, mode, dateUtils, options) {
  const filter = options || {}
  return events.map((event, index) => ({event, index}))
    .filter(({event}) => (filter.archived === undefined || !!event.archived === filter.archived) &&
      (!filter.home || event.on_index) && (!filter.category || filter.category === "all" || event.category === filter.category) &&
      (!filter.period || filter.period === "all" || (() => {
        if (event.archived) return false
        const status = dateUtils.getRecurringStatus(event)
        return !!status && (filter.period === "today" ? status.totalDays === 0 : status.totalDays <= 0 && status.totalDays >= -30)
      })()))
    .sort((a, b) => {
      const pin = Number(!!b.event.pinned) - Number(!!a.event.pinned)
      if (pin) return pin
      if (mode === "manual") return (a.event.sortOrder || 0) - (b.event.sortOrder || 0) || a.index - b.index
      if (mode === "near") {
        const sa = dateUtils.getRecurringStatus(a.event)
        const sb = dateUtils.getRecurringStatus(b.event)
        if (!sa || !sb) return Number(!sa) - Number(!sb) || a.index - b.index
        const pa = sa.totalDays > 0, pb = sb.totalDays > 0
        if (pa !== pb) return pa ? 1 : -1
        return (pa ? sa.totalDays - sb.totalDays : sb.totalDays - sa.totalDays) || a.index - b.index
      }
      return a.index - b.index
    }).map(({event}) => event)
}

export default {MODES, CATEGORIES, select}
