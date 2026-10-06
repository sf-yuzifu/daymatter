const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const {test} = require("node:test")

const root = path.resolve(__dirname, "..")
const URI = "internal://files/events.json"
const BAK = URI + ".bak"
const TMP = URI + ".tmp"
const BAD = URI + ".bad"

// 在当前 realm 加载模块，deepStrictEqual 原型一致；纯逻辑无需 vm 隔离
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

function createFakeFile(options = {}) {
  const files = new Map()
  const pending = []
  const controls = {
    failWriteFor: null,
    failMoveFor: null,
    failReadFor: null,
    defer: options.defer === true
  }
  function runOrDefer(fn) {
    if (controls.defer) pending.push(fn)
    else fn()
  }
  const file = {
    readText({uri, success, fail}) {
      if (controls.failReadFor && controls.failReadFor(uri)) {
        if (fail) fail("io error", 300)
        return
      }
      if (files.has(uri)) success({text: files.get(uri)})
      else if (fail) fail("not found", 301)
    },
    writeText({uri, text, success, fail}) {
      runOrDefer(() => {
        if (controls.failWriteFor && controls.failWriteFor(uri)) {
          if (fail) fail("io error", 300)
          return
        }
        files.set(uri, text)
        if (success) success()
      })
    },
    move({srcUri, dstUri, success, fail}) {
      runOrDefer(() => {
        if (controls.failMoveFor && controls.failMoveFor(srcUri, dstUri)) {
          if (fail) fail("io error", 300)
          return
        }
        if (!files.has(srcUri)) {
          if (fail) fail("not found", 301)
          return
        }
        files.set(dstUri, files.get(srcUri))
        files.delete(srcUri)
        if (success) success({uri: dstUri})
      })
    },
    copy({srcUri, dstUri, success, fail}) {
      runOrDefer(() => {
        if (!files.has(srcUri)) {
          if (fail) fail("not found", 301)
          return
        }
        files.set(dstUri, files.get(srcUri))
        if (success) success({uri: dstUri})
      })
    },
    delete({uri, success}) {
      files.delete(uri)
      if (success) success()
    },
    access({uri, success, fail}) {
      if (files.has(uri)) {
        if (success) success({})
      } else if (fail) {
        fail("not found", 300)
      }
    }
  }
  return {
    file: file,
    files: files,
    controls: controls,
    flush() {
      while (pending.length) pending.shift()()
    }
  }
}

function createStore(fake, overrides) {
  return eventStoreModule.createEventStore(
    Object.assign({file: fake.file, dateUtils: dateUtils, now: () => 1700000000000}, overrides || {})
  )
}

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

function seedFile(fake, events, extra) {
  fake.files.set(URI, JSON.stringify(Object.assign({version: 2, revision: 100, events: events}, extra || {})))
}

test("D-13 旧数组迁移：字段归一、日期补零、字符串布尔转换、ID 稳定且不丢字段", async () => {
  const fake = createFakeFile()
  fake.files.set(
    URI,
    JSON.stringify([
      {
        name: "旧事件",
        date: "2026-1-5",
        on_index: "true",
        IFStaringDay: "false",
        themeColor: "#e74c3c",
        futureField: "保留"
      }
    ])
  )
  const store = createStore(fake)
  const first = await call(store, "read")
  assert.equal(first.migrated, true, "旧数组必须标记迁移")
  assert.equal(first.events.length, 1)
  const event = first.events[0]
  assert.equal(event.name, "旧事件")
  assert.equal(event.date, "2026-01-05", "非补零日期必须归一")
  assert.equal(event.on_index, true, "字符串布尔必须转换")
  assert.equal(event.IFStaringDay, false)
  assert.equal(event.themeColor, "#e74c3c", "主题色不得丢失")
  assert.equal(event.futureField, "保留", "未知扩展字段必须保留")
  assert.ok(typeof event.id === "string" && event.id.length > 0, "迁移必须生成稳定 ID")

  // 迁移自动落盘：文件升级为带版本的包装格式
  const persisted = JSON.parse(fake.files.get(URI))
  assert.equal(persisted.version, 2)
  assert.equal(persisted.events[0].id, event.id)

  // 重复启动（新实例）读取同一 ID，不重新生成
  const second = await call(createStore(fake), "read")
  assert.equal(second.migrated, false)
  assert.equal(second.events[0].id, event.id)
})

