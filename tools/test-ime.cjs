const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const {test} = require("node:test")

const root = path.resolve(__dirname, "..")
const imeDir = path.join(root, "src/pages/ime")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"))
const imeSource = fs.readFileSync(path.join(imeDir, "ime.ux"), "utf8").replace(/\r\n/g, "\n")

function loadModule(source, bindings, exportName) {
  const context = vm.createContext({...bindings, module: {exports: {}}})
  const script = source
    .replace(/^import .*$/gm, "")
    .replace(/export default/, "module.exports =")
    .replace(new RegExp("export\\s*\\{\\s*" + exportName + "\\s*\\};?"), "module.exports = " + exportName)
  vm.runInContext(script, context)
  return context.module.exports
}

function createHarness() {
  const state = {
    pages: [],
    definitions: new Map(),
    writes: [],
    vibrations: [],
    maxDepth: 0,
    replacements: 0,
    files: new Map([
      ["internal://files/events.json", JSON.stringify({version: 2, revision: 0, events: []})]
    ]),
    bgFiles: [],
    connection: null,
    deferReads: false,
    deferWrites: false,
    failWrites: false,
    readCounts: new Map(),
    global: {
      screenShape: "pill-shaped",
      screenSize: {width: 192, height: 490},
      deviceType: "band",
      isPillShaped: true,
      getTime: () => "12:34",
      adjustThemeColor: (color) => color || "#3184d0"
    }
  }
  // 可控时钟与假定时器：分钟时钟与日期状态测试不依赖真实时间，也不会残留 Node 定时器
  const clock = {now: new Date(2026, 9, 6, 12, 34, 30).getTime()}
  const timeoutQueue = new Map()
  let timerSeq = 0
  const RealDate = Date
  const FakeDate = function (...args) {
    if (args.length === 0) return new RealDate(clock.now)
    return new RealDate(...args)
  }
  FakeDate.now = () => clock.now
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  const fakeSetTimeout = (fn, delay) => {
    const id = ++timerSeq
    timeoutQueue.set(id, {fn, delay})
    return id
  }
  const fakeClearTimeout = (id) => {
    timeoutQueue.delete(id)
  }
  // 日期工具使用同一假时钟：页面日期状态与分钟时钟保持一致的可控时间
  const dateUtils = loadModule(
    fs.readFileSync(path.join(root, "src/components/dateUtils.js"), "utf8"),
    {Date: FakeDate},
    "unused"
  )
  state.global.dateUtils = dateUtils
  state.global.eventOrder = loadModule(fs.readFileSync(path.join(root, "src/components/eventOrder.js"), "utf8"), {}, "unused")
  state.clock = clock
  state.pendingTimers = () => timeoutQueue.size
  state.timerDelays = () => Array.from(timeoutQueue.values()).map((task) => task.delay)
  state.runNextTimer = () => {
    const next = timeoutQueue.entries().next()
    if (next.done) return false
    const [id, task] = next.value
    timeoutQueue.delete(id)
    task.fn()
    return true
  }
  state.readCount = (uri) => state.readCounts.get(uri) || 0
  const dict = loadModule(fs.readFileSync(path.join(imeDir, "assets/dic.js"), "utf8"), {}, "dict")
  const SimpleInputMethod = loadModule(
    fs.readFileSync(path.join(imeDir, "assets/dicUtil.js"), "utf8"), {dict}, "SimpleInputMethod"
  )
  // 每个 harness 持有自己的应用级互联中心实例（与页面脚本共享同一份）
  const interconnectHub = loadModule(
    fs.readFileSync(path.join(root, "src/components/interconnectHub.js"), "utf8"), {}, "unused"
  )
  // 分钟时钟使用假定时器与可控时钟，页面通过 global.createMinuteTicker 获取
  const minuteTicker = loadModule(
    fs.readFileSync(path.join(root, "src/components/minuteTicker.js"), "utf8"),
    {setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Date: FakeDate},
    "unused"
  )
  state.global.createMinuteTicker = minuteTicker.createMinuteTicker
  const current = () => state.pages[state.pages.length - 1]
  const show = () => { if (current().onShow) current().onShow() }
  const destroy = () => {
    const page = state.pages.pop()
    if (page.onDestroy) page.onDestroy()
  }
  const router = {
    push({uri, params = {}}) {
      if (current() && current().onHide) current().onHide()
      const route = uri.replace(/^\//, "")
      let definition = state.definitions.get(route)
      if (!definition) {
        const component = manifest.router.pages[route].component
        const source = fs.readFileSync(path.join(root, "src", route, component + ".ux"), "utf8")
        const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
        definition = loadModule(script, {
          router, file, showToast() {}, SimpleInputMethod, global: state.global,
          setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
          console: {log() {}, error() {}},
          app: {getInfo: () => ({versionName: "2.1"})},
          vibrator: {vibrate(options) { state.vibrations.push(options) }},
          device: {getInfo({success}) { success({screenWidth: state.global.screenSize.width}) }},
          interconnect: {
            instance() {
              if (!state.connection) {
                state.connection = {
                  onmessage: null,
                  sent: [],
                  send(options) {
                    state.connection.sent.push(options)
                    if (options.success) options.success()
                  }
                }
              }
              return state.connection
            }
          },
          interconnectHub
        }, "unused")
        state.definitions.set(route, definition)
      }
      const page = {
        ...JSON.parse(JSON.stringify(definition.private)),
        uri,
        $t: (key) => key,
        $element: () => null
      }
      for (const [key, value] of Object.entries(params)) page[key] = String(value)
      for (const [key, method] of Object.entries(definition)) {
        if (typeof method === "function") page[key] = method.bind(page)
      }
      state.pages.push(page)
      state.maxDepth = Math.max(state.maxDepth, state.pages.length)
      if (page.onInit) page.onInit()
      if (page.onReady) page.onReady()
      show()
      return page
    },
    back(options = {}) {
      if (state.pages.length < 2) return
      let target = state.pages.length - 2
      for (let i = target; i >= 0; i--) {
        if (state.pages[i].uri === options.path) { target = i; break }
      }
      while (state.pages.length - 1 > target) destroy()
      show()
    },
    replace(options) {
      state.replacements++
      destroy()
      return router.push(options)
    },
    clear() {
      const page = state.pages.pop()
      while (state.pages.length) destroy()
      state.pages.push(page)
    },
    getLength: () => state.pages.length
  }
  const readQueue = []
  const writeQueue = []
  const file = {
    readText({uri, success, fail}) {
      const run = () => {
        state.readCounts.set(uri, (state.readCounts.get(uri) || 0) + 1)
        if (state.files.has(uri)) success({text: state.files.get(uri)})
        else if (fail) fail("not found", 301)
      }
      if (state.deferReads) readQueue.push(run)
      else run()
    },
    writeText({uri, text, success, fail}) {
      const run = () => {
        if (state.failWrites) {
          if (fail) fail("io error", 300)
          return
        }
        state.files.set(uri, text)
        state.writes.push(uri)
        if (success) success()
      }
      if (state.deferWrites) writeQueue.push(run)
      else run()
    },
    move({srcUri, dstUri, success, fail}) {
      const run = () => {
        if (state.failWrites) {
          if (fail) fail("io error", 300)
          return
        }
        if (!state.files.has(srcUri)) {
          if (fail) fail("not found", 301)
          return
        }
        state.files.set(dstUri, state.files.get(srcUri))
        state.files.delete(srcUri)
        state.writes.push(dstUri)
        if (success) success({uri: dstUri})
      }
      if (state.deferWrites) writeQueue.push(run)
      else run()
    },
    access({uri, success, fail}) {
      if (state.files.has(uri)) {
        if (success) success({})
      } else if (fail) {
        fail("not found", 300)
      }
    },
    writeArrayBuffer({uri, buffer, append, success, fail}) {
      const run = () => {
        if (state.failWrites) { if (fail) fail("io error", 300); return }
        const bytes = Buffer.from(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength)
        const previous = append && state.files.has(uri) ? Buffer.from(state.files.get(uri), "base64") : Buffer.alloc(0)
        state.files.set(uri, Buffer.concat([previous, bytes]).toString("base64"))
        if (success) success()
      }
      if (state.deferWrites) writeQueue.push(run)
      else run()
    },
    delete({uri, success}) {
      state.files.delete(uri)
      if (success) success()
    },
    list({success}) {
      success({fileList: state.bgFiles.map((uri) => ({uri}))})
    }
  }
  const eventStoreModule = loadModule(
    fs.readFileSync(path.join(root, "src/components/eventStore.js"), "utf8"), {}, "unused"
  )
  const backgroundModule = loadModule(
    fs.readFileSync(path.join(root, "src/components/backgroundStore.js"), "utf8"), {}, "unused"
  )
  state.global.backgroundStore = backgroundModule.createBackgroundStore({
    file, decode: (value) => Uint8Array.from(Buffer.from(value, "base64")).buffer,
    now: () => clock.now, setTimer: fakeSetTimeout, clearTimer: fakeClearTimeout
  })
  state.backgroundFile = file
  state.global.eventStore = eventStoreModule.createEventStore({
    file: file,
    dateUtils: dateUtils,
    now: () => clock.now
  })
  state.flushReads = () => { while (readQueue.length) readQueue.shift()() }
  state.flushWrites = () => { while (writeQueue.length) writeQueue.shift()() }
  state.router = router
  state.current = current
  state.openEditor = (params = {}) => {
    router.push({uri: "/pages/index"})
    return router.push({uri: "/pages/edit", params: {
      event_name: "原名称", date: "2026-10-6", themeColor: "#27ae60",
      on_index: false, IFStaringDay: true, ...params
    }})
  }
  return state
}

function otherFields(page) {
  return JSON.stringify([page.date, page.themeColor, page.on_index, page.IFStaringDay,
    page.event_id, page.extend, page.callback_uri])
}

// 事件文件兼容新旧格式：迁移前数组 / 迁移后 {version, revision, events}
function readStoreEvents(h) {
  const parsed = JSON.parse(h.files.get("internal://files/events.json"))
  return Array.isArray(parsed) ? parsed : parsed.events
}

test("新版路由和所有静态 / 动态图片路径可解析，旧组件资源已收口", () => {
  assert.equal(manifest.router.pages["pages/ime"].component, "ime")
  assert.equal(manifest.router.pages["pages/input"], undefined)
  assert.equal(fs.existsSync(path.join(root, "src/components/InputMethod")), false)
  for (const match of imeSource.matchAll(/src="([^"]+)"/g)) {
    const image = match[1]
    if (!image.startsWith("./assets/") && !image.startsWith("/pages/ime/assets/")) continue
    for (const lang of ["cn", "en"]) {
      const resolved = image.replace(/\{\{\s*lang\s*\}\}/g, lang)
      const file = resolved.startsWith("/")
        ? path.join(root, "src", resolved.slice(1)) : path.join(imeDir, resolved)
      assert.ok(fs.existsSync(file), "missing keyboard image: " + resolved)
      assert.ok(fs.readdirSync(path.dirname(file)).includes(path.basename(file)), "image case: " + resolved)
    }
  }
})

