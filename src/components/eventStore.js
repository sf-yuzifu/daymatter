// 事件存储：统一读取、迁移、校验、增删改与原子提交（D-08～D-16）。
// 数据文件 internal://files/events.json，格式
// {version, revision, primaryId, watchfacePending, events:[{id,...}]}。
// - 读：文件不存在 → 初始化空列表；JSON 损坏 / 类型错误 → 现场备份 .bad 后尝试从
//   .bak / .tmp 恢复，恢复失败则拒绝读写，绝不把失败当空列表覆盖；
//   I/O 错误 → 直接拒绝。
// - 写：先写 .tmp 再 move 替换；直接 move 失败且目标存在时，经 .bak 备份再移入，
//   失败回滚 .bak，保证旧有效数据不丢。
// - 并发：同一文件的整个「读—改—写」周期在内存队列中串行执行。
// - 身份：新事件分配持久稳定 ID；旧数据迁移 ID 由内容决定，重复读取保持一致。
// - 表盘（D-17～D-20）：primaryId 与 on_index 相互独立；每次提交后按主事件维护
//   internal://files/date.txt，失败只标记 watchfacePending 并报告分项结果，
//   下次进入补写，不把两个文件当成天然原子提交。

const DATA_VERSION = 2
const MAX_EVENTS = 200
const MAX_NAME_LENGTH = 50
const THEME_COLORS = ["#3184d0", "#f78803", "#e74c3c", "#27ae60", "#9b59b6"]
const FILE_NOT_FOUND = 301

function toBoolean(value) {
  if (value === true || value === "true") return {valid: true, value: true}
  if (value === false || value === "false") return {valid: true, value: false}
  return {valid: false, value: false}
}

