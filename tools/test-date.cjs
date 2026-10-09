const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const {test} = require("node:test")

const root = path.resolve(__dirname, "..")
const dateSource = fs.readFileSync(path.join(root, "src/components/dateUtils.js"), "utf8")

// 在当前 realm 加载模块，保证 deepStrictEqual 的原型一致；纯函数无需 vm 隔离
function loadModule(source) {
  const module = {exports: {}}
  const script = source.replace(/^import .*$/gm, "").replace(/export default/, "module.exports =")
  new Function("module", script)(module)
  return module.exports
}

const dateUtils = loadModule(dateSource)

test("F-10 农历往返、闰月回退、小月月末与表上界", () => {
  let days = 0
  for (let year=1900;year<=2100;year++) for (const month of dateUtils.lunarMonths(year)) for (let day=1;day<=month.days;day++) {
    const value={year,month:month.month,day,leap:month.leap}
    assert.deepEqual(dateUtils.solarToLunar(dateUtils.lunarToSolar(value)),value)
    days++
  }
  assert.equal(days,73412)
  for (const [solar,lunar] of [["2020-05-23",{year:2020,month:4,day:1,leap:true}],
    ["2033-12-22",{year:2033,month:11,day:1,leap:true}],
    ["2057-09-28",{year:2057,month:9,day:1,leap:false}],
    ["2097-08-07",{year:2097,month:7,day:1,leap:false}]]) {
    assert.deepEqual(dateUtils.solarToLunar(solar),lunar)
    assert.equal(dateUtils.lunarToSolar(lunar),solar)
  }
  const lunarDate = {year:2020,month:4,day:30,leap:true}
  assert.equal(dateUtils.lunarToSolar(lunarDate),null,"不存在的原始闰月三十拒绝")
  lunarDate.day = 29
  const event = {calendar:"lunar",lunarDate,date:dateUtils.lunarToSolar(lunarDate),repeat:"yearly",
    lunarTableVersion:dateUtils.LUNAR_VERSION,lunarLeapPolicy:"regularFallback",lunarShortMonthPolicy:"lastDay"}
  const expected = dateUtils.lunarToSolar({year:2026,month:4,day:29,leap:false})
  assert.equal(dateUtils.getOccurrence(event,nowAt(2026,1,1)).date,expected)
  assert.equal(dateUtils.getOccurrence(event,nowAt(2102,1,1)),null)
  assert.equal(dateUtils.getRecurringStatus(event,nowAt(2102,1,1)),null)
})

test("F-01 年度发生日保留原日期，当日/跨年/闰日/未来起点", () => {
  const event = {date: "2020-02-29", repeat: "yearly"}
  assert.deepEqual(dateUtils.getOccurrence(event, nowAt(2026, 2, 28)), {date: "2026-02-28", anniversary: 6})
  assert.deepEqual(dateUtils.getOccurrence(event, nowAt(2026, 3, 1)), {date: "2027-02-28", anniversary: 7})
  assert.deepEqual(dateUtils.getOccurrence(event, nowAt(2028, 2, 28)), {date: "2028-02-29", anniversary: 8})
  assert.equal(dateUtils.getRecurringStatus(event, nowAt(2026, 2, 28)).state, "today")
  assert.equal(dateUtils.getRecurringStatus({...event, IFStaringDay: true}, nowAt(2026, 2, 28)).days, 1)
  assert.equal(event.date, "2020-02-29")
  assert.deepEqual(dateUtils.getOccurrence({date: "2030-01-01", repeat: "yearly"}, nowAt(2026, 12, 31)), {date: "2030-01-01", anniversary: 0})
  assert.equal(dateUtils.getOccurrence({date: "9999-01-01", repeat: "yearly"}, nowAt(9999, 12, 31)), null)
  assert.equal(dateUtils.normalizeDate("0001-1-1"), "0001-01-01")
  assert.equal(dateUtils.normalizeDate("0000-1-1"), null)
})

// 固定"今天"的辅助函数：显式传入 now，纯日期断言不依赖运行时的真实日期
function nowAt(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute)
}

test("D-01 日期格式归一：补零、去空白，非法输入返回 null", () => {
  assert.equal(dateUtils.normalizeDate("2026-1-5"), "2026-01-05")
  assert.equal(dateUtils.normalizeDate("2026-01-05"), "2026-01-05")
  assert.equal(dateUtils.normalizeDate(" 2026-1-5 "), "2026-01-05")
  assert.equal(dateUtils.normalizeDate("2026-12-31"), "2026-12-31")
  assert.equal(dateUtils.normalizeDate("999-1-1"), null)
  assert.equal(dateUtils.normalizeDate("2026-1-5T00:00:00"), null)
})