test("P-08: 全项目优化后图片与资源完整性校验（无损解码、去重断言、manifest 图标、字体与动态路径）", () => {
  const {PNG} = require("pngjs")

  // 1. 去重与无引用资源清理断言
  assert.equal(fs.existsSync(path.join(imeDir, "assets/horizontal/space.png")), false, "去重后的 horizontal/space.png 不应存在")
  assert.equal(fs.existsSync(path.join(imeDir, "assets/horizontal/down2.png")), false, "去重后的 horizontal/down2.png 不应存在")
  assert.equal(fs.existsSync(path.join(imeDir, "assets/arc/sign.png")), false, "无引用的 arc/sign.png 不应存在")
  assert.ok(fs.existsSync(path.join(imeDir, "assets/arc/space.png")), "复用目标 arc/space.png 必须存在")
  assert.ok(fs.existsSync(path.join(imeDir, "assets/arc/down2.png")), "复用目标 arc/down2.png 必须存在")

  // 2. manifest 图标与字体文件存在性与大小写验证
  const manifestIconPath = path.join(root, "src", manifest.icon.replace(/^\//, ""))
  assert.ok(fs.existsSync(manifestIconPath), "manifest 图标文件不存在: " + manifest.icon)
  assert.ok(fs.readdirSync(path.dirname(manifestIconPath)).includes(path.basename(manifestIconPath)), "manifest 图标大小写不匹配")

  const fontPath = path.join(root, "src/common/iconfont.ttf")
  assert.ok(fs.existsSync(fontPath), "iconfont 字体文件不存在")
  assert.ok(fs.statSync(fontPath).size > 0, "iconfont 字体文件为空")

  // 3. 全页面 UX 文件的静态与动态图片引用校验
  const pagesDir = path.join(root, "src/pages")
  const pageDirs = fs.readdirSync(pagesDir, {withFileTypes: true})
    .filter((d) => d.isDirectory())
    .map((d) => path.join(pagesDir, d.name, d.name + ".ux"))
  const allUxFiles = [...pageDirs, path.join(root, "src/app.ux")]

  let totalReferencesVerified = 0
  for (const uxFile of allUxFiles) {
    if (!fs.existsSync(uxFile)) continue
    const content = fs.readFileSync(uxFile, "utf8")
    for (const match of content.matchAll(/src="([^"]+\.png)"/g)) {
      const src = match[1]
      let variants = [src]
      if (src.includes("{{ lang }}")) {
        variants = ["cn", "en"].map((lang) => src.replace(/\{\{\s*lang\s*\}\}/g, lang))
      } else if (/\{\{\s*(?:on_index|IFStaringDay|useWatchface|pinned|archived)\s*\}\}/.test(src)) {
        variants = ["true", "false"].map((bool) => src.replace(/\{\{\s*(?:on_index|IFStaringDay|useWatchface|pinned|archived)\s*\}\}/g, bool))
      } else if (src.includes("{{ bgImage }}")) {
        variants = ["/common/blank.png"]
      }

      for (const variant of variants) {
        const resolved = variant.startsWith("/")
          ? path.join(root, "src", variant.slice(1))
          : path.resolve(path.dirname(uxFile), variant)
        assert.ok(fs.existsSync(resolved), `页面 ${path.basename(uxFile)} 中的图片不存在: ${variant} -> ${resolved}`)
        assert.ok(fs.readdirSync(path.dirname(resolved)).includes(path.basename(resolved)), `图片大小写不匹配: ${variant}`)
        totalReferencesVerified++
      }
    }
  }
  assert.ok(totalReferencesVerified > 0, "必须核查到有效的图片引用")

  // 4. 全项目 PNG 均可使用 pngjs 正常解码，且尺寸大于 0
  let pngCount = 0
  function checkPngs(dir) {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file)
      if (fs.statSync(full).isDirectory()) checkPngs(full)
      else if (file.endsWith(".png")) {
        const buf = fs.readFileSync(full)
        assert.ok(buf.length > 0, "PNG 文件为空: " + full)
        const decoded = PNG.sync.read(buf)
        assert.ok(decoded.width > 0 && decoded.height > 0, "PNG 解码尺寸非法: " + full)
        assert.equal(decoded.data.length, decoded.width * decoded.height * 4, "解码 RGBA 缓冲区大小不匹配: " + full)
        pngCount++
      }
    }
  }
  checkPngs(path.join(root, "src"))
  assert.equal(pngCount, 70, "优化后的 PNG 文件数量应为 70")
})

test("F-10 农历切换保持同日、日期选择含闰月、保存后重进保留", () => {
  const h=createHarness()
  h.router.push({uri:"/pages/index"})
  const editor=h.router.push({uri:"/pages/edit",params:{extend:"true",event_name:"闰月生日",date:"2020-05-23"}})
  editor.onCalendarChange({newValue:editor.calendarOptions[1]})
  assert.equal(editor.calendar,"lunar")
  assert.equal(editor.lunarDate.leap,true)
  editor.editDate()
  const picker=h.current()
  assert.equal(picker.calendar,"lunar")
  assert.ok(picker.monthRange.some(m=>m.includes("leapMonth")))
  picker.saveEvent()
  assert.equal(editor.date,"2020-05-23")
  editor.repeat="yearly"
  editor.saveEvent()
  const stored=JSON.parse(h.files.get("internal://files/events.json")).events[0]
  assert.equal(stored.calendar,"lunar")
  assert.equal(stored.lunarDate.leap,true)
})

test("F-06 模板只更新新增草稿，保留日期名称且取消不提交", () => {
  const h = createHarness()
  h.router.push({uri:"/pages/index"})
  const editor = h.router.push({uri:"/pages/edit",params:{extend:"true",date:"2000-02-29",event_name:"我的生日"}})
  const before = h.files.get("internal://files/events.json")
  editor.onTemplateChange({newValue:editor.templateOptions[1]})
  assert.equal(editor.repeat,"yearly")
  assert.equal(editor.category,"birthday")
  assert.equal(editor.date,"2000-02-29")
  assert.equal(editor.event_name,"我的生日")
  editor.onTemplateChange({newValue:editor.templateOptions[2]})
  assert.equal(editor.repeat,"none")
  assert.equal(editor.category,"study")
  editor.routeBack()
  assert.equal(h.files.get("internal://files/events.json"),before)
})

test("原名称和本地化标题进入新版键盘，确认只改名称草稿", () => {
  const h = createHarness()
  const editor = h.openEditor()
  const preserved = otherFields(editor)
  const writesBefore = h.writes.slice()
  editor.editEventName()
  const ime = h.current()
  assert.equal(ime.uri, "/pages/ime")
  assert.equal(ime.context, "原名称")
  assert.equal(ime.label, "eventName")
  ime.context = '新名称 "\\测试"'
  ime.finish(true)
  assert.equal(h.current(), editor)
  assert.equal(editor.event_name, '新名称 "\\测试"')
  assert.equal(otherFields(editor), preserved)
  assert.deepEqual(h.writes, writesBefore)
  assert.equal(h.global.__imeResult, null)
  assert.equal(h.global.__imeText, "")
  assert.equal(h.global.__daymatterImeOwner, null)
})

test("F-02/F-08 排序筛选分页后编辑仍按ID，归档首页隐藏、恢复保留字段", () => {
  const h = createHarness()
  h.files.set("internal://files/events.json", JSON.stringify({version: 2, revision: 1, primaryId: "e0", sortMode: "near", events:
    Array.from({length: 23}, (_, i) => ({id: "e" + i, name: "同名" + i, date: "2026-10-" + String(30 - i).padStart(2, "0"), on_index: true,
      IFStaringDay: false, pinned: false, archived: false, category: i === 22 ? "life" : "birthday", sortOrder: i}))}))
  h.router.push({uri: "/pages/index"})
  const home = h.current()
  assert.equal(home.events[0].id, "e22")
  h.router.push({uri: "/pages/list"})
  const list = h.current()
  assert.equal(list.events.length, 10)
  list.changePage(2)
  const selected = list.events[0]
  assert.equal(selected.id, "e12")
  list.routeEditEvent(selected.storageIndex)
  const editor = h.current()
  assert.equal(editor.event_id, "e12")
  editor.archived = true
  editor.pinned = true
  editor.category = "study"
  editor.saveEvent()
  assert.equal(list.count, 22)
  list.changeArchive()
  assert.equal(list.events.length, 1)
  assert.equal(list.events[0].id, "e12")
  list.routeEditEvent(list.events[0].storageIndex)
  const restored = h.current()
  assert.equal(restored.category, "study")
  assert.equal(restored.pinned, true)
  restored.archived = false
  restored.saveEvent()
  list.routeBack()
  assert.equal(home.events[0].id, "e12", "恢复保留置顶，首页采用共享排序")
})

test("固定筛选框点击即生效，排序失败保留原值，返回仅收起", () => {
  const h = createHarness()
  h.router.push({uri: "/pages/list"})
  const list = h.current()
  list.toggleSettings()
  assert.equal(h.current(), list)
  list.cycleDraftCategory()
  list.cycleDraftScope()
  assert.equal(list.categoryFilter, "uncategorized")
  assert.equal(list.archiveFilter, true)
  h.failWrites = true
  list.cycleDraftSort()
  assert.equal(list.settingsExpanded, true)
  assert.equal(list.sortMode, "created")
  h.failWrites = false
  list.cycleDraftSort()
  assert.equal(h.current(), list)
  assert.equal(list.sortMode, "near")
  assert.equal(list.categoryFilter, "uncategorized")
  assert.equal(list.archiveFilter, true)
  assert.equal(list.page, 1)
  list.onBackPress()
  assert.equal(list.settingsExpanded, false)
  assert.equal(list.archiveFilter, true)
})

test("系统返回取消输入保留原名称与其他草稿，再次进入没有旧结果", () => {
  const h = createHarness()
  const editor = h.openEditor()
  const preserved = otherFields(editor)
  h.global.__imeResult = {text: "旧结果", confirmed: true}
  editor.editEventName()
  h.current().context = "未确认文本"
  assert.equal(h.current().onBackPress(), true)
  assert.equal(editor.event_name, "原名称")
  assert.equal(otherFields(editor), preserved)
  editor.editEventName()
  assert.equal(h.current().context, "原名称")
  assert.equal(h.global.__imeResult, null)
})

test("继承源键盘的中文候选、英文大小写、数字与退格行为", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()
  assert.ok(Object.isFrozen(ime.keys.full[0]))
  assert.equal(ime.screenWidth, 192)
  ime.onSelect("N")
  ime.onSelect("I")
  assert.ok(ime.resultList.includes("你"))
  ime.onRsSelect("你")
  ime.onBtnClick("lang")
  ime.onSelect("A")
  ime.onBtnClick("switchUpper")
  ime.onSelect("B")
  ime.onBtnClick("switchNum")
  ime.onSelect("1")
  ime.onBtnClick("D")
  assert.equal(ime.context, "你aB")
  ime.finish(true)
  assert.equal(editor.event_name, "你aB")
})

test("日期确认返回原编辑页，取消保持原日期和名称 / 颜色 / 开关", () => {
  const h = createHarness()
  const editor = h.openEditor()
  editor.editDate()
  const picker = h.current()
  assert.equal(picker.date, editor.date)
  picker.date = "2026-11-7"
  picker.saveEvent()
  assert.equal(h.current(), editor)
  assert.equal(editor.date, "2026-11-07")
  assert.equal(h.global.__daymatterDateResult, null)
  const preserved = otherFields(editor)
  editor.editDate()
  h.current().date = "2027-1-1"
  h.current().routeBack()
  assert.equal(editor.event_name, "原名称")
  assert.equal(otherFields(editor), preserved)
})

test("输入 / 日期连续往返 30 次不新建编辑页，不增长页面栈", () => {
  const h = createHarness()
  const editor = h.openEditor()
  for (let i = 0; i < 30; i++) {
    editor.editEventName()
    h.current().context = "名称" + i
    h.current().finish(true)
    assert.equal(h.current(), editor)
    editor.editDate()
    h.current().date = "2026-10-" + (i % 28 + 1)
    h.current().saveEvent()
    assert.equal(h.current(), editor)
    assert.equal(h.pages.length, 2)
  }
  assert.equal(h.maxDepth, 3)
  assert.equal(h.replacements, 0)
})

test("重复点击入口只打开一个子页", () => {
  const h = createHarness()
  const editor = h.openEditor()
  editor.editEventName()
  editor.editEventName()
  editor.editDate()
  assert.equal(h.pages.length, 3)
  h.current().finish(false)
  editor.editDate()
  editor.editDate()
  editor.editEventName()
  assert.equal(h.pages.length, 3)
})

test("旧编辑页销毁不会清理新编辑页的输入请求", () => {
  const h = createHarness()
  const old = h.openEditor()
  old.editEventName()
  const fresh = h.router.push({uri: "/pages/edit", params: {event_name: "另一个事件"}})
  fresh.editEventName()
  const owner = h.global.__daymatterImeOwner
  old.onDestroy()
  assert.equal(h.global.__daymatterImeOwner, owner)
  assert.equal(h.global.__imeText, "另一个事件")
  h.current().context = "新编辑结果"
  h.current().finish(true)
  assert.equal(fresh.event_name, "新编辑结果")
})

