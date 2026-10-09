// 正式 bg_<时间>.png 文件是已提交背景；临时文件不参与首页扫描。
// 应用级单飞避免多个页面实例、连续上传和迟到回调交叉删除文件。
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
        .filter((item) => /^internal:\/\/files\/bg_\d+\.png$/.test(item.uri || ""))
        .sort((a, b) => Number(b.uri.match(/bg_(\d+)/)[1]) - Number(a.uri.match(/bg_(\d+)/)[1]))
      callback(null, files.length ? files[0].uri : "")
    })
  }

  function save(base64, callback) {
    if (busy) { callback({code: "BACKGROUND_BUSY"}); return }
    busy = true
    const finish = once((error, uri) => { busy = false; callback(error, uri) })
    let buffer
    try {
      // 原解码器对非法字符会跳过，先拒绝不完整或非法的Base64。
      if (typeof base64 !== "string") throw new Error("Invalid Base64")
      const value = base64.replace(/\s/g, "")
      if (!value || value.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Invalid Base64")
      }
      buffer = new Uint8Array(decode(value))
      if (!buffer.length) throw new Error("Empty background")
    } catch (error) { finish({code: "BACKGROUND_DECODE", cause: error}); return }

    load((error, oldUri) => {
      if (error) { finish(error); return }
      const oldTime = oldUri ? Number(oldUri.match(/bg_(\d+)/)[1]) : 0
      sequence = Math.max(sequence + 1, now(), oldTime + 1)
      const uri = `internal://files/bg_${sequence}.png`
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

export default {createBackgroundStore}
