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

  function fileDelete(targetUri, callback) {
    file.delete({uri: targetUri, success: () => callback(), fail: () => callback()})
  }

  // 部分固件 move 不覆盖已存在文件，退化为直接写派生文件并清理临时文件
  function writeDirect(text, prevCode, callback) {
    file.writeText({
      uri: DATE_URI,
      text: text,
      success: () => fileDelete(TMP_URI, () => callback(null)),
      fail: (data, code) => fileDelete(TMP_URI, () => callback({type: "write", code: code || prevCode || 300}))
    })
  }

  function writeText(text, callback) {
    file.writeText({
      uri: TMP_URI,
      text: text,
      success: () => {
        file.move({
          srcUri: TMP_URI,
          dstUri: DATE_URI,
          success: () => callback(null),
          fail: (data, moveCode) => writeDirect(text, moveCode, callback)
        })
      },
      fail: (data, tmpCode) => writeDirect(text, tmpCode, callback)
    })
  }

  function exists(callback) {
    if (typeof file.access === "function") {
      file.access({uri: DATE_URI, success: () => callback(true), fail: () => callback(false)})
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