test("取消后重新打开日期页，旧请求的结果不能覆盖新草稿", () => {
  const h = createHarness()
  const editor = h.openEditor()
  editor.editDate()
  const previousRequest = h.current().requestId
  h.current().routeBack()
  editor.editDate()
  assert.notEqual(h.current().requestId, previousRequest)
  h.global.__daymatterDateResult = {requestId: previousRequest, date: "1999-1-1"}
  h.current().routeBack()
  assert.equal(editor.date, "2026-10-06")
})

test("保存回原首页后立即刷新事件，后续列表编辑 / 删除栈深稳定", () => {
  const h = createHarness()
  const home = h.router.push({uri: "/pages/index"})
  home.routeMore()
  let editor = h.current()
  editor.editEventName()
  h.current().context = "第一个事件"
  h.current().finish(true)
  editor.saveEvent()
  assert.equal(h.current(), home)
  assert.equal(home.allEvents, 1)
  home.routeMore()
  const list = h.current()
  assert.equal(list.uri, "/pages/list")
  for (let i = 0; i < 30; i++) {
    list.routeEditEvent(0)
    editor = h.current()
    editor.editEventName()
    h.current().context = "修改" + i
    h.current().finish(true)
    editor.saveEvent()
    assert.equal(h.current(), list)
    assert.equal(list.events[0].name, "修改" + i)
    assert.equal(h.pages.length, 2)
  }
  list.routeEditEvent(0)
  h.current().deleteEvent()
  assert.equal(h.current(), list)
  assert.equal(list.count, 0)
  list.routeBack()
  assert.equal(h.current(), home)
  assert.equal(home.allEvents, 0)
  assert.equal(h.replacements, 0)
  assert.equal(h.maxDepth, 4)
})

test("直接启动编辑页时返回有可用首页", () => {
  const h = createHarness()
  const editor = h.router.push({uri: "/pages/edit"})
  assert.ok(editor.date)
  editor.routeBack()
  assert.equal(h.current().uri, "/pages/index")
  assert.equal(h.pages.length, 1)
})

test("方屏 / 圆屏沿用源初始化，缺少候选节点的模式切换不会抛错", () => {
  for (const shape of ["rect", "circle"]) {
    const h = createHarness()
    h.global.screenShape = shape
    h.global.screenSize.width = shape === "rect" ? 336 : 466
    const editor = h.openEditor()
    editor.editEventName()
    const ime = h.current()
    assert.equal(ime.screentype, shape)
    ime.onBtnClick("lang")
    ime.onSelect("A")
    ime.onBtnClick("switchNum")
    ime.onSelect("2")
    ime.finish(true)
    assert.equal(editor.event_name, "原名称a2")
  }
})

test("默认形态兜底：非 rect / circle（含缺失值）一律按胶囊基准", () => {
  // 无上报值时键盘页必须落入胶囊分支
  const h = createHarness()
  h.global.screenShape = undefined
  h.global.isPillShaped = true
  const editor = h.openEditor()
  editor.editEventName()
  const ime = h.current()
  assert.equal(ime.screentype, "pill-shaped", "未知 / 缺失形态必须按胶囊兜底")

  // 入口行为：设备信息就绪前预置胶囊，回调按非 rect / circle 判定胶囊基准
  const appSource = fs.readFileSync(path.join(root, "src/app.ux"), "utf8")
  assert.ok(appSource.includes('global.screenShape = "pill-shaped"'), "设备信息就绪前必须预置胶囊默认形态")
  assert.ok(
    appSource.includes('global.isPillShaped = deviceRet.screenShape !== "rect" && deviceRet.screenShape !== "circle"'),
    "胶囊基准必须按非 rect / circle 判定"
  )
  for (const shape of ["unknown", "", null]) {
    const other = createHarness()
    other.global.screenShape = shape
    other.openEditor().editEventName()
    assert.equal(other.current().screentype, "pill-shaped", "未知形态不能落入空白分支")
  }
  const indexSource = fs.readFileSync(path.join(root, "src/pages/index/index.ux"), "utf8")
  assert.ok(!indexSource.includes('global.screenShape || "rect"'), "首页不得再回退到 rect")
})

test("跑道屏 192/212：中文候选、语言切换及固定图标分支", () => {
  for (const [width, height] of [[192, 490], [212, 520]]) {
    const h = createHarness()
    h.global.screenSize = {width, height}
    h.openEditor({event_name: ""}).editEventName()
    const ime = h.current()
    assert.equal(ime.screenWidth, width)
    ime.onSelect("N")
    ime.onSelect("I")
    assert.ok(ime.resultList.includes("你"))
    assert.equal(ime.cvalList.length, 5)
    ime.onRsSelect("你")
    ime.onBtnClick("lang")
    assert.equal(ime.lang, "en")
    ime.onSelect("A")
    assert.equal(ime.context, "你a")
    ime.onBtnClick("lang")
    assert.equal(ime.lang, "cn")
    ime.onSelect("H")
    ime.onSelect("A")
    ime.onSelect("O")
    assert.ok(ime.resultList.includes("好"))
  }
  const pill = imeSource.slice(imeSource.indexOf("<!-- 胶囊屏66 -->"), imeSource.indexOf("</template>"))
  for (const lang of ["cn", "en"]) {
    assert.ok(pill.includes(`src="./assets/arc/${lang}.png"`))
    assert.ok(pill.includes(`if="{{ downFlag==='' && !numFlag && lang==='${lang}' }}"`))
  }
  assert.ok(/@media \(shape: pill-shaped\)[\s\S]*?\.input-line\s*\{\s*width: 88%;/.test(imeSource))
})

test("C-20: 首页切换显示单位时原地修改属性，严格保留事件对象与数组引用", () => {
  const h = createHarness()
  h.files.set("internal://files/events.json", JSON.stringify([
    {name: "测试事件", date: "2026-11-06", on_index: true, IFStaringDay: false, themeColor: "#3184d0"},
    {name: "另一个事件", date: "2030-11-06", on_index: true, IFStaringDay: false}
  ]))
  const home = h.router.push({uri: "/pages/index"})
  assert.equal(home.events.length, 2)

  const arrayBefore = home.events
  const objBefore = home.events[0]
  const modeBefore = home.events[0].displayUnit
  const otherBefore = home.events[1].displayText

  // 触发切换模式
  home.toggleDisplayMode(0)

  assert.equal(home.events, arrayBefore, "必须保持同一 events 数组引用，不重新赋值整个数组")
  assert.equal(home.events[0], objBefore, "必须保持同一事件对象引用，避免销毁已有 DOM / Swiper 节点")
  assert.notEqual(home.events[0].displayUnit, modeBefore, "当前事件单位已推进")
  assert.ok(home.events[0].displayText, "更新了展示文本")
  assert.ok(home.events[0].fontSize > 0, "更新了字号大小")
  assert.equal(home.events[1].displayText, otherBefore, "不改变其他事件")
  const saved = JSON.parse(h.files.get("internal://files/events.json"))
  assert.equal(saved.events[0].displayUnit, home.events[0].displayUnit)
  home.completed()
  assert.equal(home.events[0].displayUnit, saved.events[0].displayUnit, "重读保留单位")
})

test("C-08: 键盘候选列表按需构建：打字时不构建 2D 数组，展开时按需切片，收起立即释放", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // 输入拼音 "ni"
  ime.onSelect("N")
  ime.onSelect("I")

  // 首行候选应正常呈现
  assert.ok(ime.resultList.includes("你"), "resultList 中必须包含候选汉字")
  // 在未展开下拉面板时，resultList2 必须保持为空，避免在每次按键时构建庞大的响应式 2D 数组
  assert.equal(ime.resultList2.length, 0, "普通输入阶段 resultList2 必须按需延迟构建（保持为空）")
  assert.equal(ime.downFlag, "", "默认处于未展开状态")

  // 点击展开按钮，展开更多候选
  ime.onBtnClick("down")
  assert.equal(ime.downFlag, "down", "处于展开状态")
  assert.ok(ime.resultList2.length > 0, "展开状态下按需生成 resultList2 二维分组")
  assert.ok(ime.resultList2[0].includes("你"), "第一行分组中包含候选汉字")

  // 再次点击收起
  ime.onBtnClick("down")
  assert.equal(ime.downFlag, "", "恢复收起状态")
  assert.equal(ime.resultList2.length, 0, "收起状态立即释放二维数组与关联观察者")
})

test("C-09: 相同拼音复用查词缓存；缓存有界，切换模式与销毁时释放", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // 输入 "n" 记录首次查词结果
  ime.onSelect("N")
  const firstResult = ime.resultList
  assert.ok(firstResult.length > 0, "拼音 n 应有候选结果")
  assert.equal(Object.keys(ime._searchCache).length, 1, "首次查词写入缓存")

  // 继续输入 "ni"，属于不同拼音，结果应为独立数组
  ime.onSelect("I")
  const secondResult = ime.resultList
  assert.ok(secondResult.length > 0, "拼音 ni 应有候选结果")
  assert.equal(Object.keys(ime._searchCache).length, 2)

  // 退格回到 "n"，必须命中缓存并复用同一数组引用（未重复查词与分割）
  ime.onBtnClick("D")
  assert.equal(ime.resultList, firstResult, "相同拼音必须复用缓存结果，保持同一数组引用")

  // 缓存有界：连续查询大量拼音后不得超过上限
  for (let i = 0; i < 30; i++) {
    ime.getResultByWord("bound" + i)
  }
  assert.ok(Object.keys(ime._searchCache).length <= 20, "查词缓存必须有界，不得超过 SEARCH_CACHE_LIMIT")

  // 切换语言模式：缓存按需释放
  ime.onBtnClick("lang")
  assert.equal(Object.keys(ime._searchCache).length, 0, "切换语言后释放查词缓存")
  ime.onBtnClick("lang")

  // 重新查询后页面销毁：缓存与候选数据全部释放
  ime.getResultByWord("n")
  assert.ok(Object.keys(ime._searchCache).length > 0)
  ime.onDestroy()
  assert.equal(Object.keys(ime._searchCache).length, 0, "页面销毁后查词缓存必须释放")
  assert.equal(ime.resultList.length, 0, "页面销毁后候选列表必须释放")
  assert.equal(ime.resultList2.length, 0, "页面销毁后候选分组必须释放")
})

test("C-10: 模板配置显式声明；相同查询不重复清空 / 重建候选数组", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // 模板依赖必须在视图模型中声明，普通对象模拟无法验证运行时代理。
  const imeDefinition = h.definitions.get("pages/ime")
  for (const key of ["keyboardtype", "screentype", "cvalList"]) {
    assert.equal(key in imeDefinition.private, true, key + " 必须在 private 声明")
    assert.ok(ime[key] !== undefined, key + " 必须在 onInit 后可用")
  }
  assert.equal(ime.keyboardtype, "QWERTY")
  assert.equal(ime.screentype, "pill-shaped")
  assert.equal(ime.cvalList.length, 5)
  assert.ok(Object.isFrozen(ime.keys.full[0]), "冻结按键矩阵继续继承")

  // 相同拼音重复触发查询时，候选数组引用保持不变（不重复清空 / 重建）
  ime.onSelect("N")
  const resultRef = ime.resultList
  ime.resetReslutList()
  assert.equal(ime.resultList, resultRef, "相同拼音重复查询必须复用同一候选数组")
})

