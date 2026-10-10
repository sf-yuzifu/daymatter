// 表盘文件维护：internal://files/date.txt（D-17～D-20）。
// 格式保持与现有表盘读取端一致，不改分隔符：名称,日期,是否计入起始日
// - D-19：名称中的逗号 / 换行按空格替换，输出恒为两个分隔逗号；
//   日期归一为 YYYY-MM-DD，标志位归一为 true / false 文本。
// - D-18：主事件由存储层指定，本模块只负责按当前主事件生成内容。
// - D-20：date.txt 是可由 events.json 重建的派生文件，写入先 .tmp 再 move，
//   直接覆盖不被固件支持时退化为直接写；会话内内容未变化则不重复写。

const DATE_URI = "internal://files/date.txt"
const TMP_URI = DATE_URI + ".tmp"

function sanitizeName(name) {
  return String(name === undefined || name === null ? "" : name)
    .replace(/[\r\n\t]/g, " ")
    .replace(/,/g, " ")
    .replace(/ +/g, " ")
    .trim()
}

function toFlagText(value) {
  return value === true || value === "true" ? "true" : "false"
}

// 主事件内容；无主事件时返回空串，表示清空表盘
function buildText(event, fallbackName) {
  if (!event) return ""
  const date = typeof event.date === "string" ? event.date.trim() : ""
  const name = sanitizeName(event.name) || sanitizeName(fallbackName) || sanitizeName(date)
  if (!name) return ""
  return name + "," + date + "," + toFlagText(event.IFStaringDay)
}

function findPrimary(state) {
  if (!state || !Array.isArray(state.events)) return null
  const primaryId = typeof state.primaryId === "string" ? state.primaryId : ""
  if (!primaryId) return null
  for (let i = 0; i < state.events.length; i++) {
    if (state.events[i].id === primaryId) return state.events[i]
  }
  return null
}

function createWatchFace(options) {
  const file = options.file
  // 会话内最近一次成功写入的内容，避免重复写与无谓失败
  let lastText = null

  function invokeFile(operation, params, callback) {
    const detail = {operation, uri: params.uri, srcUri: params.srcUri, dstUri: params.dstUri}
    if (typeof params.text === "string") detail.textLength = params.text.length
    const log = (phase, extra) => {
      try { console.error("[daymatter:watchface] " + JSON.stringify(Object.assign({phase}, detail, extra))) } catch (e) { /* 诊断不影响表盘维护 */ }
    }
    let settled = false
    const finish = (error, data) => {
      if (settled) return
      settled = true
      if (error && error.code !== 301 && !(operation === "move" && error.code === 202))
        log("fail", {code: error.code, data: error.data})
      callback(error, data)
    }
    try {
      file[operation](Object.assign({}, params, {
        success: (data) => finish(null, data),
        fail: (data, code) => finish(Object.assign({type: "write", code: code || 300, data}, detail))
      }))
    } catch (e) {
      if (settled) throw e
      finish(Object.assign({type: "write", code: "EXCEPTION", data: String(e)}, detail))
    }
  }

  function fileDelete(targetUri, callback) {
    invokeFile("delete", {uri: targetUri}, () => callback())
  }

  // 部分固件 move 不覆盖已存在文件，退化为直接写派生文件并清理临时文件
  function writeDirect(text, callback) {
    invokeFile("writeText", {uri: DATE_URI, text}, (error) =>
      fileDelete(TMP_URI, () => callback(error)))
  }

  function writeText(text, callback) {
    invokeFile("writeText", {uri: TMP_URI, text}, (error) => {
      if (error) return writeDirect(text, callback)
      invokeFile("move", {srcUri: TMP_URI, dstUri: DATE_URI}, (moveError) => {
        if (moveError) return writeDirect(text, callback)
        callback(null)
      })
    })
  }

  function exists(callback) {
    if (typeof file.access === "function") {
      invokeFile("access", {uri: DATE_URI}, (error) => callback(!error))
      return
    }
    callback(lastText !== null)
  }

  // 按当前状态维护表盘文件：callback(error, {skipped})
  function sync(state, fallbackName, callback) {
    let event = findPrimary(state)
    if (event && event.repeat === "yearly" && options.dateUtils) {
      const occurrence = options.dateUtils.getOccurrence(event, options.now ? options.now() : undefined)
      event = occurrence ? Object.assign({}, event, {date: occurrence.date}) : null
    }
    const text = buildText(event, fallbackName)
    if (lastText !== null && lastText === text) {
      callback(null, {skipped: true})
      return
    }
    if (text === "") {
      // 清空语义：文件不存在时无需创建空文件
      exists((hasFile) => {
        if (!hasFile) {
          lastText = ""
          callback(null, {skipped: true})
          return
        }
        writeText(text, (error) => {
          if (!error) lastText = text
          callback(error, {skipped: false})
        })
      })
      return
    }
    writeText(text, (error) => {
      if (!error) lastText = text
      callback(error, {skipped: false})
    })
  }

  return {sync: sync, buildText: buildText}
}

export default {
  DATE_URI: DATE_URI,
  sanitizeName: sanitizeName,
  buildText: buildText,
  findPrimary: findPrimary,
  createWatchFace: createWatchFace
}
