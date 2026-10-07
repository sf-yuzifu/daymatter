const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const {test} = require("node:test")

const root = path.resolve(__dirname, "..")
const URI = "internal://files/events.json"
const TMP = URI + ".tmp"
const BAK = URI + ".bak"
const DATE_URI = "internal://files/date.txt"
const DATE_TMP = DATE_URI + ".tmp"

function loadModule(source) {
  const module = {exports: {}}
  const script = source.replace(/^import .*$/gm, "").replace(/export default/, "module.exports =")
  new Function("module", script)(module)
  return module.exports
}

const dateUtils = loadModule(fs.readFileSync(path.join(root, "src/components/dateUtils.js"), "utf8"))
const eventStoreModule = loadModule(
  fs.readFileSync(path.join(root, "src/components/eventStore.js"), "utf8")
)
const watchfaceModule = loadModule(
  fs.readFileSync(path.join(root, "src/components/watchface.js"), "utf8")
)

test("F-01 表盘年度日期滚动且不覆盖原始日期", async () => {
  const fake = createFakeFile()
  let now = new Date(2026, 1, 28)
  const watchface = watchfaceModule.createWatchFace({file: fake.file, dateUtils, now: () => now})
  const event = {id: "birthday", name: "生日", date: "2020-02-29", repeat: "yearly"}
  const state = {primaryId: event.id, events: [event]}
  const sync = () => new Promise((resolve, reject) => watchface.sync(state, "", error => error ? reject(error) : resolve()))
  await sync()
  assert.equal(fake.files.get(DATE_URI), "生日,2026-02-28,false")
  now = new Date(2026, 2, 1)
  await sync()
  assert.equal(fake.files.get(DATE_URI), "生日,2027-02-28,false")
  assert.equal(event.date, "2020-02-29")
})

function createFakeFile(options = {}) {
  const files = new Map()
  const stats = {dateWrites: 0, dateMoves: 0}
  const controls = {
    failWriteFor: null,
    failMoveFor: null,
    failDateWrite: false,
    failDateMove: false,
    defer: options.defer === true
  }
  function runOrDefer(fn) {
    if (controls.defer) pending.push(fn)
    else fn()
  }
  const pending = []
  const file = {
    readText({uri, success, fail}) {
      if (files.has(uri)) success({text: files.get(uri)})
      else fail("not found", 301)
    },
    writeText({uri, text, success, fail}) {
      runOrDefer(() => {
        if (uri === DATE_URI || uri === DATE_TMP) {
          if (controls.failDateWrite) {
            fail("io", 300)
            return
          }
          stats.dateWrites += 1
        }
        if (controls.failWriteFor && controls.failWriteFor(uri)) {
          fail("io", 300)
          return
        }
        files.set(uri, text)
        success()
      })
    },
    move({srcUri, dstUri, success, fail}) {
      runOrDefer(() => {
        if (dstUri === DATE_URI) {
          if (controls.failDateMove) {
            fail("io", 300)
            return
          }
          stats.dateMoves += 1
        }
        if (controls.failMoveFor && controls.failMoveFor(srcUri, dstUri)) {
          fail("io", 300)
          return
        }
        if (!files.has(srcUri)) {
          fail("not found", 301)
          return
        }
        files.set(dstUri, files.get(srcUri))
        files.delete(srcUri)
        success({uri: dstUri})
      })
    },
    delete({uri, success}) {
      files.delete(uri)
      success()
    },
    access({uri, success, fail}) {
      if (files.has(uri)) success({})
      else fail("not found", 300)
    },
    copy({srcUri, dstUri, success, fail}) {
      if (!files.has(srcUri)) {
        fail("not found", 301)
        return
      }
      files.set(dstUri, files.get(srcUri))
      success({uri: dstUri})
    }
  }
  return {
    file: file,
    files: files,
    stats: stats,
    controls: controls,
    flush() {
      while (pending.length) pending.shift()()
    }
  }
}

function createStore(fake) {
  const watchFace = watchfaceModule.createWatchFace({file: fake.file})
  const store = eventStoreModule.createEventStore({
    file: fake.file,
    dateUtils: dateUtils,
    watchFace: watchFace
  })
  return {store: store, watchFace: watchFace}
}

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, result) => {
      if (error) {
        error.result = result
        reject(error)
      } else {
        resolve(result)
      }
    })
  })
}

function seedFile(fake, state) {
  fake.files.set(URI, JSON.stringify(Object.assign({version: 2, revision: 5}, state)))
}

function dateText(fake) {
  return fake.files.get(DATE_URI)
}