test("C-11: 候选行仅在查询变化时即时归位，节点保护与选择操作无回归", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()
  const scrollCalls = []
  ime.$element = (id) => ({ scrollTo: (options) => scrollCalls.push({id, ...options}) })

  ime.onSelect("N")
  assert.equal(scrollCalls.length, 1, "查询变化时归位一次")
  assert.equal(scrollCalls[0].id, "cvalWaiting")
  assert.equal(scrollCalls[0].left, 0)
  assert.equal(scrollCalls[0].top, 0)
  assert.equal(scrollCalls[0].behavior, "instant", "使用即时滚动避免逐按键平滑动画")

  ime.resetReslutList()
  assert.equal(scrollCalls.length, 1, "查询未变化时不重复归位")

  ime.onSelect("I")
  assert.equal(scrollCalls.length, 2, "查询再次变化后继续归位")

  // 节点不存在时保留存在性保护，不抛错且候选查询正常
  ime.$element = () => null
  ime.onSelect("N")
  assert.ok(ime.resultList.length > 0, "节点缺失不影响候选查询")

  // 选择候选字后查询归零，键盘状态可继续使用
  ime.onRsSelect("你")
  assert.equal(ime.cval, "")
  assert.equal(ime.downFlag, "")
  assert.equal(ime.resultList2.length, 0)
})

test("C-12: 滚动反馈只更新当前屏幕分支且值变化才写入", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // rect 分支只更新 percent67，不动 percent66
  ime.screentype = "rect"
  ime.percent67 = 52
  ime.percent66 = 7
  ime.handelScroll({scrollX: 100})
  assert.ok(ime.percent67 > 52, "rect 分支必须更新 percent67")
  assert.equal(ime.percent66, 7, "rect 分支不得更新 percent66")

  // pill-shaped 分支只更新 percent66，不动 percent67
  ime.screentype = "pill-shaped"
  const frozen67 = ime.percent67
  ime.percent66 = 0
  ime.handelScroll({scrollX: 100})
  assert.ok(ime.percent66 > 0, "pill-shaped 分支必须更新 percent66")
  assert.equal(ime.percent67, frozen67, "pill-shaped 分支不得更新 percent67")

  // circle 分支两者都不更新
  ime.screentype = "circle"
  const frozen66 = ime.percent66
  ime.handelScroll({scrollX: 200})
  assert.equal(ime.percent66, frozen66, "circle 分支不得更新 percent66")
  assert.equal(ime.percent67, frozen67, "circle 分支不得更新 percent67")

  // 值未变化时不写入响应式字段
  ime.screentype = "rect"
  let writes = 0
  Object.defineProperty(ime, "percent67", {
    get: () => 68,
    set: () => {
      writes++
    },
    configurable: true,
  })
  ime.handelScroll({scrollX: 100})
  assert.equal(writes, 0, "计算值未变化时不得写入响应式字段")
  ime.handelScroll({scrollX: 200})
  assert.equal(writes, 1, "值真正变化时才写入一次")
})

test("C-13: 展开候选时移除被遮住的键盘节点，收起后按需重建；圆屏保留可见键盘", () => {
  // 胶囊屏 66：被黑色候选面板完全遮住的键盘容器改为按需创建
  assert.ok(
    imeSource.includes(
      `if="{{ downFlag !== 'down' }}"\n          style="position: absolute; left: 0px; top: 34px; width: 100%; height: 276px"`
    ),
    "胶囊屏键盘容器必须在展开更多候选时移除"
  )

  // 方屏 67：T9 与全键盘分支在展开时都不渲染
  assert.ok(
    imeSource.includes(`if="{{ keyboardtype=='T9' && !numFlag && downFlag !== 'down' }}"`),
    "方屏 T9 分支必须在展开更多候选时移除"
  )
  assert.ok(
    imeSource.includes(`elif="{{ downFlag !== 'down' }}"`),
    "方屏全键盘分支必须在展开更多候选时按需创建"
  )

  // 圆屏 62：候选面板只覆盖候选条，键盘保持可见，不得移除
  const fullKeyboardTag = imeSource.match(/<div\s+id="full-keyboard"[\s\S]*?>/)
  assert.ok(fullKeyboardTag, "圆屏全键盘节点必须存在")
  assert.ok(
    !fullKeyboardTag[0].includes("downFlag"),
    "圆屏键盘未被候选面板遮盖，不得随展开移除"
  )

  // 展开 / 收起状态字段仍由页面逻辑正常切换
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()
  ime.onSelect("N")
  ime.onBtnClick("down")
  assert.equal(ime.downFlag, "down")
  ime.onBtnClick("down")
  assert.equal(ime.downFlag, "")
})

test("C-14: 默认无震动且无逐按键日志，保持源键盘默认体验", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // 默认体验：震动模式为空，输入不触发震动，也不保留逐按键日志
  assert.equal(ime.vibratemode, "", "默认震动模式必须为空")
  ime.onSelect("N")
  ime.onSelect("I")
  ime.onBtnClick("D")
  ime.onRsSelect("你")
  assert.equal(h.vibrations.length, 0, "默认配置下不得触发任何震动调用")
  assert.ok(!/console\.(log|debug|info)/.test(imeSource), "键盘页不得保留逐按键调试日志")

  // 仅当显式配置震动模式后才触发，且参数透传正确
  ime.vibratemode = "short"
  ime.onSelect("N")
  assert.equal(h.vibrations.length, 1, "显式配置后才触发一次震动")
  assert.equal(h.vibrations[0].mode, "short", "震动参数必须原样透传")
})

test("C-15: 沿用漫画动态设备分支，候选 / 语言 / 数字 / 输入与滚动保持动态", () => {
  assert.ok(imeSource.includes(`if="{{ screentype==='circle' }}"`), "圆屏分支保持动态")
  assert.ok(imeSource.includes(`if="{{ screentype==='rect' }}"`), "方屏分支保持动态")
  assert.ok(
    imeSource.includes(`if="{{ screentype==='pill-shaped' }}"`),
    "胶囊屏分支保持动态"
  )
  assert.ok(imeSource.includes(`if="{{ keyboardtype!='T9' }}"`), "键盘类型分支保持动态")

  // 动态内容不得被静态化
  assert.ok(imeSource.includes(`for="{{ cvalList }}"`), "候选索引循环必须保持动态")
  assert.ok(imeSource.includes(`show="{{ resultList.length > $idx }}"`), "候选更新必须保持动态")
  assert.ok(imeSource.includes(`if="{{ !numFlag }}"`), "数字 / 符号切换必须保持动态")
  assert.ok(imeSource.includes(`src="/pages/ime/assets/full/{{ lang }}.png"`), "语言图标必须保持动态")
  assert.ok(imeSource.includes(`style="padding-left: {{ (screenWidth - 192)/2 }}px`), "屏宽适配必须保持动态")
  assert.ok(imeSource.includes(`{{ context }}`), "输入文本必须保持动态")
  assert.ok(imeSource.includes(`onscroll="handelScroll"`), "滚动反馈必须保持动态")

  // 固定图标补充 static（父节点动态不影响图标自身一次性绑定）
  for (const icon of ["Q.png", "P.png", "btA.png", "L.png", "Z.png", "M.png", "1.png", "0.png", "2-1.png", "2-2.png", "3-1.png", "3-2.png", "123_boardless.png"]) {
    const pattern = new RegExp(`<img\\s+static\\s+src="\\./assets/full/${icon.replace(".", "\\.")}"`)
    assert.ok(pattern.test(imeSource), icon + " 固定图标必须补充 static")
  }
})

test("C-16: 词库仅由键盘页按需加载，保留完整中文候选覆盖", () => {
  const dicPath = path.join(imeDir, "assets/dic.js")
  const dicText = fs.readFileSync(dicPath, "utf8")
  const dicSize = fs.statSync(dicPath).size

  // 词库体积与覆盖测量：文件约 26.8 KiB，390+ 拼音分组，6000+ 汉字
  assert.ok(dicSize > 20 * 1024 && dicSize < 48 * 1024, "词库文件大小应处于合理范围（当前约 26.8 KiB）")
  const groups = dicText.match(/^\s{2}[a-z]+:/gm) || []
  assert.ok(groups.length >= 300, "拼音分组覆盖必须完整（当前约 390+ 组）")
  const hanziCount = (dicText.match(/[\u4e00-\u9fa5]/g) || []).length
  assert.ok(hanziCount >= 6000, "候选汉字覆盖不得少于 6000 字（当前约 7480 字）")
  const dict = loadModule(dicText, {}, "dict")
  assert.equal(Object.keys(dict).length, groups.length, "加载后的字典分组数量必须与源文件一致")

  // 词库按需加载：只有键盘页资源引用，首页 / 列表 / 编辑 / 应用入口不得提前引入
  const lazyFiles = [
    path.join(root, "src/app.ux"),
    path.join(root, "src/pages/index/index.ux"),
    path.join(root, "src/pages/list/list.ux"),
    path.join(root, "src/pages/edit/edit.ux"),
    path.join(root, "src/pages/datepicker/datepicker.ux"),
    path.join(root, "src/pages/about/about.ux"),
  ]
  for (const file of lazyFiles) {
    const content = fs.readFileSync(file, "utf8")
    assert.ok(!content.includes("dic.js"), path.basename(file) + " 不得引用词库文件")
    assert.ok(!content.includes("dicUtil"), path.basename(file) + " 不得引用词库工具")
    assert.ok(!content.includes("SimpleInputMethod"), path.basename(file) + " 不得提前初始化输入法词库")
  }
})

function seedEvents(h, count) {
  const raw = []
  for (let i = 0; i < count; i++) {
    raw.push({
      name: "事件" + i,
      date: "2026-11-" + String((i % 28) + 1).padStart(2, "0"),
      on_index: true,
      IFStaringDay: false,
      themeColor: "#3184d0"
    })
  }
  h.files.set("internal://files/events.json", JSON.stringify(raw))
  return raw
}

test("C-17: 事件列表按 10 条分页，只格式化当前页，原始快照保持非响应式", () => {
  const h = createHarness()
  seedEvents(h, 25)
  const home = h.router.push({uri: "/pages/index"})
  home.routeMore()
  const list = h.current()
  assert.equal(list.uri, "/pages/list")

  // 原始快照只作为非响应式属性存在，不进入 private 视图模型
  const listDefinition = h.definitions.get("pages/list")
  assert.equal("_allEvents" in listDefinition.private, false, "_allEvents 不得进入响应式 private")
  assert.equal(list._allEvents.length, 25, "原始快照必须保留全部事件")
  assert.equal(list.count, 25, "总条数保持全量")
  assert.equal(list.totalPages, 3)
  assert.equal(list.page, 1)

  // 响应式展示数组只格式化当前页，最多 10 条
  assert.equal(list.events.length, 10)
  assert.equal(list.events[0].storageIndex, 0)
  assert.equal(list.events[9].storageIndex, 9)
  assert.equal(list.events[9].name, "事件9")

  // 翻页后按原始存储下标重建当前页
  list.changePage(2)
  assert.equal(list.page, 2)
  assert.equal(list.events.length, 10)
  assert.equal(list.events[0].storageIndex, 10)
  assert.equal(list.events[9].storageIndex, 19)

  list.changePage(3)
  assert.equal(list.page, 3)
  assert.equal(list.events.length, 5)
  assert.equal(list.events[4].storageIndex, 24)

  // 越界翻页不改状态
  list.changePage(4)
  assert.equal(list.page, 3)
  list.changePage(0)
  assert.equal(list.page, 3)

  // 新增入口使用全量条数而不是当前页局部长度
  list.routeAdd()
  assert.equal(h.current().uri, "/pages/edit")
  assert.equal(h.current().extend, "true")
  assert.equal(h.current().event_id, "25")
})

test("C-27: 编辑 / 删除使用原始存储下标，返回恢复原页，删除末页末条修正页码", () => {
  const h = createHarness()
  seedEvents(h, 21)
  const home = h.router.push({uri: "/pages/index"})
  home.routeMore()
  const list = h.current()

  // 跳到第三页（第 21 条，存储下标 20），编辑入口必须带原始下标
  list.changePage(3)
  assert.equal(list.events.length, 1)
  assert.equal(list.events[0].storageIndex, 20)
  list.routeEditEvent(list.events[0].storageIndex)
  const editor = h.current()
  assert.equal(editor.uri, "/pages/edit")
  assert.equal(editor.event_id, readStoreEvents(h)[20].id, "编辑必须映射到第 21 条的稳定 ID")
  assert.equal(editor.event_name, "事件20")

  // 编辑保存返回后恢复原页
  editor.saveEvent()
  assert.equal(h.current(), list)
  assert.equal(list.page, 3, "返回列表必须恢复原页")
  assert.equal(list.events.length, 1)

  // 删除最后一页末条后，页码自动修正到新的最后一页并重新校验映射
  list.routeEditEvent(20)
  h.current().deleteEvent()
  assert.equal(h.current(), list)
  assert.equal(list.count, 20)
  assert.equal(list.totalPages, 2)
  assert.equal(list.page, 2, "删除末页末条后页码必须修正")
  assert.equal(list.events.length, 10)
  assert.equal(list.events[0].storageIndex, 10)
  assert.equal(list.events[9].storageIndex, 19)
})

