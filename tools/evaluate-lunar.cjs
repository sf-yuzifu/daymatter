// F-10 feasibility only: not imported by the app. No files are written.
// Year table: yize/solarlunar const/lunarInfo.js, commit
// b1d43280119a448dbf557dfdcf73fc6f7f59f422; ISC, see lunar-evaluation/LICENSE.
const assert = require("node:assert/strict")
const zlib = require("node:zlib")
const table = require("./lunar-evaluation/year-info.json")
if (process.argv.includes("--runtime")) {
  const fs = require("node:fs"), path = require("node:path")
  const source = fs.readFileSync(path.join(__dirname,"../src/components/dateUtils.js"),"utf8")
  const runtime = JSON.parse(source.match(/const LUNAR_TABLE = (\[[\s\S]*?\])/)[1])
  table.splice(0,table.length,...runtime)
}
const DAY = 86400000
const base = Date.UTC(1900, 0, 31) / DAY

function months(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null
  const info = table[year - 1900], leap = info & 15, result = []
  for (let month = 1; month <= 12; month++) {
    result.push({month, leap: false, days: 29 + !!(info & (0x10000 >> month))})
    if (month === leap) result.push({month, leap: true, days: 29 + !!(info & 0x10000)})
  }
  return result
}
const starts = [base]
for (let year = 1900; year <= 2100; year++) starts.push(starts.at(-1) + months(year).reduce((n, m) => n + m.days, 0))
function solar(lunar) {
  const list = months(lunar.year)
  if (!list) return null
  let day = starts[lunar.year - 1900]
  for (const m of list) {
    if (m.month === lunar.month && m.leap === lunar.leap) {
      if (!Number.isInteger(lunar.day) || lunar.day < 1 || lunar.day > m.days) return null
      return day + lunar.day - 1
    }
    day += m.days
  }
  return null
}
function lunar(day) {
  if (day < base || day >= starts.at(-1)) return null
  let year = 1900
  while (day >= starts[year - 1900 + 1]) year++
  let offset = day - starts[year - 1900]
  for (const m of months(year)) {
    if (offset < m.days) return {year, month: m.month, day: offset + 1, leap: m.leap}
    offset -= m.days
  }
}
const iso = day => new Date(day * DAY).toISOString().slice(0, 10)
const formatter = new Intl.DateTimeFormat("en-u-ca-chinese", {timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric"})
function icu(day) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(day * DAY + 4 * 3600000)).map(p => [p.type, p.value]))
  return {year: Number(parts.relatedYear), month: parseInt(parts.month), day: Number(parts.day), leap: parts.month.includes("bis")}
}

async function main() {
  if (process.argv.includes("--source")) {
    const response = await fetch("https://raw.githubusercontent.com/yize/solarlunar/b1d43280119a448dbf557dfdcf73fc6f7f59f422/const/lunarInfo.js")
    if (!response.ok) throw Error(`Source: ${response.status}`)
    const text = await response.text()
    const original = [...text.matchAll(/0x[0-9a-f]+/gi)].map(m => parseInt(m[0],16))
    const differences = original.flatMap((value,index) => value === table[index] ? [] : [{year:1900+index, expected:value, actual:table[index]}])
    console.log(JSON.stringify({sourceEntries:original.length, differences},null,2))
    assert.deepEqual(table,original,"Local fixture must exactly match pinned upstream")
  }
  assert.equal(table.length, 201)
  let roundtrips = 0, differences = 0
  const samples = []
  for (let day = base; day < starts.at(-1); day++) {
    const value = lunar(day)
    assert.equal(solar(value), day)
    roundtrips++
    const reference = icu(day)
    if (JSON.stringify(value) !== JSON.stringify(reference)) {
      differences++
      if (samples.length < 12) samples.push({solar: iso(day), table: value, icu: reference})
    }
  }
  for (const [date, expected] of [
    ["2020-05-23", {year:2020, month:4, day:1, leap:true}],
    ["2023-03-22", {year:2023, month:2, day:1, leap:true}],
    ["2025-07-25", {year:2025, month:6, day:1, leap:true}],
    ["2026-02-17", {year:2026, month:1, day:1, leap:false}],
    ["2033-12-22", {year:2033, month:11, day:1, leap:true}]
  ]) assert.deepEqual(lunar(Date.parse(date + "T00:00:00Z") / DAY), expected)
  assert.equal(solar({year:2026,month:2,day:1,leap:true}), null)
  assert.equal(lunar(base - 1), null)
  assert.equal(lunar(starts.at(-1)), null)
  const literal = "[" + table.map(n => "0x" + n.toString(16)).join(",") + "]"
  const numeric = "[" + table.join(",") + "]"
  console.log(JSON.stringify({node:process.version, icu:process.versions.icu,
    lunarYears:[1900,2100], solarRange:[iso(base),iso(starts.at(-1)-1)],
    roundtrips, icuDifferences:differences, samples,
    tableBytes:{u32:table.length*4, numericArraySource:Buffer.byteLength(numeric), hexArraySource:Buffer.byteLength(literal),
      numericDeflate:zlib.deflateRawSync(numeric).length, hexDeflate:zlib.deflateRawSync(literal).length},
    year2033Leap:table[133]&15}, null, 2))
  if (process.argv.includes("--hko")) {
    // Independent official sample-year comparison; network needed for this option only.
    const labels = ["", "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"]
    const days = ["", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"]
    for (const year of [2020,2023,2025,2026,2033,2057,2089,2097,2100]) {
      const response = await fetch(`https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T${year}c.txt`)
      if (!response.ok) throw Error(`HKO ${year}: ${response.status}`)
      const text = await response.text()
      let compared = 0
      const mismatches = []
      for (const match of text.matchAll(/(\d{4})年(\d+)月(\d+)日\s+(\S+)/g)) {
        const date = `${match[1]}-${match[2].padStart(2,"0")}-${match[3].padStart(2,"0")}`
        const value = lunar(Date.parse(date + "T00:00:00Z") / DAY)
        const label = value.day === 1 ? (value.leap ? "閏" : "") + labels[value.month] : days[value.day]
        compared++
        if (label !== match[4]) mismatches.push({date,table:label,hko:match[4]})
      }
      assert.ok(compared >= 365, `HKO ${year} response incomplete`)
      console.log(JSON.stringify({hkoYear:year, compared, mismatches}))
    }
  }
}
main().catch(error => {console.error(error); process.exitCode = 1})