test("D-17 主事件与「首页展示」独立：on_index=false 也可作为表盘事件", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "",
    watchfacePending: false,
    events: [
      {id: "a", name: "隐藏事件", date: "2026-01-01", on_index: false, IFStaringDay: true, themeColor: ""},
      {id: "b", name: "首页事件", date: "2026-02-02", on_index: true, IFStaringDay: false, themeColor: ""}
    ]
  })
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(fake.files.has(DATE_URI), false, "无主事件时不写表盘文件")

  const result = await call(store, "setPrimary", "a")
  assert.equal(result.primaryId, "a")
  assert.equal(dateText(fake), "隐藏事件,2026-01-01,true", "表盘内容只取决于主事件")
  const stored = JSON.parse(fake.files.get(URI))
  assert.equal(stored.events[0].on_index, false, "切换主事件不得改动首页展示开关")
})

test("D-19 导出格式：名称含逗号 / 换行不破坏解析，布尔归一为 true / false", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "考试,期末\n冲刺", date: "2026-03-05", on_index: true, IFStaringDay: "true", themeColor: ""}]
  })
  const {store} = createStore(fake)
  const result = await call(store, "read")
  const text = dateText(fake)
  assert.equal(result.primaryId, "a")
  assert.equal(text.split(",").length, 3, "输出必须只有两个分隔逗号：" + text)
  const parts = text.split(",")
  assert.equal(parts[0], "考试 期末 冲刺", "名称内逗号与换行替换为空格")
  assert.equal(parts[1], "2026-03-05")
  assert.equal(parts[2], "true", "字符串布尔必须归一为 true / false")

  // 归一后再次提交内容不变，不产生重复写入
  const writesBefore = fake.stats.dateWrites
  await call(store, "update", "a", {name: "考试,期末\n冲刺"})
  assert.equal(fake.stats.dateWrites, writesBefore, "表盘内容未变化时不重复写")
})

test("D-19 名称只有分隔符时兜底，不产生空字段破坏结构", () => {
  assert.equal(watchfaceModule.buildText({name: " , , ", date: "2026-01-02", IFStaringDay: false}), "2026-01-02,2026-01-02,false")
  assert.equal(watchfaceModule.buildText({name: "\n", date: "", IFStaringDay: true}), "", "无名称且无日期时不产出内容")
  assert.equal(watchfaceModule.buildText(null), "", "无主事件时内容为空表示清空")
  assert.equal(watchfaceModule.sanitizeName(" a ,  b\nc "), "a b c")
})

test("D-18 所有提交都维护表盘：改主事件内容、改显示开关、插件按 ID / 下标修改", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "主事件", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(dateText(fake), "主事件,2026-01-01,false")

  await call(store, "update", "a", {name: "改名", date: "2026-05-06", IFStaringDay: true})
  assert.equal(dateText(fake), "改名,2026-05-06,true", "修改主事件内容立即写表盘")

  await call(store, "update", "a", {on_index: false})
  assert.equal(dateText(fake), "改名,2026-05-06,true", "关闭首页展示不改表盘内容")

  await call(store, "updateByIndex", 0, {name: "插件改名"})
  assert.equal(dateText(fake), "插件改名,2026-05-06,true", "旧插件下标协议同样维护表盘")
})

test("D-18 删除主事件：顺位替代或清空，替代规则可预期", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "b",
    events: [
      {id: "a", name: "甲", date: "2026-01-01", on_index: false, IFStaringDay: false, themeColor: ""},
      {id: "b", name: "乙", date: "2026-01-02", on_index: true, IFStaringDay: false, themeColor: ""},
      {id: "c", name: "丙", date: "2026-01-03", on_index: true, IFStaringDay: true, themeColor: ""}
    ]
  })
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(dateText(fake), "乙,2026-01-02,false")

  const removed = await call(store, "remove", "b")
  assert.equal(removed.primaryId, "c", "删除主事件后由下一个首页展示事件接管")
  assert.equal(dateText(fake), "丙,2026-01-03,true")

  await call(store, "remove", "c")
  assert.equal(dateText(fake), "", "没有可替代事件时清空表盘文件")

  // 主事件被删除且无替代：清空写入也发生一次，不残留旧值
  seedFile(fake, {
    primaryId: "z",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: false, IFStaringDay: false, themeColor: ""}]
  })
  const {store: store2} = createStore(fake)
  await call(store2, "read")
  assert.equal(dateText(fake), "", "失效主事件引用按规则重选，无候选则清空")
})

test("D-18 取消主事件：setPrimary 空串清空表盘，切回可恢复", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(dateText(fake), "甲,2026-01-01,false")

  await call(store, "setPrimary", "")
  assert.equal(dateText(fake), "")
  await assert.rejects(call(store, "setPrimary", "nope"), (error) => error.code === "NOT_FOUND")

  await call(store, "setPrimary", "a")
  assert.equal(dateText(fake), "甲,2026-01-01,false")
})