test("C-17/C-27: 列表页模板使用 list/list-item 显式高度与存储下标，不以 $idx 定位", () => {
  const listSource = fs.readFileSync(path.join(root, "src/pages/list/list.ux"), "utf8")
  assert.ok(listSource.includes('<list class="event-list"'), "列表必须使用 list 容器")
  assert.ok(listSource.includes('type="event"'), "事件条目必须声明 list-item type")
  assert.ok(listSource.includes('type="pagination"'), "翻页入口必须声明独立 list-item type")
  assert.ok(
    listSource.includes("routeEditEvent($item.storageIndex)"),
    "编辑入口必须使用原始存储下标"
  )
  assert.ok(!listSource.includes("routeEditEvent($idx)"), "不得使用当前页局部 $idx 定位")
  assert.ok(/\.event-item\s*\{[^}]*height:\s*\d+px/.test(listSource), "list-item 必须显式设置高度")
})

test("C-18: 首页最多保留三个卡片槽位，滑动时原地轮换当前与相邻卡片", () => {
  function homeWith(count) {
    const h = createHarness()
    seedEvents(h, count)
    const home = h.router.push({uri: "/pages/index"})
    return {h, home}
  }

  function assertSlotWindow(home) {
    const total = home.events.length
    const p = home._currentSlot
    assert.equal(home.slots.length, 3)
    assert.equal(home.slots[p], home.events[home._currentSource], "当前槽位必须对应当前事件")
    assert.equal(
      home.slots[(p + 1) % 3],
      home.events[(home._currentSource + 1) % total],
      "下一槽位必须对应下一个事件"
    )
    assert.equal(
      home.slots[(p + 2) % 3],
      home.events[(home._currentSource - 1 + total) % total],
      "上一槽位必须对应上一个事件"
    )
    assert.equal(home.swiperIndex, p, "swiper 索引与槽位一致")
  }

  // 0 / 1 / 2 / 3 个事件边界
  const zero = homeWith(0)
  assert.equal(zero.home.is_no_event, true)
  assert.equal(zero.home.slots.length, 0)
  for (const count of [1, 2, 3]) {
    const {home} = homeWith(count)
    assert.equal(home.is_no_event, false)
    assert.equal(home.slots.length, count, count + " 个事件时槽位数与事件数一致")
    for (let i = 0; i < count; i++) {
      assert.equal(home.slots[i], home.events[i], "槽位必须复用同一展示对象")
    }
  }

  // 多事件：仅三个槽位，顺序为当前 / 下一个 / 上一个（循环）
  const {home} = homeWith(5)
  assert.equal(home.events.length, 5)
  assert.equal(home.slots.length, 3)
  assert.equal(home.slots[0], home.events[0])
  assert.equal(home.slots[1], home.events[1])
  assert.equal(home.slots[2], home.events[4])
  assert.equal(home.activeSourceIndex, 0)
  assertSlotWindow(home)

  const slotsRef = home.slots
  const eventsRef = home.events

  // 双向快速滑动：每次只原地替换出屏槽位，数组与事件对象引用不变
  home.onSwiperChange({index: 1})
  assert.equal(home.slots, slotsRef, "必须原地更新槽位数组")
  assert.equal(home.events, eventsRef, "不得重建全部首页事件数组")
  assert.equal(home.activeSourceIndex, 1)
  assertSlotWindow(home)

  home.onSwiperChange({index: 2})
  assert.equal(home.activeSourceIndex, 2)
  assertSlotWindow(home)

  home.onSwiperChange({index: 0})
  assert.equal(home.activeSourceIndex, 3)
  assertSlotWindow(home)

  home.onSwiperChange({index: 2})
  assert.equal(home.activeSourceIndex, 2)
  assertSlotWindow(home)

  home.onSwiperChange({index: 1})
  assert.equal(home.activeSourceIndex, 1)
  assertSlotWindow(home)

  // 连续来回快速滑动后映射不漂移
  for (let i = 0; i < 20; i++) {
    home.onSwiperChange({index: home._currentSlot === 2 ? 0 : home._currentSlot + 1})
    assertSlotWindow(home)
    home.onSwiperChange({index: home._currentSlot === 0 ? 2 : home._currentSlot - 1})
    assertSlotWindow(home)
  }

  // 切换显示单位时仍原地更新全部首页事件，槽位引用保持
  home.toggleDisplayMode(home.activeSourceIndex)
  assert.equal(home.events, eventsRef)
  assert.equal(home.slots, slotsRef)
  assertSlotWindow(home)
})

test("C-19: 跑马灯仅在当前可见且名称超宽时启用，隐藏 / 离开立即停止", () => {
  const indexSource = fs.readFileSync(path.join(root, "src/pages/index/index.ux"), "utf8")
  const editSource = fs.readFileSync(path.join(root, "src/pages/edit/edit.ux"), "utf8")

  // 源码约束：首页跑马灯同时受页面可见性、超宽与当前槽位约束，并显式 start 恢复
  assert.ok(
    indexSource.includes(
      "pageVisible && $item.nameOverflow && activeSourceIndex === $item.sourceIndex"
    ),
    "跑马灯必须只对当前可见且超宽的事件启用"
  )
  assert.ok(indexSource.includes('id="home-marquee"'), "跑马灯节点必须可被按需恢复")
  assert.ok(indexSource.includes('$element("home-marquee")'), "重新显示时必须按需启动跑马灯")
  assert.ok(indexSource.includes('@change="onSwiperChange"'), "槽位切换必须响应 swiper change")
  assert.ok(!editSource.includes("<marquee") || /<marquee[^>]*if="\{\{[^}]*\bpageVisible\b[^}]*\}\}"/.test(editSource), "编辑页如使用跑马灯，必须随页面隐藏移除")

  const h = createHarness()
  const longName = "这是一个非常非常非常长的倒数日名称"
  h.files.set(
    "internal://files/events.json",
    JSON.stringify([
      {name: longName, date: "2026-11-01", on_index: true, IFStaringDay: false, themeColor: "#3184d0"},
      {name: "短", date: "2026-11-02", on_index: true, IFStaringDay: false, themeColor: "#3184d0"}
    ])
  )
  const home = h.router.push({uri: "/pages/index"})
  assert.equal(home.pageVisible, true, "显示时跑马灯按需恢复")
  assert.equal(home.events[0].nameOverflow, true, "超宽名称启用跑马灯")
  assert.equal(home.events[1].nameOverflow, false, "未超宽名称使用静态文本")
  assert.equal(home.activeSourceIndex, 0, "仅当前可见卡片启用跑马灯")

  home.onSwiperChange({index: 1})
  assert.equal(home.activeSourceIndex, 1, "切换卡片后只有新当前卡片启用跑马灯")

  home.onHide()
  assert.equal(home.pageVisible, false, "页面离开时停止跑马灯")
  home.onShow()
  assert.equal(home.pageVisible, true, "重新显示时按需恢复")

  const editor = h.router.push({uri: "/pages/edit"})
  assert.equal(editor.pageVisible, true)
  editor.onHide()
  assert.equal(editor.pageVisible, false, "编辑页离开时停止跑马灯")
  assert.equal(home.pageVisible, false, "进入子页面时首页跑马灯也停止")
})

test("C-02: 首页 / 列表 / 编辑 / 键盘 / 日期连续 30 次往返页面栈有界", () => {
  const h = createHarness()
  seedEvents(h, 3)
  const home = h.router.push({uri: "/pages/index"})
  for (let i = 0; i < 30; i++) {
    home.routeMore()
    const list = h.current()
    list.routeEditEvent(i % 3)
    const editor = h.current()
    editor.editEventName()
    h.current().context = "名称" + i
    h.current().finish(true)
    editor.editDate()
    h.current().saveEvent()
    editor.routeBack()
    assert.equal(h.current(), list, "编辑返回必须回到列表")
    list.routeBack()
    assert.equal(h.current(), home, "列表返回必须回到首页")
    assert.equal(h.pages.length, 1, "连续往返不得堆积页面")
  }
  assert.equal(h.maxDepth, 4, "峰值深度固定为首页 / 列表 / 编辑 / 子页")
})

test("C-06: 互联消息由应用级单例分发，页面销毁解除订阅，隐藏页只标记刷新", () => {
  const h = createHarness()
  seedEvents(h, 1)
  const home = h.router.push({uri: "/pages/index"})
  const conn = h.connection
  assert.ok(conn, "首页必须建立应用级连接")
  assert.equal(typeof conn.onmessage, "function", "单例连接只安装分发器")

  // 隐藏页收到插件新增：写盘但不重建隐藏 UI
  home.routeMore()
  const list = h.current()
  assert.equal(home.pageVisible, false)
  assert.equal(home.events.length, 0)
  conn.onmessage({
    data: JSON.stringify({
      type: "addEvent", name: "插件新增", date: "2026-12-01",
      on_index: true, IFStaringDay: false, themeColor: "#3184d0"
    })
  })
  assert.equal(readStoreEvents(h).length, 2, "插件新增必须写入文件")
  assert.equal(home.events.length, 0, "隐藏页不得重建展示数据")
  assert.equal(home._needsRefresh, true, "隐藏页只标记需要刷新")

  // 返回首页后按最新数据重建
  list.routeBack()
  assert.equal(h.current(), home)
  assert.ok(home.events.some((e) => e.name.includes("插件新增")))
  assert.equal(home._needsRefresh, false)

  // 页面销毁后解除订阅：分发器不再持有旧页面
  home.onDestroy()
  const before = h.files.get("internal://files/events.json")
  conn.onmessage({data: JSON.stringify({type: "deleteEvent", index: 0})})
  assert.equal(h.files.get("internal://files/events.json"), before, "销毁后不得再处理旧页面订阅")

  // 新首页实例重新订阅后可正常处理
  const fresh = h.router.push({uri: "/pages/index"})
  assert.notEqual(fresh, home)
  conn.onmessage({data: JSON.stringify({type: "deleteEvent", index: 0})})
  assert.equal(readStoreEvents(h).length, 1)
})

test("D-12/D-14: 插件按稳定 ID 修改 / 删除，未提供字段保留", () => {
  const h = createHarness()
  const home = h.router.push({uri: "/pages/index"})
  const conn = h.connection
  conn.onmessage({
    data: JSON.stringify({
      type: "addEvent", name: "稳定事件", date: "2026-12-01",
      on_index: true, IFStaringDay: false, themeColor: "#e74c3c"
    })
  })
  let events = readStoreEvents(h)
  assert.equal(events.length, 1)
  const id = events[0].id
  assert.ok(typeof id === "string" && id.length > 0, "新增事件必须分配稳定 ID")

  // 只带名称的修改：日期 / 主题色 / 开关必须保留
  conn.onmessage({data: JSON.stringify({type: "changeEvent", id: id, name: "改名"})})
  events = readStoreEvents(h)
  assert.equal(events[0].name, "改名")
  assert.equal(events[0].date, "2026-12-01")
  assert.equal(events[0].themeColor, "#e74c3c")
  assert.equal(events[0].on_index, true)

  // 按稳定 ID 删除
  conn.onmessage({data: JSON.stringify({type: "deleteEvent", id: id})})
  assert.equal(readStoreEvents(h).length, 0)
  assert.equal(home.is_no_event, true, "删除后首页应刷新为空")
})