test("D-12 / D-08 新增 / 修改 / 删除：稳定 ID、revision 与读取回读一致", async () => {
  const fake = createFakeFile()
  const store = createStore(fake)

  const added = await call(store, "add", {
    name: "甲",
    date: "2026-1-5",
    on_index: true,
    IFStaringDay: false,
    themeColor: "#3184d0"
  })
  assert.equal(added.event.date, "2026-01-05", "新增日期必须归一")
  assert.equal(added.revision, 1)

  const added2 = await call(store, "add", {name: "乙", date: "2026-02-05"})
  assert.notEqual(added.event.id, added2.event.id, "不同事件 ID 必须唯一")
  assert.equal(added2.event.themeColor, "", "缺省主题色为空，由显示层回退默认")
  assert.equal(added2.event.on_index, true, "缺省首页开关为显示")

  const updated = await call(store, "update", added.event.id, {name: "甲改"})
  assert.equal(updated.event.name, "甲改")
  assert.equal(updated.event.date, "2026-01-05", "未提供的日期必须保留")
  assert.equal(updated.event.themeColor, "#3184d0", "未提供的主题色必须保留")
  assert.equal(updated.event.on_index, true, "未提供的开关必须保留")
  assert.equal(updated.revision, 3, "每次提交 revision 递增")

  const reread = await call(createStore(fake), "read")
  assert.deepEqual(
    reread.events.map((item) => item.id),
    [added.event.id, added2.event.id],
    "重启后稳定 ID 不变"
  )

  const removed = await call(store, "remove", added.event.id)
  assert.equal(removed.revision, 4)
  assert.equal((await call(store, "read")).events.length, 1)
})

test("旧下标协议兼容：updateByIndex / remove(number) 在队列内解析", async () => {
  const fake = createFakeFile()
  const store = createStore(fake)
  await call(store, "add", {name: "一", date: "2026-01-01"})
  await call(store, "add", {name: "二", date: "2026-01-02"})

  await call(store, "updateByIndex", 1, {name: "二改"})
  let events = (await call(store, "read")).events
  assert.equal(events[1].name, "二改")
  assert.equal(events[0].name, "一")

  await call(store, "remove", 0)
  events = (await call(store, "read")).events
  assert.equal(events.length, 1)
  assert.equal(events[0].name, "二改")

  await assert.rejects(call(store, "updateByIndex", 5, {name: "越界"}), (error) => error.code === "NOT_FOUND")
})

test("D-15 输入校验：非法名称 / 日期 / 布尔 / 颜色 / 类型拒绝且不写入", async () => {
  const fake = createFakeFile()
  const store = createStore(fake)
  const cases = [
    [{date: "2026-01-01"}, "NAME_REQUIRED"],
    [{name: "   ", date: "2026-01-01"}, "NAME_REQUIRED"],
    [{name: "x".repeat(eventStoreModule.MAX_NAME_LENGTH + 1), date: "2026-01-01"}, "NAME_TOO_LONG"],
    [{name: "a", date: "2026-02-30"}, "DATE_INVALID"],
    [{name: "a", date: "2026-1-1", on_index: "maybe"}, "INVALID_BOOLEAN"],
    [{name: "a", date: "2026-1-1", IFStaringDay: 1}, "INVALID_BOOLEAN"],
    [{name: "a", date: "2026-1-1", themeColor: "#123456"}, "INVALID_COLOR"],
    [{name: "a", date: "2026-1-1", themeColor: 123}, "INVALID_COLOR"],
    ["不是对象", "INVALID_EVENT"]
  ]
  for (const [input, code] of cases) {
    await assert.rejects(call(store, "add", input), (error) => error.code === code, code)
  }
  const result = await call(store, "read")
  assert.equal(result.events.length, 0, "非法输入不得静默写入")
})

test("D-15 数量上限：达到上限后拒绝并提示，不丢已有条目", async () => {
  const fake = createFakeFile()
  const seeded = []
  for (let i = 0; i < eventStoreModule.MAX_EVENTS; i++) {
    seeded.push({name: "事件" + i, date: "2026-01-01", on_index: false, IFStaringDay: false, themeColor: ""})
  }
  seedFile(fake, seeded)
  const store = createStore(fake)
  await assert.rejects(
    call(store, "add", {name: "超限", date: "2026-01-02"}),
    (error) => error.code === "EVENT_LIMIT"
  )
  assert.equal((await call(store, "read")).events.length, eventStoreModule.MAX_EVENTS)
})

test("D-09 损坏数据：备份 .bad 后拒绝读写，绝不覆盖原文件", async () => {
  const fake = createFakeFile()
  fake.files.set(URI, "{corrupt")
  const store = createStore(fake)

  await assert.rejects(call(store, "read"), (error) => error.type === "corrupt")
  assert.equal(fake.files.get(URI), "{corrupt", "损坏主文件不得被覆盖")
  assert.equal(fake.files.get(BAD), "{corrupt", "损坏现场必须备份为 .bad")

  await assert.rejects(
    call(store, "add", {name: "新事件", date: "2026-01-01"}),
    (error) => error.type === "corrupt",
    "损坏数据上不得执行新增"
  )
  assert.equal(fake.files.get(URI), "{corrupt", "新增拒绝后主文件保持不变")
})

