// 日期工具：显式解析与日历日算法，统一 YYYY-MM-DD。
// 不使用 new Date(字符串)，避免不同引擎的解析差异、UTC / 本地混用与夏令时偏差；
// 所有差值与排序均基于「日序号」整数运算，日期有效性按真实日历校验。

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/

// 解析失败时的展示兜底：按今天处理，避免 NaN 或误判方向
const TODAY_STATUS = Object.freeze({
  state: "today",
  days: 0,
  totalDays: 0,
  ymd: Object.freeze({years: 0, months: 0, days: 0}),
  isToday: true
})

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) return 29
  return MONTH_DAYS[month - 1]
}

// 接受 YYYY-M-D / YYYY-MM-DD，严格校验真实日历日期；非法返回 null
function parseDate(value) {
  if (typeof value !== "string") return null
  const match = value.trim().match(DATE_PATTERN)
  if (!match) return null
  const year = Number(match[1])
  if (year < 1 || year > 9999) return null
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return {year, month, day}
}

function formatDate(year, month, day) {
  return ("0000" + year).slice(-4) + "-" + pad2(month) + "-" + pad2(day)
}

// 统一存储 / 展示格式：2026-1-5 -> 2026-01-05；非法返回 null
function normalizeDate(value) {
  const parts = parseDate(value)
  return parts ? formatDate(parts.year, parts.month, parts.day) : null
}

function todayParts(now) {
  const date = now || new Date()
  return {year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate()}
}

// 公历日序号（1970-01-01 为 0），纯整数运算，不受时区 / 夏令时影响
function toDayNumber(year, month, day) {
  let y = year
  if (month <= 2) y -= 1
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month + (month > 2 ? -3 : 9)
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function fromDayNumber(dayNumber) {
  const z = dayNumber + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp + (mp < 10 ? 3 : -9)
  return {year: y + (month <= 2 ? 1 : 0), month: month, day: day}
}

function compareParts(a, b) {
  if (a.year !== b.year) return a.year - b.year
  if (a.month !== b.month) return a.month - b.month
  return a.day - b.day
}

// 月末锚点：加月份时按目标月实际天数收窄（1-31 + 1 月 = 2-28/29），闰日同理
function addMonthsClamped(parts, delta) {
  const total = parts.year * 12 + (parts.month - 1) + delta
  const year = Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12 + 1
  const day = Math.min(parts.day, daysInMonth(year, month))
  return {year: year, month: month, day: day}
}

// start <= end 时的完整年月日差：先取最大整月数并锚定，再按日序号算余天，余天恒非负
function diffYmd(start, end) {
  let months = (end.year - start.year) * 12 + (end.month - start.month)
  let anchor = addMonthsClamped(start, months)
  if (compareParts(anchor, end) > 0) {
    months -= 1
    anchor = addMonthsClamped(start, months)
  }
  const days =
    toDayNumber(end.year, end.month, end.day) - toDayNumber(anchor.year, anchor.month, anchor.day)
  return {years: Math.floor(months / 12), months: months % 12, days: days}
}

// 计入起始日：过去 / 今天按目标日前一天起算，未取来方向不改变语义
function resolveIncludeStart(includeStartDay) {
  return includeStartDay === true || includeStartDay === "true"
}

// 统一事件状态：state = past / today / future；days 为展示天数；ymd 为年月日分量
function getEventStatus(dateValue, includeStartDay, now) {
  const target = parseDate(dateValue)
  if (!target) return null
  const today = todayParts(now)
  const include = resolveIncludeStart(includeStartDay)
  const targetNumber = toDayNumber(target.year, target.month, target.day)
  const todayNumber = toDayNumber(today.year, today.month, today.day)
  const diff = todayNumber - targetNumber

  if (diff > 0) {
    const start = include ? fromDayNumber(targetNumber - 1) : target
    return {
      state: "past",
      days: include ? diff + 1 : diff,
      totalDays: diff,
      ymd: diffYmd(start, today),
      isToday: false
    }
  }

  if (diff === 0) {
    if (include) {
      const start = fromDayNumber(targetNumber - 1)
      return {state: "past", days: 1, totalDays: 0, ymd: diffYmd(start, today), isToday: false}
    }
    return {state: "today", days: 0, totalDays: 0, ymd: {years: 0, months: 0, days: 0}, isToday: true}
  }

  return {
    state: "future",
    days: -diff,
    totalDays: diff,
    ymd: diffYmd(today, target),
    isToday: false
  }
}

function getOccurrence(event, now) {
  const original = parseDate(event.date)
  if (!original) return null
  if (event.repeat !== "yearly") return {date: normalizeDate(event.date), anniversary: null}
  const today = todayParts(now)
  let year = Math.max(original.year, today.year)
  let target = {year: year, month: original.month, day: Math.min(original.day, daysInMonth(year, original.month))}
  if (compareParts(target, today) < 0) {
    year++
    if (year > 9999) return null
    target = {year: year, month: original.month, day: Math.min(original.day, daysInMonth(year, original.month))}
  }
  return {date: formatDate(target.year, target.month, target.day), anniversary: year - original.year}
}

function getRecurringStatus(event, now) {
  const occurrence = getOccurrence(event, now)
  if (!occurrence) {
    const status = getEventStatus(event.date, event.IFStaringDay, now)
    return status ? Object.assign(status, {occurrenceDate: null, anniversary: null}) : null
  }
  return Object.assign(getEventStatus(occurrence.date, event.IFStaringDay, now),
    {occurrenceDate: occurrence.date, anniversary: occurrence.anniversary})
}

export default {
  getOccurrence: getOccurrence,
  getRecurringStatus: getRecurringStatus,
  TODAY_STATUS: TODAY_STATUS,
  daysInMonth: daysInMonth,
  formatDate: formatDate,
  normalizeDate: normalizeDate,
  parseDate: parseDate,
  todayParts: todayParts,
  toDayNumber: toDayNumber,
  fromDayNumber: fromDayNumber,
  diffYmd: diffYmd,
  getEventStatus: getEventStatus
}