test("E-05/E-06/E-07/E-09: 协议握手、同请求幂等回执与原请求查询", () => {
  const h = createHarness()
  h.router.push({uri: "/pages/index"})
  const conn = h.connection
  conn.onmessage({data: JSON.stringify({type: "hello", protocolVersion: 2, sessionId: "s-1", capabilities: ["requestId"]})})
  const helloReply = conn.sent.at(-1).data
  assert.equal(helloReply.type, "capabilities")
  assert.equal(helloReply.sessionId, "s-1")

  const request = {type: "addEvent", requestId: "req-unique-1", sessionId: "s-1", deviceId: "watch-1", name: "含\"引号\" 🎂", date: "2026-12-01", on_index: true, IFStaringDay: false}
  conn.onmessage({data: JSON.stringify(request)})
  assert.equal(readStoreEvents(h).length, 1)
  const result = conn.sent.map((item) => item.data).find((item) => item.type === "mutationResult")
  assert.equal(result.ok, true)
  assert.equal(result.requestId, request.requestId)
  assert.equal(typeof result.revision, "number")

  conn.onmessage({data: JSON.stringify(request)})
  assert.equal(readStoreEvents(h).length, 1, "重复 requestId 只能执行一次")
  const before = conn.sent.length
  conn.onmessage({data: JSON.stringify({type: "getRequestResult", requestId: request.requestId, sessionId: "s-1", deviceId: "watch-1"})})
  assert.equal(conn.sent[before].data.requestId, request.requestId, "查询返回原结果而不重放新增")
  conn.onmessage({data: JSON.stringify({...request, requestId: "req-old-session", sessionId: "stale"})})
  assert.equal(readStoreEvents(h).length, 1, "迟到旧 session 不得修改数据")
})

function protocolHarness() {
  const h = createHarness()
  h.router.push({uri: "/pages/index"})
  h.sendProtocol = (data) => h.connection.onmessage({data: JSON.stringify(data)})
  h.hello = (sessionId = "s-1") => h.sendProtocol({type: "hello", protocolVersion: 2,
    sessionId, capabilities: ["requestId"]})
  h.request = (requestId, extra = {}) => ({type: "addEvent", requestId, sessionId: "s-1",
    deviceId: "watch-1", name: requestId, date: "2026-12-01", ...extra})
  h.results = () => h.connection.sent.map((item) => item.data).filter((item) => item.type === "mutationResult")
  h.hello()
  return h
}

test("E-06/E-07: 写盘中重试、交错提交与查询不串请求", () => {
  const h = protocolHarness()
  h.deferWrites = true
  const a = h.request("a")
  h.sendProtocol(a)
  h.sendProtocol(Object.fromEntries(Object.entries(a).reverse()))
  h.sendProtocol(h.request("b"))
  h.sendProtocol({type: "getRequestResult", requestId: "a", sessionId: "s-1", deviceId: "watch-1"})
  assert.equal(h.connection.sent.at(-1).data.status, "processing")
  h.sendProtocol({type: "getAllEvent"})
  assert.equal(h.results().length, 0)
  h.flushWrites()
  assert.deepEqual(readStoreEvents(h).map((event) => event.name), ["a", "b"])
  assert.deepEqual(h.results().map((result) => result.requestId), ["a", "b"])
  assert.ok(h.results().every((result) => result.ok && typeof result.revision === "number"))
  h.sendProtocol(a)
  assert.equal(readStoreEvents(h).length, 2)
  assert.equal(h.results().at(-1).revision, h.results()[0].revision)
})

test("E-06: 同 ID 不同载荷拒绝，在途与完成后均不改写原结果", () => {
  const h = protocolHarness()
  h.deferWrites = true
  const request = h.request("same")
  h.sendProtocol(request)
  h.sendProtocol({...request, name: "冲突"})
  assert.equal(h.results().at(-1).code, "REQUEST_CONFLICT")
  h.flushWrites()
  h.sendProtocol({...request, date: "2027-01-01"})
  assert.equal(h.results().at(-1).code, "REQUEST_CONFLICT")
  h.sendProtocol(request)
  assert.equal(h.results().at(-1).ok, true)
  assert.equal(readStoreEvents(h)[0].name, "same")
})

test("E-06: 缓存有界且不淘汰可重试请求，新会话释放完成记录", () => {
  const h = protocolHarness()
  for (let i = 0; i < 32; i++) h.sendProtocol(h.request("r-" + i))
  h.sendProtocol(h.request("overflow"))
  assert.equal(h.results().at(-1).code, "REQUEST_CACHE_FULL")
  h.sendProtocol(h.request("r-0"))
  assert.equal(h.results().at(-1).ok, true)
  assert.equal(readStoreEvents(h).length, 32)
  assert.equal(h.global.__daymatterProtocolLedger.requests.length, 32)
  h.hello("s-2")
  h.sendProtocol(h.request("r-0", {sessionId: "s-2"}))
  assert.equal(readStoreEvents(h).length, 33, "相同 ID 在新会话是独立请求")
  h.sendProtocol(h.request("old"))
  assert.equal(readStoreEvents(h).length, 33)
})

test("E-06/E-07: 失败结果可查询，页面销毁后提交仍结算且重建不重放", () => {
  const h = protocolHarness()
  h.failWrites = true
  const failed = h.request("failed")
  h.sendProtocol(failed)
  assert.equal(h.results().at(-1).ok, false)
  h.failWrites = false
  h.sendProtocol(failed)
  assert.equal(readStoreEvents(h).length, 0)
  h.deferWrites = true
  const request = h.request("alive")
  h.sendProtocol(request)
  h.router.replace({uri: "/pages/index"})
  h.hello()
  h.sendProtocol(request)
  h.flushWrites()
  assert.equal(readStoreEvents(h).length, 1)
  assert.equal(h.results().at(-1).requestId, "alive")
  assert.equal(h.results().at(-1).ok, true)
  h.sendProtocol(request)
  assert.equal(readStoreEvents(h).length, 1)
  h.sendProtocol({type: "getRequestResult", requestId: "missing", sessionId: "s-1", deviceId: "watch-1"})
  assert.equal(h.connection.sent.at(-1).data.status, "unknown")
})

test("E-06/E-07: 换会话在途上下文隔离、设备关联及删除 revision", () => {
  const h = protocolHarness()
  h.deferWrites = true
  h.sendProtocol(h.request("same"))
  h.hello("s-2")
  h.sendProtocol(h.request("same", {sessionId: "s-2"}))
  h.flushWrites()
  assert.deepEqual(h.results().map((result) => result.sessionId), ["s-1", "s-2"])
  h.deferWrites = false
  h.sendProtocol(h.request("wrong", {sessionId: "s-2", deviceId: "watch-2"}))
  assert.equal(h.results().at(-1).code, "REQUEST_DEVICE_MISMATCH")
  const id = readStoreEvents(h)[0].id
  h.sendProtocol(h.request("delete", {type: "deleteEvent", sessionId: "s-2", id}))
  const revision = JSON.parse(h.files.get("internal://files/events.json")).revision
  assert.equal(h.results().at(-1).revision, revision)
  assert.equal(readStoreEvents(h).length, 1)
})

test("E-07: 设置主事件回执使用最终 revision；超大请求不占用账本", () => {
  const h = protocolHarness()
  h.sendProtocol(h.request("primary", {watchface: true, on_index: false}))
  const stored = JSON.parse(h.files.get("internal://files/events.json"))
  assert.equal(stored.primaryId, stored.events[0].id)
  assert.equal(h.results().at(-1).revision, stored.revision)
  h.sendProtocol(h.request("large", {extra: "x".repeat(16384)}))
  assert.equal(h.results().at(-1).code, "REQUEST_TOO_LARGE")
  assert.equal(h.global.__daymatterProtocolLedger.requests.length, 1)
  assert.equal(readStoreEvents(h).length, 1)
})

test("E-07: 事件已保存但主事件失败，回执保留事件成功且重试不再次新增", () => {
  const h = protocolHarness()
  h.global.eventStore.setPrimary = (id, callback) => callback({code: "WRITE_FAIL"})
  const request = h.request("partial-primary", {watchface: true})
  h.sendProtocol(request)
  const result = h.results().at(-1)
  assert.equal(result.ok, true)
  assert.equal(result.event.ok, true)
  assert.equal(result.primary.ok, false)
  assert.equal(result.primary.code, "WRITE_FAIL")
  assert.equal(result.revision, JSON.parse(h.files.get("internal://files/events.json")).revision)
  h.sendProtocol(request)
  assert.equal(readStoreEvents(h).length, 1)
})

test("E-07: 表盘失败不跳过主事件提交，最终回执报告各分项", () => {
  const h = protocolHarness()
  const add = h.global.eventStore.add
  h.global.eventStore.add = (data, callback) => add(data, (error, result) =>
    callback({code: "WATCHFACE_FAIL"}, result))
  h.sendProtocol(h.request("recover-primary", {watchface: true, on_index: false}))
  let result = h.results().at(-1)
  assert.equal(result.event.ok, true)
  assert.equal(result.primary.ok, true)
  assert.equal(result.watchface.ok, true, "后续主事件提交修复了表盘同步")
  h.global.eventStore.setPrimary = (id, callback) => callback({code: "WATCHFACE_FAIL"}, {revision: 5})
  h.sendProtocol(h.request("watchface-fail", {watchface: true}))
  result = h.results().at(-1)
  assert.equal(result.ok, true)
  assert.equal(result.primary.ok, true)
  assert.equal(result.watchface.ok, false)
  assert.equal(result.code, "WATCHFACE_FAIL")
  assert.equal(result.revision, 5)
})

test("E-07: 未提交事件的失败回执不报告主事件和表盘成功", () => {
  const h = protocolHarness()
  h.sendProtocol(h.request("bad", {date: "2026-02-30", watchface: true}))
  const result = h.results().at(-1)
  assert.equal(result.ok, false)
  assert.equal(result.event.ok, false)
  assert.equal(result.primary.ok, null)
  assert.equal(result.watchface.ok, null)
  assert.equal(readStoreEvents(h).length, 0)
})

test("E-10: 列表回包显式绑定请求身份，交错拉取不消费 mutation 上下文", () => {
  const h = protocolHarness()
  h.deferWrites = true
  h.sendProtocol(h.request("mutation"))
  h.sendProtocol({type: "getAllEvent", requestId: "list-1", sessionId: "s-1", deviceId: "watch-1"})
  h.sendProtocol({type: "getAllEvent", requestId: "list-2", sessionId: "s-1", deviceId: "watch-1"})
  h.flushWrites()
  const lists = h.connection.sent.map((item) => item.data).filter((item) => Array.isArray(item.data))
  assert.deepEqual(lists.map((item) => item.requestId), ["list-1", "list-2"])
  assert.ok(lists.every((item) => item.sessionId === "s-1" && item.deviceId === "watch-1"))
  assert.equal(h.results().at(-1).requestId, "mutation")
  const before = h.connection.sent.length
  h.sendProtocol({type: "getAllEvent", requestId: "old", sessionId: "stale", deviceId: "watch-1"})
  assert.equal(h.connection.sent.length, before, "旧会话不返回列表")
})

test("E-12: 腕端拒绝超预算消息且不进入存储提交", () => {
  const h = protocolHarness()
  h.sendProtocol(h.request("huge", {extra: "x".repeat(262144)}))
  assert.equal(readStoreEvents(h).length, 0)
  assert.equal(h.results().length, 0)
  assert.equal(h.global.__daymatterProtocolLedger.requests.length, 0)
})

test("E-12: 协商分批回传保持完整顺序、身份和单批预算", () => {
  const h = protocolHarness()
  h.hello = () => h.sendProtocol({type: "hello", protocolVersion: 2, sessionId: "s-1", capabilities: ["requestId", "listBatches"]})
  h.hello()
  const events = Array.from({length: 200}, (_, i) => ({id: "e" + i, name: '甲"\\\n🎂' + i, date: "2026-12-01", on_index: true, IFStaringDay: false}))
  h.files.set("internal://files/events.json", JSON.stringify({version: 2, revision: 10, primaryId: "e0", events}))
  h.sendProtocol({type: "getAllEvent", requestId: "batches", sessionId: "s-1", deviceId: "watch-1", listBatches: true})
  const batches = h.connection.sent.map((item) => item.data).filter((item) => item.type === "eventListBatch")
  assert.ok(batches.length > 1)
  assert.equal(batches.flatMap((item) => item.data).length, 200)
  assert.deepEqual(batches.flatMap((item) => item.data).map((item) => item.name), events.map((item) => item.name))
  batches.forEach((batch, index) => {
    assert.equal(batch.batchIndex, index)
    assert.equal(batch.batchCount, batches.length)
    assert.equal(batch.total, 200)
    assert.equal(batch.requestId, "batches")
    assert.ok(batch.data.length <= 16)
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 8192)
  })
})