test("D-09 / D-11 从 .bak 自动恢复：主文件损坏时旧有效数据不丢", async () => {
  const fake = createFakeFile()
  fake.files.set(URI, "not json")
  fake.files.set(
    BAK,
    JSON.stringify([
      {name: "备份事件", date: "2026-1-2", on_index: "true", IFStaringDay: "false", themeColor: "#3184d0"}
    ])
  )
  const result = await call(createStore(fake), "read")
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].name, "备份事件")
  assert.equal(result.events[0].date, "2026-01-02")
  assert.ok(JSON.parse(fake.files.get(URI)), "主文件必须恢复为有效 JSON")
  assert.equal(fake.files.has(BAK), false, "恢复后备份被消费")
  assert.equal(fake.files.get(BAD), "not json", "损坏现场仍保留在 .bad")
})

test("D-09 I/O 读取错误：拒绝操作，不当作空列表覆盖", async () => {
  const fake = createFakeFile()
  fake.files.set(URI, JSON.stringify({version: 2, revision: 1, events: []}))
  fake.controls.failReadFor = (uri) => uri === URI
  const store = createStore(fake)

  await assert.rejects(call(store, "read"), (error) => error.type === "io")
  await assert.rejects(
    call(store, "add", {name: "新事件", date: "2026-01-01"}),
    (error) => error.type === "io"
  )
})

test("D-11 原子写失败：写入 .tmp 失败时不触碰正式文件", async () => {
  const fake = createFakeFile()
  const before = JSON.stringify({version: 2, revision: 7, events: [{id: "a", name: "旧", date: "2026-01-01"}]})
  fake.files.set(URI, before)
  fake.controls.failWriteFor = (uri) => uri === TMP
  const store = createStore(fake)

  await assert.rejects(
    call(store, "update", "a", {name: "新"}),
    (error) => error.code === "SAVE_FAIL"
  )
  assert.equal(fake.files.get(URI), before, "正式文件必须保持旧有效数据")
})

test("D-11 move 覆盖失败：经 .bak 安全交换，成功后清理备份", async () => {
  const fake = createFakeFile()
  seedFile(fake, [{id: "a", name: "旧", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}])
  let failedOnce = false
  fake.controls.failMoveFor = (srcUri) => {
    if (srcUri === TMP && !failedOnce) {
      failedOnce = true
      return true
    }
    return false
  }
  const store = createStore(fake)
  await call(store, "update", "a", {name: "新"})

  const persisted = JSON.parse(fake.files.get(URI))
  assert.equal(persisted.events[0].name, "新", "安全交换后新数据必须落盘")
  assert.equal(fake.files.has(BAK), false, "成功后备份必须清理")
  assert.equal(fake.files.has(TMP), false, "临时文件必须已被 move")
})

test("D-11 二次 move 失败：回滚 .bak，旧有效数据不丢", async () => {
  const fake = createFakeFile()
  const oldEvents = [{id: "a", name: "旧", date: "2026-01-01", on_index: true, IFStaringDay: false, themeColor: ""}]
  seedFile(fake, oldEvents)
  fake.controls.failMoveFor = (srcUri) => srcUri === TMP
  const store = createStore(fake)

  await assert.rejects(
    call(store, "update", "a", {name: "新"}),
    (error) => error.code === "SAVE_FAIL"
  )
  const persisted = JSON.parse(fake.files.get(URI))
  assert.deepEqual(persisted.events, oldEvents, "回滚后正式文件必须仍是旧有效数据")
  assert.equal(fake.files.has(BAK), false, "回滚后备份已归还")
})

test("D-10 串行队列：连续提交全部落盘，不丢更新", async () => {
  const fake = createFakeFile({defer: true})
  const store = createStore(fake)
  const settled = []
  store.add({name: "A", date: "2026-03-01"}, (error) => settled.push(error ? "err" : "ok"))
  store.add({name: "B", date: "2026-03-02"}, (error) => settled.push(error ? "err" : "ok"))
  store.add({name: "C", date: "2026-03-03"}, (error) => settled.push(error ? "err" : "ok"))
  fake.flush()

  const result = await call(store, "read")
  assert.deepEqual(
    result.events.map((item) => item.name).sort(),
    ["A", "B", "C"],
    "并发提交必须串行合并，不得丢更新"
  )
  assert.equal(result.revision, 3)
  assert.deepEqual(settled, ["ok", "ok", "ok"])
})

test("自动提交校验：新增独立 revision、读取不改变数据", async () => {
  const fake = createFakeFile()
  const store = createStore(fake)
  await call(store, "add", {name: "一", date: "2026-01-01"})
  const first = await call(store, "read")
  const second = await call(store, "read")
  assert.equal(first.revision, second.revision, "纯读取不得改变 revision")
  assert.equal(second.events.length, 1)
})

test("多语言：存储错误提示在五种文案文件中齐全", () => {
  for (const file of ["defaults.json", "en.json", "zh-CN.json", "zh-TW.json", "zh-HK.json"]) {
    const data = JSON.parse(fs.readFileSync(path.join(root, "src/i18n", file), "utf8"))
    for (const key of ["tooManyEvents", "invalidEvent", "eventNotFound", "loadFail"]) {
      assert.ok(data[key] && data[key].length > 0, file + " 缺少 " + key)
    }
  }
})
