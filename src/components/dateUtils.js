// 日期工具：显式解析与日历日算法，统一 YYYY-MM-DD。
// 不使用 new Date(字符串)，避免不同引擎的解析差异、UTC / 本地混用与夏令时偏差；
// 所有差值与排序均基于「日序号」整数运算，日期有效性按真实日历校验。

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/

// ISC year data: yize/solarlunar b1d4328; see common/lunar-LICENSE.txt.
// dm-hko-v1: 2057/2097 month lengths corrected to HKO reference dates.
const LUNAR_TABLE = [
  19416,19168,42352,21717,53856,55632,91476,22176,39632,21970,
  19168,42422,42192,53840,119381,46400,54944,44450,38320,84343,
  18800,42160,46261,27216,27968,109396,11104,38256,21234,18800,
  25958,54432,59984,28309,23248,11104,100067,37600,116951,51536,
  54432,120998,46416,22176,107956,9680,37584,53938,43344,46423,
  27808,46416,86869,19872,42416,83315,21168,43432,59728,27296,
  44710,43856,19296,43748,42352,21088,62051,55632,23383,22176,
  38608,19925,19152,42192,54484,53840,54616,46400,46752,103846,
  38320,18864,43380,42160,45690,27216,27968,44870,43872,38256,
  19189,18800,25776,29859,59984,27480,23232,43872,38613,37600,
  51552,55636,54432,55888,30034,22176,43959,9680,37584,51893,
  43344,46240,47780,44368,21977,19360,42416,86390,21168,43312,
  31060,27296,44368,23378,19296,42726,42208,53856,60005,54576,
  23200,30371,38608,19195,19152,42192,118966,53840,54560,56645,
  46496,22224,21938,18864,42359,42160,43600,111189,27936,44448,
  84835,37744,18936,18800,25776,92326,59984,27296,108228,43744,
  37600,53987,51552,54615,54432,55888,23893,22176,42704,21972,
  21200,43448,43344,46240,46758,44368,21920,43940,42416,21168,
  45683,26928,29495,27296,44368,84821,19296,42352,21732,53600,
  59752,54560,55968,92838,22224,19168,43476,41680,53584,62034,54560
]
const LUNAR_VERSION = "dm-hko-v1"
let lunarStarts = null

function lunarMonths(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return []
  const info = LUNAR_TABLE[year - 1900], leap = info & 15, result = []
  for (let month = 1; month <= 12; month++) {
    result.push({month, leap: false, days: 29 + Number(!!(info & (0x10000 >> month)))})
    if (month === leap) result.push({month, leap: true, days: 29 + Number(!!(info & 0x10000))})
  }
  return result
}
function getLunarStarts() {
  if (!lunarStarts) {
    lunarStarts = [toDayNumber(1900, 1, 31)]
    for (let year = 1900; year <= 2100; year++)
      lunarStarts.push(lunarStarts[lunarStarts.length - 1] + lunarMonths(year).reduce((n, m) => n + m.days, 0))
  }
  return lunarStarts
}
function lunarToSolar(value) {
  if (!value || typeof value.leap !== "boolean" || !Number.isInteger(value.day)) return null
  const months = lunarMonths(value.year)
  if (!months.length) return null
  let number = getLunarStarts()[value.year - 1900]
  for (const month of months) {
    if (month.month === value.month && month.leap === value.leap) {
      if (value.day < 1 || value.day > month.days) return null
      const date = fromDayNumber(number + value.day - 1)
      return formatDate(date.year, date.month, date.day)
    }
    number += month.days
  }
  return null
}
function solarToLunar(value) {
  const date = parseDate(value)
  if (!date) return null
  const number = toDayNumber(date.year, date.month, date.day), starts = getLunarStarts()
  if (number < starts[0] || number >= starts[201]) return null
  let index = 0
  while (number >= starts[index + 1]) index++
  let offset = number - starts[index]
  for (const month of lunarMonths(index + 1900)) {
    if (offset < month.days) return {year:index + 1900, month:month.month, day:offset + 1, leap:month.leap}
    offset -= month.days
  }
  return null
}
function validCalendar(event) {
  if (event.calendar !== undefined && !["solar", "lunar"].includes(event.calendar)) return false
  if (event.calendar !== "lunar") return event.lunarDate === undefined || event.lunarDate === null
  return event.lunarTableVersion === LUNAR_VERSION && event.lunarLeapPolicy === "regularFallback" &&
    event.lunarShortMonthPolicy === "lastDay" && lunarToSolar(event.lunarDate) === normalizeDate(event.date)
}

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
  if (event.calendar === "lunar") {
    if (!validCalendar(event)) return null
    if (event.repeat !== "yearly") return {date:normalizeDate(event.date), anniversary:null}
    const today = todayParts(now), todayString = formatDate(today.year, today.month, today.day)
    const todayLunar = solarToLunar(todayString)
    if (!todayLunar) return null
    const source = event.lunarDate
    for (let year = Math.max(source.year, todayLunar.year); year <= 2100; year++) {
      const months = lunarMonths(year)
      const month = months.find(m => m.month === source.month && m.leap === source.leap) || months.find(m => m.month === source.month && !m.leap)
      const date = lunarToSolar({year, month:source.month, day:Math.min(source.day, month.days), leap:month.leap})
      if (date >= todayString) return {date, anniversary:year - source.year}
    }
    return null
  }
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
    if (event.calendar === "lunar") return null
    const status = getEventStatus(event.date, event.IFStaringDay, now)
    return status ? Object.assign(status, {occurrenceDate: null, anniversary: null}) : null
  }
  return Object.assign(getEventStatus(occurrence.date, event.IFStaringDay, now),
    {occurrenceDate: occurrence.date, anniversary: occurrence.anniversary})
}

export default {
  LUNAR_VERSION, lunarMonths, lunarToSolar, solarToLunar, validCalendar,
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