test("D-02 显式解析：拒绝不存在日期，不自动滚到下个月", () => {
  assert.ok(dateUtils.parseDate("2024-02-29"), "闰年 2 月 29 日有效")
  assert.equal(dateUtils.parseDate("2026-02-29"), null, "平年 2 月 29 日必须拒绝")
  assert.equal(dateUtils.parseDate("2026-2-30"), null, "2 月 30 日必须拒绝")
  assert.equal(dateUtils.parseDate("2026-4-31"), null, "4 月 31 日必须拒绝")
  assert.equal(dateUtils.parseDate("2026-00-10"), null, "月份 0 必须拒绝")
  assert.equal(dateUtils.parseDate("2026-13-01"), null, "月份 13 必须拒绝")
  assert.equal(dateUtils.parseDate("2026-01-00"), null, "日期 0 必须拒绝")
  assert.equal(dateUtils.parseDate("2026-01-32"), null, "日期 32 必须拒绝")
  assert.equal(dateUtils.parseDate("2026/01/05"), null, "分隔符必须为 -")
  assert.equal(dateUtils.parseDate(""), null)
  assert.equal(dateUtils.parseDate(null), null)
  assert.equal(dateUtils.parseDate(20260105), null)

  const parsed = dateUtils.parseDate("2026-13-05")
  assert.equal(parsed, null, "非法月份不得被滚动为下一年 1 月")
})

test("日历规则：闰年判定与每月天数", () => {
  assert.equal(dateUtils.daysInMonth(2024, 2), 29)
  assert.equal(dateUtils.daysInMonth(2023, 2), 28)
  assert.equal(dateUtils.daysInMonth(2000, 2), 29, "整百年能被 400 整除是闰年")
  assert.equal(dateUtils.daysInMonth(1900, 2), 28, "整百年不能被 400 整除不是闰年")
  assert.equal(dateUtils.daysInMonth(2026, 1), 31)
  assert.equal(dateUtils.daysInMonth(2026, 4), 30)
  assert.equal(dateUtils.daysInMonth(2026, 12), 31)

  // 日序号以 1970-01-01 为 0，往返一致
  assert.equal(dateUtils.toDayNumber(1970, 1, 1), 0)
  for (const [y, m, d] of [
    [2026, 1, 31],
    [2024, 2, 29],
    [1999, 12, 31],
    [2100, 3, 1],
    [2000, 2, 29]
  ]) {
    const roundTrip = dateUtils.fromDayNumber(dateUtils.toDayNumber(y, m, d))
    assert.deepEqual([roundTrip.year, roundTrip.month, roundTrip.day], [y, m, d])
  }
})

test("D-03 日历日差值：今天 / 过去 / 未来与计入起始日", () => {
  const now = nowAt(2026, 10, 6)

  const today = dateUtils.getEventStatus("2026-10-06", false, now)
  assert.equal(today.state, "today")
  assert.equal(today.isToday, true)
  assert.equal(today.days, 0)

  const todayInclude = dateUtils.getEventStatus("2026-10-06", true, now)
  assert.equal(todayInclude.state, "past")
  assert.equal(todayInclude.days, 1)
  assert.deepEqual(todayInclude.ymd, {years: 0, months: 0, days: 1})

  const yesterday = dateUtils.getEventStatus("2026-10-05", false, now)
  assert.equal(yesterday.state, "past")
  assert.equal(yesterday.days, 1)
  assert.deepEqual(dateUtils.getEventStatus("2026-10-05", true, now).ymd, {years: 0, months: 0, days: 2})

  const tomorrow = dateUtils.getEventStatus("2026-10-07", false, now)
  assert.equal(tomorrow.state, "future")
  assert.equal(tomorrow.days, 1)
  // 未到来方向不计入起始日，保持与现有交互一致
  assert.equal(dateUtils.getEventStatus("2026-10-07", true, now).days, 1)

  // 字符串布尔值兼容旧数据
  assert.equal(dateUtils.getEventStatus("2026-10-05", "true", now).days, 2)
  assert.equal(dateUtils.getEventStatus("2026-10-05", "false", now).days, 1)

  // 时间分量不影响日历日差值（同一天 00:00 与 23:59 结果一致）
  assert.equal(dateUtils.getEventStatus("2026-10-07", false, nowAt(2026, 10, 6, 23, 59)).days, 1)
  assert.equal(dateUtils.getEventStatus("2026-10-06", false, nowAt(2026, 10, 7, 0, 1)).days, 1)
})