function hashString(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

function createEventStore(options) {
  const file = options.file
  const dateUtils = options.dateUtils
  const uri = options.uri || "internal://files/events.json"
  const bakUri = uri + ".bak"
  const tmpUri = uri + ".tmp"
  const badUri = uri + ".bad"
  const now = options.now || (() => Date.now())
  const watchFace = options.watchFace || null
  // 表盘名称兜底文案由注入方提供（$t("unnamedEvent")），保持模块无多语言依赖
  const watchFaceFallbackName = options.watchFaceFallbackName || ""
  let sequence = 0
  // 会话内是否已按当前数据维护过表盘文件（避免每次读取都写盘）
  let watchFaceChecked = false

  // 文件级串行队列：前序失败不阻塞后续任务
  const pending = []
  let processing = false

  function enqueue(task, callback) {
    pending.push({task: task, callback: callback})
    pump()
  }

  function pump() {
    if (processing) return
    const item = pending.shift()
    if (!item) return
    processing = true
    item.task(function (error, result) {
      processing = false
      // 分项结果（WATCHFACE_FAIL）需要同时带回已提交的数据，故错误时也传 result
      if (item.callback) item.callback(error || null, result)
      pump()
    })
  }

  function fileRead(targetUri, callback) {
    file.readText({
      uri: targetUri,
      success: (data) => callback(null, data && typeof data.text === "string" ? data.text : ""),
      fail: (data, code) => callback({type: "io", code: code || 300, data: data})
    })
  }

  function fileWrite(targetUri, text, callback) {
    file.writeText({
      uri: targetUri,
      text: text,
      success: () => callback(null),
      fail: (data, code) => callback({type: "write", code: code || 300, data: data})
    })
  }

  function fileMove(srcUri, dstUri, callback) {
    file.move({
      srcUri: srcUri,
      dstUri: dstUri,
      success: () => callback(null),
      fail: (data, code) => callback({type: "write", code: code || 300, data: data})
    })
  }

  // 清理类操作全部 best-effort，不阻塞主流程
  function fileDelete(targetUri, callback) {
    file.delete({uri: targetUri, success: () => callback && callback(), fail: () => callback && callback()})
  }

  function fileCopy(srcUri, dstUri, callback) {
    if (typeof file.copy !== "function") {
      callback({type: "write", code: 300})
      return
    }
    file.copy({
      srcUri: srcUri,
      dstUri: dstUri,
      success: () => callback(null),
      fail: (data, code) => callback({type: "write", code: code || 300})
    })
  }

  function fileExists(targetUri, callback) {
    if (typeof file.access === "function") {
      file.access({uri: targetUri, success: () => callback(true), fail: () => callback(false)})
      return
    }
    fileRead(targetUri, (error) => callback(!error))
  }

  function emptyState() {
    return {version: DATA_VERSION, revision: 0, primaryId: "", watchfacePending: false, events: []}
  }

  // 主事件默认规则：文件中第一个「首页展示」的事件；都没有则不设主事件
  function defaultPrimaryId(events) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].on_index === true) return events[i].id
    }
    return ""
  }

  function migrationId(index, source) {
    const seed = [index, source.name, source.date, source.on_index, source.IFStaringDay, source.themeColor].join("|")
    return "m" + hashString(seed)
  }

  function normalizeEvent(raw, index) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    const event = Object.assign({}, source)
    let changed = raw !== source

    if (typeof source.id !== "string" || source.id === "") {
      event.id = migrationId(index, source)
      changed = true
    }
    if (typeof source.name !== "string") {
      event.name = ""
      changed = true
    }
    const normalizedDate = dateUtils.normalizeDate(source.date)
    if (normalizedDate) {
      if (normalizedDate !== source.date) changed = true
      event.date = normalizedDate
    } else {
      event.date = typeof source.date === "string" ? source.date : ""
      changed = true
    }
    const onIndex = toBoolean(source.on_index)
    if (!onIndex.valid) {
      event.on_index = true
      changed = true
    } else if (source.on_index !== onIndex.value) {
      event.on_index = onIndex.value
      changed = true
    }
    const includeStart = toBoolean(source.IFStaringDay)
    if (!includeStart.valid) {
      event.IFStaringDay = false
      changed = true
    } else if (source.IFStaringDay !== includeStart.value) {
      event.IFStaringDay = includeStart.value
      changed = true
    }
    if (typeof source.themeColor !== "string") {
      event.themeColor = ""
      changed = true
    }
    return {event: event, changed: changed}
  }

  function normalizeState(parsed) {
    let eventsRaw
    let revision = 0
    let migrated = false
    let rawPrimary
    let rawPending
    if (Array.isArray(parsed)) {
      eventsRaw = parsed
      migrated = true
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.events)) {
      eventsRaw = parsed.events
      if (Number.isInteger(parsed.revision) && parsed.revision >= 0) revision = parsed.revision
      else migrated = true
      if (parsed.version !== DATA_VERSION) migrated = true
      rawPrimary = parsed.primaryId
      rawPending = parsed.watchfacePending
    } else {
      return null
    }
    const events = []
    for (let i = 0; i < eventsRaw.length; i++) {
      const normalized = normalizeEvent(eventsRaw[i], i)
      if (normalized.changed) migrated = true
      events.push(normalized.event)
    }

    // 主事件：旧数据或失效引用按默认规则选定（D-17 明确规则）
    let primaryId = ""
    if (typeof rawPrimary === "string") {
      if (rawPrimary === "") {
        primaryId = ""
      } else if (indexOfId(events, rawPrimary) >= 0) {
        primaryId = rawPrimary
      } else {
        primaryId = defaultPrimaryId(events)
        migrated = true
      }
    } else {
      if (rawPrimary !== undefined) migrated = true
      primaryId = defaultPrimaryId(events)
      if (primaryId !== "") migrated = true
    }

    let watchfacePending = false
    if (typeof rawPending === "boolean") watchfacePending = rawPending
    else if (rawPending !== undefined) migrated = true

    return {
      state: {
        version: DATA_VERSION,
        revision: revision,
        primaryId: primaryId,
        watchfacePending: watchfacePending,
        events: events
      },
      migrated: migrated
    }
  }

  // 损坏现场复制为 .bad（保留主文件原位，后续读取仍会拒绝，不会当空列表覆盖）
  function backupCorrupt(callback) {
    fileDelete(badUri, () => fileCopy(uri, badUri, () => callback()))
  }

  function restoreCandidate(candidateUri, callback) {
    fileRead(candidateUri, (error, text) => {
      if (error) return callback(null)
      let parsed = null
      try {
        parsed = text && text.trim() ? JSON.parse(text) : null
      } catch (e) {
        parsed = null
      }
      const normalized = parsed === null ? null : normalizeState(parsed)
      if (!normalized) return callback(null)
      fileMove(candidateUri, uri, (moveError) => {
        if (moveError) {
          // move 覆盖失败时退化为删除目标再移动
          fileDelete(uri, () => {
            fileMove(candidateUri, uri, (retryError) => callback(retryError ? null : normalized))
          })
          return
        }
        callback(normalized)
      })
    })
  }

  function recoverFromBackup(callback) {
    restoreCandidate(bakUri, (fromBak) => {
      if (fromBak) {
        fileDelete(tmpUri, () => callback(fromBak))
        return
      }
      restoreCandidate(tmpUri, (fromTmp) => {
        if (fromTmp) {
          fileDelete(bakUri, () => callback(fromTmp))
          return
        }
        callback(null)
      })
    })
  }

  function loadState(callback) {
    fileRead(uri, (error, text) => {
      if (error) {
        if (error.code === FILE_NOT_FOUND) {
          recoverFromBackup((recovered) => callback(null, recovered || {state: emptyState(), migrated: false}))
          return
        }
        callback({type: "io", code: error.code})
        return
      }
      let parsed = null
      let parseFailed = false
      try {
        parsed = text && text.trim() ? JSON.parse(text) : null
      } catch (e) {
        parseFailed = true
      }
      const normalized = parseFailed ? null : normalizeState(parsed)
      if (!normalized) {
        backupCorrupt(() => {
          recoverFromBackup((recovered) => {
            if (recovered) callback(null, recovered)
            else callback({type: "corrupt"})
          })
        })
        return
      }
      callback(null, {state: normalized.state, migrated: normalized.migrated})
    })
  }

  // 原子提交：.tmp 写入 → move 替换；直接替换失败且目标存在时经 .bak 安全交换
  function commitState(state, callback) {
    fileWrite(tmpUri, JSON.stringify(state), (writeError) => {
      if (writeError) {
        callback({type: "write", code: writeError.code, cause: writeError})
        return
      }
      fileMove(tmpUri, uri, (moveError) => {
        if (!moveError) {
          fileDelete(bakUri, () => callback(null))
          return
        }
        fileExists(uri, (exists) => {
          if (!exists) {
            callback({type: "write", code: moveError.code, cause: moveError})
            return
          }
          fileDelete(bakUri, () => {
            fileMove(uri, bakUri, (bakError) => {
              if (bakError) {
                // 旧文件未被移动，现场完好
                callback({type: "write", code: bakError.code, cause: bakError})
                return
              }
              fileMove(tmpUri, uri, (finalError) => {
                if (!finalError) {
                  fileDelete(bakUri, () => callback(null))
                  return
                }
                // 回滚：恢复备份，旧有效数据不丢
                fileMove(bakUri, uri, () => callback({type: "write", code: finalError.code, cause: finalError}))
              })
            })
          })
        })
      })
    })
  }

  // 表盘文件维护（D-18 / D-20）：事件数据已提交后再维护 date.txt；
  // 失败只标记 watchfacePending 并回报分项结果，两个文件不当成原子提交
  function syncWatchFace(state, done) {
    if (!watchFace) {
      done(null, {skipped: true})
      return
    }
    watchFace.sync(state, watchFaceFallbackName, (syncError, info) => {
      if (!syncError) {
        if (state.watchfacePending) {
          // 补写成功：清标记并重新落盘（best-effort）
          state.watchfacePending = false
          commitState(state, () => done(null, {skipped: false}))
          return
        }
        done(null, info || {skipped: false})
        return
      }
      state.watchfacePending = true
      commitState(state, () => done({code: "WATCHFACE_FAIL", cause: syncError}, {skipped: false}))
    })
  }

  // 提交事件数据后维护表盘；payload 由调用方给出结果字段
  function commitAndSync(state, buildPayload, done) {
    commitState(state, (commitError) => {
      if (commitError) {
        done({code: "SAVE_FAIL", cause: commitError})
        return
      }
      syncWatchFace(state, (syncError, info) => {
        const payload = buildPayload ? buildPayload(state) : {}
        if (syncError) {
          done({code: "WATCHFACE_FAIL", cause: syncError.cause}, Object.assign({watchface: {ok: false}}, payload))
          return
        }
        done(null, Object.assign({watchface: {ok: true, skipped: !!(info && info.skipped)}}, payload))
      })
    })
  }

  function validateEventInput(input, partial) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {ok: false, error: {code: "INVALID_EVENT"}}
    }
    if (!partial || input.name !== undefined) {
      if (typeof input.name !== "string" || input.name.trim() === "") {
        return {ok: false, error: {code: "NAME_REQUIRED"}}
      }
      if (input.name.trim().length > MAX_NAME_LENGTH) {
        return {ok: false, error: {code: "NAME_TOO_LONG"}}
      }
    }
    if (!partial || input.date !== undefined) {
      if (!dateUtils.normalizeDate(input.date)) return {ok: false, error: {code: "DATE_INVALID"}}
    }
    for (const field of ["on_index", "IFStaringDay"]) {
      if (input[field] !== undefined && !toBoolean(input[field]).valid) {
        return {ok: false, error: {code: "INVALID_BOOLEAN", field: field}}
      }
    }
    if (input.themeColor !== undefined) {
      if (typeof input.themeColor !== "string") return {ok: false, error: {code: "INVALID_COLOR"}}
      if (input.themeColor !== "" && THEME_COLORS.indexOf(input.themeColor) === -1) {
        return {ok: false, error: {code: "INVALID_COLOR"}}
      }
    }
    return {ok: true}
  }

  function createId(events) {
    let id
    do {
      sequence += 1
      id = "e" + now().toString(36) + "-" + sequence.toString(36)
    } while (events.some((event) => event.id === id))
    return id
  }

  function buildEvent(state, input) {
    const onIndex = toBoolean(input.on_index)
    const includeStart = toBoolean(input.IFStaringDay)
    return {
      id: createId(state.events),
      name: input.name.trim(),
      date: dateUtils.normalizeDate(input.date),
      on_index: onIndex.valid ? onIndex.value : true,
      IFStaringDay: includeStart.valid ? includeStart.value : false,
      themeColor: typeof input.themeColor === "string" ? input.themeColor : ""
    }
  }

  // 只更新消息中明确给出的字段，其余字段（主题色 / 显示设置 / 未来扩展）原样保留
  function applyPatch(event, patch) {
    if (patch.name !== undefined) event.name = patch.name.trim()
    if (patch.date !== undefined) event.date = dateUtils.normalizeDate(patch.date)
    if (patch.on_index !== undefined) event.on_index = toBoolean(patch.on_index).value
    if (patch.IFStaringDay !== undefined) event.IFStaringDay = toBoolean(patch.IFStaringDay).value
    if (patch.themeColor !== undefined) event.themeColor = patch.themeColor
  }

  function indexOfId(events, id) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].id === id) return i
    }
    return -1
  }

  // 读取：返回 {events, revision, primaryId, migrated}；旧数据会 best-effort 落盘升级
  function read(callback) {
    loadState((error, result) => {
      if (error) {
        callback(error)
        return
      }
      if (result.migrated) {
        // 迁移（含主事件规则落定）后立即升级落盘并维护表盘文件
        watchFaceChecked = true
        enqueue((done) => commitAndSync(result.state, null, () => done(null)), () => {})
      } else if (watchFace && (!watchFaceChecked || result.state.watchfacePending)) {
        // 会话内首次读取维护一次表盘文件（内容未变则跳过写入）；
        // 上次写入失败标记的待补写状态在本次进入重试（D-20）
        watchFaceChecked = true
        enqueue((done) => syncWatchFace(result.state, () => done(null)), () => {})
      }
      callback(null, {
        events: result.state.events,
        revision: result.state.revision,
        primaryId: result.state.primaryId,
        migrated: result.migrated
      })
    })
  }

  function add(input, callback) {
    const validation = validateEventInput(input, false)
    if (!validation.ok) {
      callback(validation.error)
      return
    }
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        if (result.state.events.length >= MAX_EVENTS) return done({code: "EVENT_LIMIT"})
        const event = buildEvent(result.state, input)
        result.state.events.push(event)
        result.state.revision += 1
        commitAndSync(
          result.state,
          (state) => ({event: event, revision: state.revision, events: state.events, primaryId: state.primaryId}),
          done
        )
      })
    }, callback)
  }

  function update(id, patch, callback) {
    const validation = validateEventInput(patch, true)
    if (!validation.ok) {
      callback(validation.error)
      return
    }
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        const index = indexOfId(result.state.events, id)
        if (index < 0) return done({code: "NOT_FOUND"})
        applyPatch(result.state.events[index], patch)
        result.state.revision += 1
        commitAndSync(
          result.state,
          (state) => ({event: state.events[index], revision: state.revision, events: state.events, primaryId: state.primaryId}),
          done
        )
      })
    }, callback)
  }

  // 旧插件协议兼容：在队列内按当下数据解析下标对应的稳定 ID，再按 ID 操作
  function updateByIndex(index, patch, callback) {
    const validation = validateEventInput(patch, true)
    if (!validation.ok) {
      callback(validation.error)
      return
    }
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        if (index < 0 || index >= result.state.events.length) return done({code: "NOT_FOUND"})
        applyPatch(result.state.events[index], patch)
        result.state.revision += 1
        commitAndSync(
          result.state,
          (state) => ({event: state.events[index], revision: state.revision, events: state.events, primaryId: state.primaryId}),
          done
        )
      })
    }, callback)
  }

  // 删除主事件时的替代规则：顺位第一个「首页展示」的事件接管，否则清空表盘
  function dropPrimaryIfNeeded(state, removedId) {
    if (state.primaryId === removedId) state.primaryId = defaultPrimaryId(state.events)
  }

  function removeById(id, callback) {
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        const index = indexOfId(result.state.events, id)
        if (index < 0) return done({code: "NOT_FOUND"})
        result.state.events.splice(index, 1)
        dropPrimaryIfNeeded(result.state, id)
        result.state.revision += 1
        commitAndSync(
          result.state,
          (state) => ({id: id, revision: state.revision, events: state.events, primaryId: state.primaryId}),
          done
        )
      })
    }, callback)
  }

  function remove(index, callback) {
    // 优先按稳定 ID；旧插件协议传下标时回退按当前位置删除（在队列内解析）
    if (typeof index === "number") {
      enqueue((done) => {
        loadState((error, result) => {
          if (error) return done(error)
          if (index < 0 || index >= result.state.events.length) return done({code: "NOT_FOUND"})
          const id = result.state.events[index].id
          result.state.events.splice(index, 1)
          dropPrimaryIfNeeded(result.state, id)
          result.state.revision += 1
          commitAndSync(
            result.state,
            (state) => ({id: id, revision: state.revision, events: state.events, primaryId: state.primaryId}),
            done
          )
        })
      }, callback)
      return
    }
    removeById(index, callback)
  }

  // 主事件切换（D-17 / D-18）：与 on_index 无关，传空串取消主事件
  function setPrimary(id, callback) {
    const target = id === undefined || id === null ? "" : String(id)
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        const state = result.state
        if (target !== "" && indexOfId(state.events, target) < 0) return done({code: "NOT_FOUND"})
        state.primaryId = target
        state.revision += 1
        commitAndSync(
          state,
          (current) => ({revision: current.revision, events: current.events, primaryId: current.primaryId}),
          done
        )
      })
    }, callback)
  }

  return {
    read: read,
    add: add,
    update: update,
    updateByIndex: updateByIndex,
    remove: remove,
    setPrimary: setPrimary
  }
}

export default {
  DATA_VERSION: DATA_VERSION,
  MAX_EVENTS: MAX_EVENTS,
  MAX_NAME_LENGTH: MAX_NAME_LENGTH,
  THEME_COLORS: THEME_COLORS,
  createEventStore: createEventStore
}
