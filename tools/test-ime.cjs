const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const {test} = require("node:test")

const root = path.resolve(__dirname, "..")
const imeDir = path.join(root, "src/pages/ime")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"))
const imeSource = fs.readFileSync(path.join(imeDir, "ime.ux"), "utf8")

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
    maxDepth: 0,
    replacements: 0,
    files: new Map([["internal://files/events.json", "[]"]]),
    global: {
      screenShape: "pill-shaped",
      screenSize: {width: 192, height: 490},
      deviceType: "band",
      isPillShaped: true,
      getTime: () => "12:34",
      dateDiff: () => -10,
      getDateDiffAccurate: () => ({years: 0, months: 0, days: 10}),
      adjustThemeColor: (color) => color || "#3184d0"
    }
  }
  const dict = loadModule(fs.readFileSync(path.join(imeDir, "assets/dic.js"), "utf8"), {}, "dict")
  const SimpleInputMethod = loadModule(
    fs.readFileSync(path.join(imeDir, "assets/dicUtil.js"), "utf8"), {dict}, "SimpleInputMethod"
  )
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
          console: {log() {}, error() {}},
          vibrator: {vibrate() {}},
          device: {getInfo({success}) { success({screenWidth: state.global.screenSize.width}) }},
          interconnect: {instance: () => null}
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
  const file = {
    readText({uri, success, fail}) {
      if (state.files.has(uri)) success({text: state.files.get(uri)})
      else if (fail) fail("not found", 301)
    },
    writeText({uri, text, success}) {
      state.files.set(uri, text)
      state.writes.push(uri)
      if (success) success()
    },
    list({success}) { success({fileList: []}) }
  }
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
      } else if (src.includes("{{ on_index }}") || src.includes("{{ IFStaringDay }}")) {
        variants = ["true", "false"].map((bool) => src.replace(/\{\{\s*(?:on_index|IFStaringDay)\s*\}\}/g, bool))
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

test("原名称和本地化标题进入新版键盘，确认只改名称草稿", () => {
  const h = createHarness()
  const editor = h.openEditor()
  const preserved = otherFields(editor)
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
  assert.deepEqual(h.writes, [])
  assert.equal(h.global.__imeResult, null)
  assert.equal(h.global.__imeText, "")
  assert.equal(h.global.__daymatterImeOwner, null)
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
  assert.equal(editor.date, "2026-11-7")
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
  assert.equal(editor.date, "2026-10-6")
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