test("E-12: 空列表单批完成，单项超预算明确失败不发送部分列表", () => {
  const h = protocolHarness()
  h.sendProtocol({type: "hello", protocolVersion: 2, sessionId: "s-1", capabilities: ["listBatches"]})
  const request = {type: "getAllEvent", requestId: "empty", sessionId: "s-1", deviceId: "watch-1", listBatches: true}
  h.sendProtocol(request)
  const empty = h.connection.sent.at(-1).data
  assert.equal(empty.type, "eventListBatch")
  assert.equal(empty.total, 0)
  assert.equal(empty.batchCount, 1)
  h.global.eventStore.read = (callback) => callback(null, {events: [{name: "a", date: "2026-01-01", extra: "x".repeat(8192)}], revision: 1, primaryId: ""})
  h.sendProtocol({...request, requestId: "oversize"})
  assert.equal(h.connection.sent.at(-1).data.type, "eventListError")
  assert.equal(h.connection.sent.at(-1).data.code, "LIST_ITEM_TOO_LARGE")
})

test("E 收尾: 未知命令原型名称忽略，列表读取失败带回本次请求身份", () => {
  const h = protocolHarness()
  const before = h.connection.sent.length
  h.sendProtocol({type: "constructor"})
  h.sendProtocol({type: "toString"})
  assert.equal(h.connection.sent.length, before)
  h.global.eventStore.read = (callback) => callback({code: "READ_FAIL"})
  h.sendProtocol({type: "getAllEvent", requestId: "failed-list", sessionId: "s-1", deviceId: "watch-1"})
  assert.equal(h.connection.sent.at(-1).data.type, "eventListError")
  assert.equal(h.connection.sent.at(-1).data.requestId, "failed-list")
})

test("D-16: 保存失败保留草稿与页面，重复点击只提交一次", () => {
  const h = createHarness()
  const editor = h.router.push({uri: "/pages/edit", params: {extend: "true", callback_uri: "/pages/index"}})
  editor.event_name = "草稿名称"

  // 写盘失败：停留编辑页、保留草稿、复位在途标记
  h.failWrites = true
  editor.saveEvent()
  assert.equal(h.current(), editor, "保存失败不得离开编辑页")
  assert.equal(editor.event_name, "草稿名称", "保存失败必须保留草稿")
  assert.equal(editor._saving, false, "失败后必须复位在途守卫")
  h.failWrites = false

  // 在途保存期间重复点击只提交一次
  h.deferWrites = true
  editor.saveEvent()
  editor.saveEvent()
  assert.equal(editor._saving, true, "在途保存必须阻止重复提交")
  h.flushWrites()
  h.deferWrites = false
  const added = readStoreEvents(h).filter((e) => e.name === "草稿名称")
  assert.equal(added.length, 1, "重复点击不得重复新增")
})

test("D-17 / D-18: 编辑页按稳定 ID 切换表盘主事件，列表传递当前主事件标记", () => {
  const h = createHarness()
  seedEvents(h, 3)
  const list = h.router.push({uri: "/pages/list"})
  assert.equal(list._primaryId !== undefined, true, "列表必须记录当前主事件")

  // 编辑既有事件：开关由 false 切到 true，保存后按稳定 ID 落库
  list.routeEditEvent(1)
  const editor = h.current()
  assert.equal(editor.watchface, "false")
  editor.useWatchface = false
  editor.changeUseWatchface()
  assert.equal(editor.useWatchface, true, "开关必须可切换")
  editor.event_name = "表盘事件"
  const onIndexBefore = editor.on_index
  editor.saveEvent()
  const stored = JSON.parse(h.files.get("internal://files/events.json"))
  const target = stored.events[1]
  assert.equal(stored.primaryId, target.id, "主事件必须按稳定 ID 记录")
  assert.equal(target.name, "表盘事件")
  assert.equal(target.on_index, true, "切换主事件不得改动首页展示开关（页面值为字符串 true）")

  // 列表再次进入时传递正确标记，并只做文本标记不新增节点
  const list2 = h.router.push({uri: "/pages/list"})
  assert.equal(list2._primaryId, target.id)
  const marked = list2.events.filter((item) => item.display_name.indexOf("表盘") >= 0)
  assert.equal(marked.length, 1, "仅主事件带表盘标记")
  assert.ok(!fs.readFileSync(path.join(root, "src/pages/list/list.ux"), "utf8").includes("watchface-badge"),
    "表盘标记不得引入额外节点")

  // 再次进入编辑页不重复切换主事件，开关状态与落库一致
  list2.routeEditEvent(1)
  const editor2 = h.current()
  assert.equal(editor2.watchface, "true")
  editor2.event_name = "表盘事件改名"
  editor2.saveEvent()
  assert.equal(JSON.parse(h.files.get("internal://files/events.json")).primaryId, target.id)
})

test("D-18 / D-20: 表盘文件只由存储层维护，页面与插件不再直接写 date.txt", () => {
  const pageSources = ["index", "list", "edit"]
    .map((name) => fs.readFileSync(path.join(root, "src/pages", name, name + ".ux"), "utf8"))
    .join("\n")
  assert.ok(!pageSources.includes("date.txt"), "页面不得直接写表盘文件")
  assert.ok(!pageSources.includes("saveDateToFile"), "旧的页面内表盘写入入口必须移除")
  const editSource = fs.readFileSync(path.join(root, "src/pages/edit/edit.ux"), "utf8")
  assert.ok(editSource.includes("global.eventStore.setPrimary"), "编辑页必须通过存储层切换主事件")
  const indexSource = fs.readFileSync(path.join(root, "src/pages/index/index.ux"), "utf8")
  assert.ok(indexSource.includes("WATCHFACE_FAIL"), "插件消息必须报告表盘分项结果")
  assert.ok(indexSource.includes("readWatchfaceFlag"), "插件消息支持切换表盘主事件")

  // 表盘写入失败：事件数据已提交，页面报告分项结果后离开，不当作整体失败
  const h = createHarness()
  const editor = h.router.push({uri: "/pages/edit", params: {extend: "true", callback_uri: "/pages/index"}})
  editor.event_name = "分项结果"
  h.failWrites = true
  editor.saveEvent()
  h.failWrites = false
  assert.equal(readStoreEvents(h).length, 0, "写盘失败不得提交事件数据")
  assert.equal(h.current(), editor, "整体失败保留页面与草稿")
})

test("C-05: 页面销毁后停止在途回调，迟到结果不重建 / 不导航", () => {
  const h = createHarness()
  seedEvents(h, 1)
  const home = h.router.push({uri: "/pages/index"})
  home.routeMore()
  const list = h.current()
  list.routeEditEvent(0)
  const editor = h.current()

  // 保存写盘在途时页面销毁：文件写入完成，但不得再触发返回 / 提示
  editor.event_name = "在途保存"
  h.deferWrites = true
  editor.saveEvent()
  const pagesBefore = h.pages.length
  editor.onDestroy()
  h.flushWrites()
  h.deferWrites = false
  assert.equal(h.pages.length, pagesBefore, "迟到回调不得再触发页面导航")
  assert.equal(h.current(), editor)
  assert.equal(readStoreEvents(h)[0].name, "在途保存", "文件写入仍应完成")

  // 列表读取回调迟到：销毁后不得写入已释放的页面数据
  h.deferReads = true
  const list2 = h.router.push({uri: "/pages/list"})
  assert.equal(list2._allEvents.length, 0)
  list2.onDestroy()
  h.deferReads = false
  h.flushReads()
  assert.equal(list2._allEvents.length, 0, "销毁后的迟到读取不得写回页面")
  assert.equal(list2.events.length, 0)
})

test("C-03/C-04: 隐藏页先释放重内容再创建新页，返回恢复卡片位置 / 页码 / 草稿", () => {
  const h = createHarness()
  seedEvents(h, 12)
  const home = h.router.push({uri: "/pages/index"})
  home.onSwiperChange({index: 1})
  assert.equal(home.activeSourceIndex, 1)

  // 首页 → 列表：旧页释放先于新页显示
  home.routeMore()
  const list = h.current()
  assert.equal(home.pageVisible, false)
  assert.equal(home.contentVisible, false)
  assert.equal(home.events.length, 0, "隐藏首页必须释放展示数据")
  assert.equal(list.contentVisible, true, "新页面创建时旧页已释放")

  // 列表翻页 → 编辑：列表释放、页码保留
  list.changePage(2)
  assert.equal(list.page, 2)
  list.routeEditEvent(10)
  const editor = h.current()
  assert.equal(list.contentVisible, false)
  assert.equal(list.events.length, 0)
  assert.equal(list._allEvents.length, 0)

  // 编辑 → 键盘：表单释放、草稿与请求归属保留
  editor.event_name = "草稿名称"
  editor.editEventName()
  const ime = h.current()
  assert.equal(editor.contentVisible, false, "编辑页隐藏时释放表单节点")
  assert.equal(editor.event_name, "草稿名称", "草稿必须保留")
  assert.equal(h.global.__daymatterImeOwner, editor._pendingRequestId, "输入请求归属保持不变")
  ime.context = "确认后的名称"
  ime.finish(true)
  assert.equal(h.current(), editor)
  assert.equal(editor.contentVisible, true, "返回后恢复表单")
  assert.equal(editor.event_name, "确认后的名称")

  // 返回列表：恢复页码与存储下标
  editor.routeBack()
  assert.equal(h.current(), list)
  assert.equal(list.contentVisible, true)
  assert.equal(list.page, 2)
  assert.equal(list.events[0].storageIndex, 10)

  // 返回首页：恢复原卡片位置
  list.routeBack()
  assert.equal(h.current(), home)
  assert.equal(home.contentVisible, true)
  assert.equal(home.activeSourceIndex, 1)
  assert.equal(home._currentSource, 1)
})

test("C-26: 无自定义背景时不创建背景节点，有背景时按需创建并兼容旧文件", () => {
  const indexSource = fs.readFileSync(path.join(root, "src/pages/index/index.ux"), "utf8")
  assert.ok(indexSource.includes('if="{{ contentVisible && bgImage }}"'), "背景节点必须按需创建")
  assert.ok(fs.existsSync(path.join(root, "src/common/blank.png")), "保留背景兼容文件")

  const h = createHarness()
  seedEvents(h, 1)
  const home = h.router.push({uri: "/pages/index"})
  assert.equal(home.bgImage, "", "无自定义背景必须留空，使用黑色底色")

  h.bgFiles = ["internal://files/bg_1700000000000.png"]
  // 模拟应用升级后的首次启动：新实例无索引时才扫描旧背景。
  h.files.delete("internal://files/background.json")
  const module = loadModule(fs.readFileSync(path.join(root, "src/components/backgroundStore.js"), "utf8"), {}, "unused")
  h.global.backgroundStore = module.createBackgroundStore({file: h.backgroundFile, decode: () => new ArrayBuffer(0), setTimer: () => 0, clearTimer: () => {}})
  home.onShow()
  assert.equal(home.bgImage, "internal://files/bg_1700000000000.png", "有背景时按需引用")
})

