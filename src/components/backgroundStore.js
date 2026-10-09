// background.json引用决定当前背景；旧版本无索引时迁移bg_<时间>.png/jpg。
// 应用级单飞避免多个页面实例、连续上传和迟到回调交叉删除文件。
const MAX_BYTES = 100 * 1024
const MAX_EDGE = 512

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

function createBackgroundStore({file, decode, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout}) {
  let busy = false
  let sequence = 0
  const indexUri = "internal://files/background.json"
  const backupUri = indexUri + ".bak"
  const tempIndexUri = indexUri + ".tmp"
  const imagePattern = /^internal:\/\/files\/bg_\d+\.(png|jpg)$/
  const pendingPattern = /^internal:\/\/files\/bg_pending_\d+\.tmp$/
  let current = null
  let indexExists = false
  let loading = false
  let waiters = []
  let transfer = null

  function receive(frame, callback) {
    if (frame.type === "beginBG") {
      if (transfer && frame.requestId === transfer.requestId && frame.sessionId === transfer.sessionId && frame.deviceId === transfer.deviceId) {
        callback(null, {next: transfer.offset}); return
      }
      if (busy) { callback({code: "BACKGROUND_BUSY"}); return }
      if (!Number.isInteger(frame.bytes) || frame.bytes < 1 || frame.bytes > MAX_BYTES ||
          !Number.isInteger(frame.checksum) || frame.checksum < 0 || frame.checksum > 4294967295) {
        callback({code: "BACKGROUND_BUDGET"}); return
      }
      busy = true
      // ACK前初始化单飞身份，重复begin在load期间仍只会得到busy，不能开启第二次写入。
      load((error, oldUri) => {
        if (error) { busy = false; callback(error); return }
        sequence = Math.max(sequence + 1, now(), oldUri ? Number(oldUri.match(/bg_(\d+)/)[1]) + 1 : 0)
        transfer = {sessionId: frame.sessionId, requestId: frame.requestId, deviceId: frame.deviceId,
          bytes: frame.bytes, checksum: frame.checksum, offset: 0, hash: 2166136261,
          temporary: `internal://files/bg_pending_${sequence}.tmp`, writing: false, info: null, last: null}
        const active = transfer
        active.timer = setTimer(() => {
          if (transfer !== active) return
          // 任务超时只在没有原生写入在途时清理，避免迟到写回串图。
          if (active.writing) { active.expired = true; return }
          invoke("delete", {uri: active.temporary}, () => {
            if (transfer === active) { transfer = null; busy = false; callback({code:"BACKGROUND_TIMEOUT"}) }
          })
        }, 120000)
        callback(null, {next: 0})
      })
      return
    }
    const state = transfer
    if (!state || frame.sessionId !== state.sessionId || frame.requestId !== state.requestId || frame.deviceId !== state.deviceId) return
    if (state.writing) return
    const abort = (error) => {
      clearTimer(state.timer)
      invoke("delete", {uri: state.temporary}, () => { transfer = null; busy = false; callback(error) })
    }
    if (frame.type === "backgroundChunk") {
      if (frame.offset < state.offset) {
        if (state.last && frame.offset === state.last.offset && frame.data === state.last.data) callback(null, {next: state.offset})
        else abort({code:"BACKGROUND_CHUNK_CONFLICT"})
        return
      }
      if (frame.offset !== state.offset || typeof frame.data !== "string" || frame.data.length > 4096 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
        abort({code:"BACKGROUND_CHUNK"}); return
      }
      let buffer
      try {
        buffer = new Uint8Array(decode(frame.data))
        if (!buffer.length || buffer.length > 3072 || state.offset + buffer.length > state.bytes) throw new Error("Chunk budget")
        if (!state.offset) state.info = imageInfo(buffer)
      } catch (cause) { abort({code:"BACKGROUND_CHUNK",cause}); return }
      let hash = state.hash
      for (let i = 0; i < buffer.length; i++) hash = Math.imul(hash ^ buffer[i], 16777619) >>> 0
      state.writing = true
      invoke("writeArrayBuffer", {uri: state.temporary, buffer, append: state.offset > 0}, (error) => {
        state.writing = false
        if (state.expired) { abort({code:"BACKGROUND_TIMEOUT"}); return }
        if (error) { abort(error); return }
        state.offset += buffer.length
        state.hash = hash
        state.last = {offset: frame.offset, data: frame.data}
        callback(null, {next: state.offset})
      })
    } else if (frame.type === "finishBG") {
      if (state.offset !== state.bytes || state.hash !== state.checksum || !state.info) { abort({code:"BACKGROUND_INCOMPLETE"}); return }
      state.writing = true
      const uri = `internal://files/bg_${sequence}.${state.info.extension}`
      invoke("move", {srcUri: state.temporary, dstUri: uri}, (error) => {
        if (error) { abort(error); return }
        commit(uri, (commitError) => {
          if (commitError) { invoke("delete", {uri}, () => abort(commitError)); return }
          clean(() => { clearTimer(state.timer); transfer = null; busy = false; callback(null, {uri, complete:true}) })
        })
      })
    }
  }

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

  function readIndex(uri, callback) {
    invoke("readText", {uri: uri}, (error, data) => {
      if (error) { callback(error); return }
      try {
        if (!data || typeof data.text !== "string" || data.text.length > 512) throw new Error("Invalid index")
        const parsed = JSON.parse(data.text)
        if (parsed.version !== 1 || typeof parsed.uri !== "string" ||
            (parsed.uri !== "" && !imagePattern.test(parsed.uri))) throw new Error("Invalid background reference")
        callback(null, parsed.uri)
      } catch (cause) { callback({code: "BACKGROUND_INDEX_INVALID", cause: cause}) }
    })
  }

  function load(callback) {
    if (current !== null) { callback(null, current); return }
    waiters.push(callback)
    if (loading) return
    loading = true
    const finish = (error, uri) => {
      if (!error) current = uri
      loading = false
      const callbacks = waiters
      waiters = []
      callbacks.forEach((done) => done(error, uri))
    }
    readIndex(indexUri, (error, uri) => {
      if (!error) { indexExists = true; finish(null, uri); return }
      // 只在主索引不存在/损坏时检查备份；I/O失败不当成空索引。
      if (error.code !== 301 && error.code !== "BACKGROUND_INDEX_INVALID") { finish(error); return }
      indexExists = error.code !== 301
      readIndex(backupUri, (backupError, backup) => {
        if (!backupError) {
          const restore = () => invoke("move", {srcUri: backupUri, dstUri: indexUri}, (restoreError) => {
            if (!restoreError) indexExists = true
            finish(restoreError, backup)
          })
          if (!indexExists) { restore(); return }
          // 有有效备份时才移除损坏索引；恢复失败仍保留备份供下次重试。
          invoke("delete", {uri: indexUri}, (deleteError) => {
            if (deleteError) { finish(deleteError); return }
            indexExists = false
            restore()
          })
          return
        }
        if (error.code !== 301 || backupError.code !== 301) { finish(error.code !== 301 ? error : backupError); return }
        // 仅无主索引/备份的旧版本首次加载扫描；恢复默认的空引用不会回退旧图。
        invoke("list", {uri: "internal://files/"}, (listError, data) => {
          if (listError) { finish(listError); return }
          const images = (data.fileList || []).filter((item) => imagePattern.test(item.uri || ""))
            .sort((a, b) => Number(b.uri.match(/bg_(\d+)/)[1]) - Number(a.uri.match(/bg_(\d+)/)[1]))
          const legacy = images.length ? images[0].uri : ""
          commit(legacy, (commitError) => finish(commitError, legacy))
        })
      })
    })
  }

  function commit(uri, callback) {
    invoke("writeText", {uri: tempIndexUri, text: JSON.stringify({version: 1, uri: uri})}, (writeError) => {
      if (writeError) { callback(writeError); return }
      const publish = (backedUp) => {
        invoke("move", {srcUri: tempIndexUri, dstUri: indexUri}, (error) => {
          if (error) {
            if (!backedUp) { callback(error); return }
            invoke("move", {srcUri: backupUri, dstUri: indexUri}, (rollbackError) => {
              indexExists = !rollbackError
              callback(error)
            })
            return
          }
          indexExists = true
          current = uri
          invoke("delete", {uri: backupUri}, () => callback(null))
        })
      }
      if (!indexExists) { publish(false); return }
      // 不依赖固件move覆盖行为；旧索引完整保留在bak中直到新索引提交。
      invoke("delete", {uri: backupUri}, (deleteError) => {
        if (deleteError && deleteError.code !== 301) { callback(deleteError); return }
        invoke("move", {srcUri: indexUri, dstUri: backupUri}, (backupError) => {
          if (backupError) { callback(backupError); return }
          indexExists = false
          publish(true)
        })
      })
    })
  }

  function clean(callback) {
    // 仅提交成功且保持单飞期间清理；索引读取失败时绝不猜测孤立文件。
    invoke("list", {uri: "internal://files/"}, (error, data) => {
      if (error) { callback(); return }
      const garbage = (data.fileList || []).map((item) => item.uri).filter((uri) =>
        uri !== current && (imagePattern.test(uri || "") || pendingPattern.test(uri || "")))
      let offset = 0
      const next = () => {
        if (offset >= garbage.length) { callback(); return }
        invoke("delete", {uri: garbage[offset++]}, next)
      }
      next()
    })
  }

  function reset(callback) {
    if (busy) { callback({code: "BACKGROUND_BUSY"}); return }
    busy = true
    const finish = once((error) => { busy = false; callback(error, error ? undefined : "") })
    load((error) => {
      if (error) { finish(error); return }
      commit("", (commitError) => {
        if (commitError) { finish(commitError); return }
        clean(() => finish(null))
      })
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
        // 新图落盘后提交持久引用；引用失败的新图只作为孤立文件，不会被加载。
        invoke("move", {srcUri: temporary, dstUri: uri}, (moveError) => {
          if (moveError) { discard(moveError); return }
          commit(uri, (commitError) => {
            if (commitError) {
              invoke("delete", {uri: uri}, () => finish(commitError))
              return
            }
            clean(() => finish(null, uri))
          })
        })
      })
    })
  }

  return {load: load, save: save, reset: reset, receive: receive}
}

export default {createBackgroundStore, imageInfo}