test("D-04 年月日算法：月末锚点、闰日与负数天数修复", () => {
  // 已知错误用例：2026-01-31 -> 2026-03-01 曾得到「1 个月 -2 天」
  const bug = dateUtils.getEventStatus("2026-01-31", false, nowAt(2026, 3, 1))
  assert.equal(bug.state, "past")
  assert.deepEqual(bug.ymd, {years: 0, months: 1, days: 1}, "月末锚定后应为 1 个月 1 天")
  assert.equal(bug.totalDays, 29)

  // 计入起始日从目标日前一天起算，年月日分量保持非负一致
  const bugInclude = dateUtils.getEventStatus("2026-01-31", true, nowAt(2026, 3, 1))
  assert.equal(bugInclude.days, 30)
  assert.deepEqual(bugInclude.ymd, {years: 0, months: 1, days: 1})

  // 31 日到短月：锚定到月末，余天为 0
  const toShortMonth = dateUtils.getEventStatus("2026-01-31", false, nowAt(2026, 2, 28))
  assert.deepEqual(toShortMonth.ymd, {years: 0, months: 1, days: 0})
  assert.equal(toShortMonth.totalDays, 28)

  const jan30 = dateUtils.getEventStatus("2026-01-30", false, nowAt(2026, 3, 1))
  assert.deepEqual(jan30.ymd, {years: 0, months: 1, days: 1})

  // 闰日跨非闰年：2024-02-29 -> 2025-02-28 为整一年
  const leapDay = dateUtils.getEventStatus("2024-02-29", false, nowAt(2025, 2, 28))
  assert.deepEqual(leapDay.ymd, {years: 1, months: 0, days: 0})
  assert.equal(leapDay.totalDays, 365)

  const leapDay2020 = dateUtils.getEventStatus("2020-02-29", false, nowAt(2021, 2, 28))
  assert.deepEqual(leapDay2020.ymd, {years: 1, months: 0, days: 0})

  // 未来方向的年月日分量
  const future = dateUtils.getEventStatus("2026-11-06", false, nowAt(2026, 10, 6))
  assert.equal(future.state, "future")
  assert.equal(future.days, 31)
  assert.deepEqual(future.ymd, {years: 0, months: 1, days: 0})

  const futureYear = dateUtils.getEventStatus("2027-10-06", false, nowAt(2026, 10, 6))
  assert.deepEqual(futureYear.ymd, {years: 1, months: 0, days: 0})
})

test("D-06 边界：跨月 / 跨年 / 月末到月初 / 夏令时切换日", () => {
  assert.equal(dateUtils.getEventStatus("2026-01-31", false, nowAt(2026, 2, 1)).totalDays, 1)
  assert.deepEqual(dateUtils.getEventStatus("2025-12-31", false, nowAt(2026, 1, 1)).ymd, {
    years: 0,
    months: 0,
    days: 1
  })
  assert.deepEqual(dateUtils.getEventStatus("2026-12-31", false, nowAt(2027, 1, 1)).ymd, {
    years: 0,
    months: 0,
    days: 1
  })
  // 2026-02-28 -> 2026-03-01 为 1 天（平年）
  assert.equal(dateUtils.getEventStatus("2026-02-28", false, nowAt(2026, 3, 1)).totalDays, 1)
  // 2024-02-28 -> 2024-03-01 为 2 天（闰年多出的 2 月 29 日）
  assert.equal(dateUtils.getEventStatus("2024-02-28", false, nowAt(2024, 3, 1)).totalDays, 2)

  // 多数时区夏令时切换发生在 3 月 / 11 月；日历日差值必须与时间分量无关
  assert.equal(dateUtils.getEventStatus("2026-03-09", false, nowAt(2026, 3, 8, 23, 59)).days, 1)
  assert.equal(dateUtils.getEventStatus("2026-11-02", false, nowAt(2026, 11, 1, 23, 59)).days, 1)
})

test("入口一致性：app.ux 暴露 dateUtils，日期写入与插件消息使用归一", () => {
  const appSource = fs.readFileSync(path.join(root, "src/app.ux"), "utf8")
  assert.ok(appSource.includes("global.dateUtils = dateUtils"), "app.ux 必须暴露共享日期工具")
  assert.ok(!appSource.includes("global.dateDiff"), "旧的 dateDiff 全局必须移除")

  const editSource = fs.readFileSync(path.join(root, "src/pages/edit/edit.ux"), "utf8")
  assert.ok(editSource.includes("normalizeDate"), "编辑页必须归一写入日期")
  assert.ok(editSource.includes("dateInvalid"), "非法日期必须有明确提示")

  const pickerSource = fs.readFileSync(path.join(root, "src/pages/datepicker/datepicker.ux"), "utf8")
  assert.ok(pickerSource.includes("parseDate"), "日期选择器必须显式解析入参")
  assert.ok(!pickerSource.includes("new Date("), "日期选择器不得再依赖 Date 解析日期")

  const indexSource = fs.readFileSync(path.join(root, "src/pages/index/index.ux"), "utf8")
  assert.ok(indexSource.includes("getRecurringStatus"), "首页必须使用统一重复状态算法")
  assert.ok(indexSource.includes("global.eventStore"), "首页读写必须走统一存储")

  const listSource = fs.readFileSync(path.join(root, "src/pages/list/list.ux"), "utf8")
  assert.ok(listSource.includes("getRecurringStatus"), "列表必须使用统一重复状态算法")
})

test("多语言：非法日期提示在全部文案文件中齐全", () => {
  for (const file of ["defaults.json", "zh-CN.json", "zh-TW.json", "zh-HK.json"]) {
    const data = JSON.parse(fs.readFileSync(path.join(root, "src/i18n", file), "utf8"))
    assert.ok(data.dateInvalid && data.dateInvalid.length > 0, file + " 缺少 dateInvalid 文案")
  }
})
