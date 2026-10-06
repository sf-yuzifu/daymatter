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
          vibrator: {vibrate(options) { state.vibrations.push(options) }},
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

test("C-20: 首页切换显示单位时原地修改属性，严格保留事件对象与数组引用", () => {
  const h = createHarness()
  h.files.set("internal://files/events.json", JSON.stringify([
    {name: "测试事件", date: "2026-11-06", on_index: true, IFStaringDay: false, themeColor: "#3184d0"}
  ]))
  const home = h.router.push({uri: "/pages/index"})
  assert.equal(home.events.length, 1)

  const arrayBefore = home.events
  const objBefore = home.events[0]
  const modeBefore = home.currentDisplayModeIndex

  // 触发切换模式
  home.toggleDisplayMode(0)

  assert.equal(home.events, arrayBefore, "必须保持同一 events 数组引用，不重新赋值整个数组")
  assert.equal(home.events[0], objBefore, "必须保持同一事件对象引用，避免销毁已有 DOM / Swiper 节点")
  assert.notEqual(home.currentDisplayModeIndex, modeBefore, "单位模式索引已推进")
  assert.ok(home.events[0].displayText, "更新了展示文本")
  assert.ok(home.events[0].fontSize > 0, "更新了字号大小")
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

test("C-10: 不变配置移出响应式数据；相同查询不重复清空 / 重建候选数组", () => {
  const h = createHarness()
  const editor = h.openEditor({event_name: ""})
  editor.editEventName()
  const ime = h.current()

  // 不变配置不应留在 private 响应式视图模型中
  const imeDefinition = h.definitions.get("pages/ime")
  for (const key of ["keyboardtype", "screentype", "cvalList"]) {
    assert.equal(key in imeDefinition.private, false, key + " 不应留在 private 响应式数据中")
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

test("C-15: 设备分支使用 if.static 固定，候选 / 语言 / 数字 / 输入与滚动保持动态", () => {
  // 屏幕信息在 onInit 就绪后固定设备分支
  assert.ok(imeSource.includes(`if.static="{{ screentype==='circle' }}"`), "圆屏分支必须 if.static")
  assert.ok(imeSource.includes(`if.static="{{ screentype==='rect' }}"`), "方屏分支必须 if.static")
  assert.ok(
    imeSource.includes(`if.static="{{ screentype==='pill-shaped' }}"`),
    "胶囊屏分支必须 if.static"
  )
  assert.ok(imeSource.includes(`if.static="{{ keyboardtype!='T9' }}"`), "键盘类型分支必须 if.static")

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
  assert.equal(editor.event_id, "20", "编辑必须映射回原始存储下标")
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
  assert.ok(editSource.includes('if="{{ pageVisible }}"'), "编辑页跑马灯必须随页面隐藏移除")

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