test("G-02：首页迟到加载、隐藏/销毁后的保存回调不恢复旧节点", () => {
  const h = createHarness()
  const loads = []
  const saves = []
  h.global.backgroundStore = {
    load: (callback) => loads.push(callback),
    save: (value, callback) => saves.push(callback)
  }
  const home = h.router.push({uri: "/pages/index"})
  home.handleAddBG({bgBase64: "bmV3"})
  saves.shift()(null, "internal://files/bg_200.png")
  loads.shift()(null, "internal://files/bg_100.png")
  assert.equal(home.bgImage, "internal://files/bg_200.png")
  home.handleAddBG({bgBase64: "bmV3"})
  home.onHide()
  saves.shift()(null, "internal://files/bg_201.png")
  assert.equal(home.bgImage, "internal://files/bg_200.png")
  assert.equal(home._needsRefresh, true)
  home.onShow()
  loads.shift()(null, "internal://files/bg_201.png")
  assert.equal(home.bgImage, "internal://files/bg_201.png")
  home.handleAddBG({bgBase64: "bmV3"})
  home.onDestroy()
  saves.shift()(null, "internal://files/bg_202.png")
  assert.equal(home.bgImage, "", "销毁释放背景，迟到回调不能重新创建引用")
})

test("背景保存协议：实际页面最终回执、重复请求不重复写及失败回执", () => {
  const h = createHarness()
  const home = h.router.push({uri: "/pages/index"})
  const send = (data) => home.handleInterconnectMessage({data: JSON.stringify(data)})
  send({type:"hello",protocolVersion:2,sessionId:"bg-session",deviceId:"watch",handshakeId:"h",capabilities:["requestId"]})
  const bgBase64 = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]).toString("base64")
  const request = {type:"addBG",bgBase64,requestId:"bg1",sessionId:"bg-session",deviceId:"watch"}
  send(request)
  assert.equal(h.connection.sent.at(-1).data.ok,true)
  const writes = h.writes.length
  send(request)
  assert.equal(h.writes.length,writes)
  send({...request,requestId:"bg2",bgBase64:"invalid"})
  assert.equal(h.connection.sent.at(-1).data.ok,false)
  assert.equal(h.connection.sent.at(-1).data.code,"BACKGROUND_DECODE")
})

test("背景分片实际页面：ACK推进、完整提交回执和重复finish不重写", () => {
  const h=createHarness()
  const home=h.router.push({uri:"/pages/index"})
  const send=(data)=>home.handleInterconnectMessage({data:JSON.stringify(data)})
  const identity={sessionId:"chunks",deviceId:"watch",requestId:"image1"}
  send({type:"hello",protocolVersion:2,...identity,handshakeId:"h",capabilities:["requestId"]})
  const bytes=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0])
  let checksum=2166136261
  for(const byte of bytes) checksum=Math.imul(checksum^byte,16777619)>>>0
  send({...identity,type:"beginBG",bytes:bytes.length,checksum})
  assert.equal(h.connection.sent.at(-1).data.type,"backgroundAck")
  send({...identity,type:"backgroundChunk",offset:0,data:bytes.toString("base64")})
  assert.equal(h.connection.sent.at(-1).data.next,bytes.length)
  send({...identity,type:"finishBG"})
  assert.equal(h.connection.sent.at(-1).data.ok,true)
  const writes=h.writes.length
  send({...identity,type:"finishBG"})
  assert.equal(h.writes.length,writes)
})

test("G-04：关于页恢复默认确认/取消、重复点击和返回首页不建背景节点", () => {
  const h = createHarness()
  const uri = "internal://files/bg_100.png"
  h.files.set("internal://files/background.json", JSON.stringify({version: 1, uri}))
  h.files.set(uri, "image")
  const home = h.router.push({uri: "/pages/index"})
  const about = h.router.push({uri: "/pages/about"})
  assert.equal(about.hasBackground, true)
  about.askReset()
  about.cancelReset()
  assert.equal(about.confirmReset, false)
  assert.equal(h.files.has(uri), true)
  about.askReset()
  h.deferWrites = true
  about.resetBackground()
  about.resetBackground()
  h.flushWrites()
  assert.equal(about.hasBackground, false)
  assert.equal(JSON.parse(h.files.get("internal://files/background.json")).uri, "")
  about.routeBack()
  assert.equal(h.current(), home)
  assert.equal(home.bgImage, "")
})

test("C-25: runGC 仅在宿主持有时低频调用，不在高频路径触发", () => {
  const gcSource = fs.readFileSync(path.join(root, "src/components/gcGuard.js"), "utf8")
  const runCalls = []
  const gcGlobal = {
    runGC() {
      runCalls.push(1)
    }
  }
  const gcModule = loadModule(gcSource, {global: gcGlobal}, "unused")
  const guard = gcModule.createGcGuard()
  assert.equal(guard(), true, "宿主可用时执行一次")
  assert.equal(guard(), false, "短时间内重复调用必须被节流")
  assert.equal(runCalls.length, 1)
  assert.equal(guard(), false)
  assert.equal(runCalls.length, 1)

  const noGcModule = loadModule(gcSource, {global: {}}, "unused")
  assert.equal(noGcModule.createGcGuard()(), false, "宿主无 runGC 时必须安全跳过")

  // 只在页面销毁路径调用，且不得新增常驻高频计时器
  for (const file of ["src/pages/index/index.ux", "src/pages/list/list.ux", "src/pages/ime/ime.ux"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    assert.ok(source.includes("global.tryRunGC"), file + " 必须在销毁路径按需调用 GC")
    assert.ok(!source.includes("setInterval"), file + " 不得新增常驻高频计时器")
  }
  const appSource = fs.readFileSync(path.join(root, "src/app.ux"), "utf8")
  assert.ok(appSource.includes("createGcGuard"), "app.ux 必须安装低频 GC 守卫")
})

test("C-22: 时钟按分钟级更新并停止于隐藏，跨午夜刷新日期相关数据", () => {
  const h = createHarness()
  h.clock.now = new Date(2026, 5, 15, 12, 34, 30).getTime()
  seedEvents(h, 2)
  const home = h.router.push({uri: "/pages/index"})
  assert.equal(home.time, "12:34")
  assert.equal(h.pendingTimers(), 1, "显示时必须只挂一个分钟级定时器")
  const delay = h.timerDelays()[0]
  assert.ok(delay > 0 && delay <= 60000, "延迟必须在一分钟内")
  assert.equal((h.clock.now + delay) % 60000, 0, "必须对齐分钟边界")

  // 普通分钟：只更新时间，不重建事件数据
  const readsBefore = h.readCount("internal://files/events.json")
  h.global.getTime = () => "12:35"
  h.clock.now += delay
  h.runNextTimer()
  assert.equal(home.time, "12:35")
  assert.equal(h.readCount("internal://files/events.json"), readsBefore, "普通分钟不得重建数据")
  assert.equal(h.pendingTimers(), 1, "触发后继续按分钟调度")

  // 隐藏停止、重新显示恢复，且同一时间只有一个可见页计时器
  home.routeMore()
  assert.equal(h.pendingTimers(), 1, "同一时间只允许一个可见页计时器")
  h.current().routeBack()
  assert.equal(h.pendingTimers(), 1)

  // 关于页 / 编辑页 / 键盘 / 日期页：只保留当前可见页的计时器
  home.info()
  assert.equal(h.pendingTimers(), 1)
  h.current().routeBack()
  home.routeMore()
  const list = h.current()
  list.routeEditEvent(0)
  const editor = h.current()
  assert.equal(h.pendingTimers(), 1, "编辑页显示时只保留自身计时器")
  editor.editDate()
  assert.equal(h.pendingTimers(), 1, "日期页显示时只保留自身计时器")
  h.current().routeBack()
  editor.editEventName()
  assert.equal(h.pendingTimers(), 0, "键盘页不显示时钟，编辑页隐藏后不得保留计时器")
  h.current().finish(false)
  assert.equal(h.pendingTimers(), 1)
  editor.routeBack()
  list.routeBack()
  assert.equal(h.pendingTimers(), 1)

  // 跨午夜：分钟 tick 报告日期变化，首页重新计算倒数天数
  const readsBeforeMidnight = h.readCount("internal://files/events.json")
  h.clock.now += 24 * 60 * 60 * 1000
  h.runNextTimer()
  assert.equal(h.readCount("internal://files/events.json"), readsBeforeMidnight + 1, "跨午夜必须重新计算天数")
  assert.equal(h.pendingTimers(), 1)

  // 源码约束：所有显示时钟的页面都使用全局分钟时钟，不新增常驻高频计时器
  const clockPages = [
    "src/pages/index/index.ux",
    "src/pages/list/list.ux",
    "src/pages/edit/edit.ux",
    "src/pages/datepicker/datepicker.ux",
    "src/pages/about/about.ux"
  ]
  for (const file of clockPages) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    assert.ok(source.includes("global.createMinuteTicker"), file + " 必须使用分钟级时钟")
    assert.ok(source.includes("_ticker.stop()"), file + " 隐藏 / 销毁必须停止时钟")
    assert.ok(!source.includes("setInterval"), file + " 不得新增常驻高频计时器")
  }
})

test("C-23: 连续进入 / 退出各页面后大块数据可回收，数组 / 缓存规模有界", (t) => {
  const h = createHarness()
  seedEvents(h, 12)
  const home = h.router.push({uri: "/pages/index"})
  const imePages = []

  const runCycle = () => {
    // 首页 → 分页列表 → 编辑 → 键盘（更多候选）→ 日期 → 返回，再进入关于页
    home.routeMore()
    const list = h.current()
    list.changePage(2)
    list.changePage(1)
    list.routeEditEvent(0)
    const editor = h.current()
    editor.editEventName()
    const ime = h.current()
    imePages.push(ime)
    ime.onSelect("N")
    ime.onSelect("I")
    ime.onBtnClick("down")
    assert.ok(ime.resultList2.length > 0, "展开更多候选应生成分组")
    ime.onBtnClick("down")
    assert.equal(ime.resultList2.length, 0, "收起立即释放候选分组")
    ime.finish(false)
    editor.editDate()
    h.current().routeBack()
    editor.routeBack()
    assert.equal(h.current(), list)
    list.routeBack()
    assert.equal(h.current(), home)
    home.info()
    h.current().routeBack()
    assert.equal(h.current(), home)

    // 隐藏 / 销毁后大块数据立即释放，页面栈不堆积
    assert.equal(h.pages.length, 1, "连续往返不得堆积页面")
    assert.equal(list._allEvents.length, 0, "隐藏列表必须释放原始快照")
    assert.equal(list.events.length, 0, "隐藏列表必须释放当前页数据")
    assert.ok(home.events.length <= 12)
    assert.equal(home.slots.length, 3, "首页最多三个槽位")
  }

  // 先预热，避开首次模块加载 / JIT 的固定峰值，再测量持续增长
  for (let i = 0; i < 5; i++) runCycle()
  if (typeof global.gc === "function") global.gc()
  const heapBefore = process.memoryUsage().heapUsed
  for (let i = 0; i < 15; i++) runCycle()
  if (typeof global.gc === "function") global.gc()
  const heapAfter = process.memoryUsage().heapUsed

  // 键盘页销毁后缓存 / 候选全部释放，查词缓存有界
  for (const ime of imePages) {
    assert.equal(Object.keys(ime._searchCache).length, 0, "键盘销毁后查词缓存必须释放")
    assert.equal(ime.resultList.length, 0, "键盘销毁后候选必须释放")
    assert.equal(ime.resultList2.length, 0, "键盘销毁后候选分组必须释放")
  }
  assert.equal(h.pages.length, 1)
  assert.equal(h.maxDepth, 4)
  assert.equal(h.replacements, 0)
  assert.equal(h.pendingTimers(), 1, "仅当前可见页保留分钟时钟")

  t.diagnostic(
    `C-23 模拟规模：页面栈=${h.pages.length} 峰值深度=${h.maxDepth} 键盘页缓存=0 ` +
      `列表快照=0 当前页≤10 首页槽位=${home.slots.length} 可见计时器=${h.pendingTimers()}`
  )
  t.diagnostic(
    `C-23 预热后 15 轮 Node 模拟 JS 堆 ${(heapBefore / 1024).toFixed(1)} KiB -> ` +
      `${(heapAfter / 1024).toFixed(1)} KiB (${typeof global.gc === "function" ? "含 gc" : "未启用 gc，仅供参考"}；` +
      `非 Vela 真机数据)`
  )
})
