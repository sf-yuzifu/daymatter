// 正式 bg_<时间>.png/jpg 文件是已提交背景；临时文件不参与首页扫描。
// 应用级单飞避免多个页面实例、连续上传和迟到回调交叉删除文件。
const MAX_BYTES = 100 * 1024
const MAX_EDGE = 450

function imageInfo(bytes) {
  let width = 0
  let height = 0
  let extension = ""
  const u16 = (offset) => bytes[offset] * 256 + bytes[offset + 1]
  const u32 = (offset) => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3]
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
      u32(8) === 13 && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
    extension = "png"
    width = u32(16)
    height = u32(20)
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) break
      const length = u16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([192, 193, 194].indexOf(marker) >= 0 && length >= 8) {
        height = u16(offset + 3)
        width = u16(offset + 5)
        extension = "jpg"
        break
      }
      offset += length
    }
  }
  if (!extension) throw new Error("Unsupported or invalid image header")
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_EDGE * MAX_EDGE) {
    throw new Error("Background dimensions exceed budget")
  }
  return {extension: extension, width: width, height: height}
}

function createBackgroundStore({file, decode, now = () => Date.now()}) {
  let busy = false
  let revision = 0
  let sequence = 0

  function once(callback) {
    let done = false
    return (...args) => {
      if (done) return
      done = true
      callback(...args)
    }
  }

  function invoke(method, options, callback) {
    const finish = once(callback)
    try {
      file[method]({...options, success: (data) => finish(null, data),
        fail: (data, code) => finish({code: code, cause: data})})
    } catch (error) {
      finish({cause: error})
    }
  }

  function load(callback) {
    const started = revision
    invoke("list", {uri: "internal://files/"}, (error, data) => {
      // 旧扫描回包不能覆盖刚提交的新背景。
      if (started !== revision) { load(callback); return }
      if (error) { callback(error); return }
      const files = (data.fileList || [])
        .filter((item) => /^internal:\/\/files\/bg_\d+\.(png|jpg)$/.test(item.uri || ""))
        .sort((a, b) => Number(b.uri.match(/bg_(\d+)/)[1]) - Number(a.uri.match(/bg_(\d+)/)[1]))
      callback(null, files.length ? files[0].uri : "")
    })
  }

  function save(base64, callback) {
    if (busy) { callback({code: "BACKGROUND_BUSY"}); return }
    busy = true
    const finish = once((error, uri) => { busy = false; callback(error, uri) })
    let buffer
    let info
    try {
      // 原解码器对非法字符会跳过，先拒绝不完整或非法的Base64。
      if (typeof base64 !== "string") throw new Error("Invalid Base64")
      // 在去空白复制和Base64分配前限制输入；正常插件不会附带空白。
      if (base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("Background bytes exceed budget")
      const value = base64.replace(/\s/g, "")
      if (!value || value.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Invalid Base64")
      }
      buffer = new Uint8Array(decode(value))
      if (!buffer.length || buffer.length > MAX_BYTES) throw new Error("Background bytes exceed budget")
      // 只读取编码头的宽高，不在低内存腕端执行图片像素解码。
      info = imageInfo(buffer)
    } catch (error) { finish({code: "BACKGROUND_DECODE", cause: error}); return }

    load((error, oldUri) => {
      if (error) { finish(error); return }
      const oldTime = oldUri ? Number(oldUri.match(/bg_(\d+)/)[1]) : 0
      sequence = Math.max(sequence + 1, now(), oldTime + 1)
      const uri = `internal://files/bg_${sequence}.${info.extension}`
      const temporary = `internal://files/bg_pending_${sequence}.tmp`
      const discard = (failure) => {
        invoke("delete", {uri: temporary}, () => finish(failure))
      }
      invoke("writeArrayBuffer", {uri: temporary, buffer: buffer}, (writeError) => {
        buffer = null
        if (writeError) { discard(writeError); return }
        // 移动到唯一正式路径即提交当前引用；失败时不触碰旧背景。
        invoke("move", {srcUri: temporary, dstUri: uri}, (moveError) => {
          if (moveError) { discard(moveError); return }
          revision++
          if (!oldUri) { finish(null, uri); return }
          // 清理失败不撤销已成功提交的新背景。
          invoke("delete", {uri: oldUri}, () => finish(null, uri))
        })
      })
    })
  }

  return {load: load, save: save}
}

export default {createBackgroundStore, imageInfo}