test("D-17 迁移规则：旧数组第一个首页展示事件成为主事件并写表盘", async () => {
  const fake = createFakeFile()
  fake.files.set(
    URI,
    JSON.stringify([
      {name: "隐藏", date: "2026-1-1", on_index: "false", IFStaringDay: "false", themeColor: ""},
      {name: "主", date: "2026-1-2", on_index: "true", IFStaringDay: "true", themeColor: "#3184d0"},
      {name: "另一", date: "2026-1-3", on_index: "true", IFStaringDay: "false", themeColor: ""}
    ])
  )
  const {store} = createStore(fake)
  const result = await call(store, "read")
  assert.equal(result.primaryId, result.events[1].id, "取第一个首页展示事件")
  assert.equal(dateText(fake), "主,2026-01-02,true")

  const stored = JSON.parse(fake.files.get(URI))
  assert.equal(stored.primaryId, result.events[1].id, "迁移后主事件落盘")
  assert.equal(stored.watchfacePending, false)

  // 无首页展示事件时迁移不设主事件，表盘清空
  fake.files.set(
    URI,
    JSON.stringify([{name: "隐藏", date: "2026-1-1", on_index: false, IFStaringDay: false, themeColor: ""}])
  )
  const {store: store2} = createStore(fake)
  const result2 = await call(store2, "read")
  assert.equal(result2.primaryId, "")
  assert.equal(dateText(fake), "")
})

test("D-17 失效主事件引用：按规则重选并落盘，不保留幽灵引用", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "missing",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  const {store} = createStore(fake)
  const result = await call(store, "read")
  assert.equal(result.primaryId, "a")
  assert.equal(JSON.parse(fake.files.get(URI)).primaryId, "a")
  assert.equal(dateText(fake), "甲,2026-01-01,false")
})

test("D-20 表盘失败：事件数据已提交、分项结果上报、标记待补写", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  const {store} = createStore(fake)
  fake.controls.failDateWrite = true
  await call(store, "read")

  let caught = null
  try {
    await call(store, "update", "a", {name: "改名"})
  } catch (error) {
    caught = error
  }
  assert.ok(caught, "表盘失败必须回调错误")
  assert.equal(caught.code, "WATCHFACE_FAIL")
  assert.equal(caught.result.event.name, "改名", "分项结果带回已提交的数据")
  assert.equal(caught.result.watchface.ok, false)

  const stored = JSON.parse(fake.files.get(URI))
  assert.equal(stored.events[0].name, "改名", "事件数据已提交")
  assert.equal(stored.watchfacePending, true, "标记待补写")
  fake.controls.failDateWrite = false
})

test("D-20 下次进入自动补写：恢复后清除待补写标记", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    watchfacePending: true,
    events: [{id: "a", name: "补写", date: "2026-04-04", on_index: true, IFStaringDay: true, themeColor: ""}]
  })
  fake.controls.failDateWrite = true
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(dateText(fake), undefined, "补写失败时表盘文件保持原状")
  assert.equal(JSON.parse(fake.files.get(URI)).watchfacePending, true, "仍标记待补写")
  fake.controls.failDateWrite = false

  // 新会话再次进入：这次写入可用，补写成功并清标记
  const {store: store2} = createStore(fake)
  await call(store2, "read")
  assert.equal(dateText(fake), "补写,2026-04-04,true")
  assert.equal(JSON.parse(fake.files.get(URI)).watchfacePending, false)
})

test("会话内首次读取维护一次表盘文件，重复读取不重复写", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  const {store} = createStore(fake)
  await call(store, "read")
  const writes = fake.stats.dateWrites
  assert.ok(writes > 0, "首次读取补齐表盘文件")
  await call(store, "read")
  await call(store, "read")
  assert.equal(fake.stats.dateWrites, writes, "内容未变时后续读取不写盘")
})

test("D-20 表盘写入路径：先临时文件再 move，move 不支持覆盖时退化为直接写", async () => {
  const fake = createFakeFile()
  seedFile(fake, {
    primaryId: "a",
    events: [{id: "a", name: "甲", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  })
  fake.controls.failDateMove = true
  const {store} = createStore(fake)
  await call(store, "read")
  assert.equal(dateText(fake), "甲,2026-01-01,false", "move 失败后直接写目标文件仍成功")
  assert.equal(fake.files.has(DATE_TMP), false, "临时文件不残留")
})

test("表盘文件不参与事件校验：数据损坏时仍拒绝，不误清表盘", async () => {
  const fake = createFakeFile()
  fake.files.set(URI, "{corrupt")
  fake.files.set(DATE_URI, "旧表盘,2026-01-01,false")
  const {store} = createStore(fake)
  await assert.rejects(call(store, "read"), (error) => error.type === "corrupt")
  assert.equal(dateText(fake), "旧表盘,2026-01-01,false", "读失败不触碰表盘文件")
})
