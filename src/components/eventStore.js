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

// B-09：显式采用 ECMAScript 空白集合，Rust 端保持相同集合；按 Unicode 码点计数。
function trimName(name) {
  return name.replace(/^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g, "")
}

function validateName(name, previousName) {
  if (typeof name !== "string" || trimName(name) === "") return "NAME_REQUIRED"
  if (name === previousName) return null // 旧名称原样保留，不静默归一或截断
  const text = trimName(name)
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return "NAME_INVALID"
    } else if (code >= 0xdc00 && code <= 0xdfff) return "NAME_INVALID"
    count++
  }
  return count > MAX_NAME_LENGTH ? "NAME_TOO_LONG" : null
}

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
    return {version: DATA_VERSION, revision: 0, primaryId: "", watchfacePending: false, sortMode: "created", events: []}
  }

  // 主事件默认规则：文件中第一个「首页展示」的事件；都没有则不设主事件
  function defaultPrimaryId(events) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].on_index === true && !events[i].archived) return events[i].id
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
    for (const field of ["pinned", "archived"]) {
      const flag = toBoolean(source[field])
      event[field] = flag.valid ? flag.value : false
      if (event[field] !== source[field]) changed = true
    }
    event.sortOrder = Number.isSafeInteger(source.sortOrder) && source.sortOrder >= 0 ? source.sortOrder : index
    event.category = ["uncategorized", "birthday", "study", "life", "anniversary"].indexOf(source.category) >= 0 ? source.category : "uncategorized"
    if (event.sortOrder !== source.sortOrder || event.category !== source.category) changed = true
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
      } else if (indexOfId(events, rawPrimary) >= 0 && !events[indexOfId(events, rawPrimary)].archived) {
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

    const sortMode = ["created", "near", "manual"].indexOf(parsed.sortMode) >= 0 ? parsed.sortMode : "created"
    if (parsed.sortMode !== sortMode) migrated = true
    return {
      state: {
        sortMode: sortMode,
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

  function validateEventInput(input, partial, previousName) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {ok: false, error: {code: "INVALID_EVENT"}}
    }
    if (input.calendar !== undefined && !dateUtils.validCalendar(input)) return {ok:false, error:{code:"INVALID_LUNAR"}}
    if (!partial || input.name !== undefined) {
      const code = validateName(input.name, previousName)
      if (code) return {ok: false, error: {code: code}}
    }
    if (!partial || input.date !== undefined) {
      if (!dateUtils.normalizeDate(input.date)) return {ok: false, error: {code: "DATE_INVALID"}}
    }
    for (const field of ["on_index", "IFStaringDay", "pinned", "archived"]) {
      if (input[field] !== undefined && !toBoolean(input[field]).valid) {
        return {ok: false, error: {code: "INVALID_BOOLEAN", field: field}}
      }
    }
    if (input.repeat !== undefined && ["none", "yearly"].indexOf(input.repeat) === -1) return {ok: false, error: {code: "INVALID_REPEAT"}}
    if (input.displayUnit !== undefined && ["days", "weeks", "months", "years"].indexOf(input.displayUnit) === -1) return {ok: false, error: {code: "INVALID_UNIT"}}
    if (input.category !== undefined && ["uncategorized", "birthday", "study", "life", "anniversary"].indexOf(input.category) < 0) return {ok: false, error: {code: "INVALID_CATEGORY"}}
    if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) return {ok: false, error: {code: "INVALID_ORDER"}}
    if (input.moveDirection !== undefined && ["up", "down"].indexOf(input.moveDirection) < 0) return {ok: false, error: {code: "INVALID_MOVE"}}
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
      name: trimName(input.name),
      repeat: input.repeat || "none",
      displayUnit: input.displayUnit || "days",
      pinned: toBoolean(input.pinned).value,
      archived: toBoolean(input.archived).value,
      category: input.category || "uncategorized",
      sortOrder: Math.min(Number.MAX_SAFE_INTEGER, state.events.reduce((max, e) => Math.max(max, e.sortOrder), -1) + 1),
      date: dateUtils.normalizeDate(input.date),
      calendar: input.calendar || "solar",
      lunarDate: input.lunarDate || null,
      lunarTableVersion: input.lunarTableVersion,
      lunarLeapPolicy: input.lunarLeapPolicy,
      lunarShortMonthPolicy: input.lunarShortMonthPolicy,
      on_index: onIndex.valid ? onIndex.value : true,
      IFStaringDay: includeStart.valid ? includeStart.value : false,
      themeColor: typeof input.themeColor === "string" ? input.themeColor : ""
    }
  }

  // 只更新消息中明确给出的字段，其余字段（主题色 / 显示设置 / 未来扩展）原样保留
  function applyPatch(event, patch) {
    if (event.calendar === "lunar" && patch.calendar === undefined && patch.date !== undefined && dateUtils.normalizeDate(patch.date) !== event.date) return false
    if (patch.calendar !== undefined) for (const field of ["calendar","lunarDate","lunarTableVersion","lunarLeapPolicy","lunarShortMonthPolicy"]) event[field] = patch[field]
    for (const field of ["pinned", "archived"]) if (patch[field] !== undefined) event[field] = toBoolean(patch[field]).value
    for (const field of ["category", "sortOrder"]) if (patch[field] !== undefined) event[field] = patch[field]
    if (patch.repeat !== undefined) event.repeat = patch.repeat
    if (patch.displayUnit !== undefined) event.displayUnit = patch.displayUnit
    if (patch.name !== undefined && patch.name !== event.name) event.name = trimName(patch.name)
    if (patch.date !== undefined) event.date = dateUtils.normalizeDate(patch.date)
    if (patch.on_index !== undefined) event.on_index = toBoolean(patch.on_index).value
    if (patch.IFStaringDay !== undefined) event.IFStaringDay = toBoolean(patch.IFStaringDay).value
    if (patch.themeColor !== undefined) event.themeColor = patch.themeColor
    return true
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
      } else if (watchFace) {
        // 每次进入/跨午夜维护年度日期，内容未变由表盘模块跳过写入。
        watchFaceChecked = true
        enqueue((done) => loadState((error, latest) => {
          if (error) return done(error)
          syncWatchFace(latest.state, () => done(null))
        }), () => {})
      }
      callback(null, {
        events: result.state.events,
        revision: result.state.revision,
        primaryId: result.state.primaryId,
        sortMode: result.state.sortMode,
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
    const validation = validateEventInput(patch, true, patch && patch.name)
    if (!validation.ok) {
      callback(validation.error)
      return
    }
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        const index = indexOfId(result.state.events, id)
        if (index < 0) return done({code: "NOT_FOUND"})
        const validation = validateEventInput(patch, true, result.state.events[index].name)
        if (!validation.ok) return done(validation.error)
        if (!applyPatch(result.state.events[index], patch)) return done({code:"LUNAR_DATE_PROTECTED"})
        if (result.state.events[index].archived) dropPrimaryIfNeeded(result.state, id)
        if (patch.moveDirection) {
          reorder(result.state, id, patch.moveDirection)
          result.state.sortMode = "manual"
        }
        result.state.revision += 1
        commitAndSync(
          result.state,
           (state) => ({event: state.events[index], revision: state.revision, events: state.events, primaryId: state.primaryId, sortMode: state.sortMode}),
          done
        )
      })
    }, callback)
  }

  // 旧插件协议兼容：在队列内按当下数据解析下标对应的稳定 ID，再按 ID 操作
  function updateByIndex(index, patch, callback) {
    const validation = validateEventInput(patch, true, patch && patch.name)
    if (!validation.ok) {
      callback(validation.error)
      return
    }
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        if (index < 0 || index >= result.state.events.length) return done({code: "NOT_FOUND"})
        const validation = validateEventInput(patch, true, result.state.events[index].name)
        if (!validation.ok) return done(validation.error)
        if (!applyPatch(result.state.events[index], patch)) return done({code:"LUNAR_DATE_PROTECTED"})
        if (result.state.events[index].archived) dropPrimaryIfNeeded(result.state, result.state.events[index].id)
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
  function setPrimary(id, callback, expectedPrimaryId) {
    const target = id === undefined || id === null ? "" : String(id)
    enqueue((done) => {
      loadState((error, result) => {
        if (error) return done(error)
        const state = result.state
        if (expectedPrimaryId !== undefined && state.primaryId !== expectedPrimaryId) return done({code: "PRIMARY_CHANGED"})
        if (target !== "" && indexOfId(state.events, target) < 0) return done({code: "NOT_FOUND"})
        if (target !== "" && state.events[indexOfId(state.events, target)].archived) return done({code: "ARCHIVED_PRIMARY"})
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

  function backupChecksum(value) {
    const canonical = (v) => {
      if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]"
      if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
      if (typeof v === "number") {
        const bytes = new DataView(new ArrayBuffer(8))
        bytes.setFloat64(0, v, false)
        return "n" + ("00000000" + bytes.getUint32(0, false).toString(16)).slice(-8) + ("00000000" + bytes.getUint32(4, false).toString(16)).slice(-8)
      }
      return JSON.stringify(v)
    }
    const text = canonical(value)
    let hash = 5381
    for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0
    return ("00000000" + hash.toString(16)).slice(-8)
  }

  function restoreBackup(input, callback) {
    let backup
    try { backup = JSON.parse(JSON.stringify(input.backup)) } catch (e) { callback({code: "INVALID_BACKUP"}); return }
    const data = backup && backup.data
    const bounded = (value, depth) => {
      if (depth > 32) return false
      if (Array.isArray(value)) return value.every(v => bounded(v, depth + 1))
      if (value && typeof value === "object") return Object.keys(value).every(k => ["__proto__", "constructor", "prototype"].indexOf(k) < 0 && bounded(value[k], depth + 1))
      return true
    }
    if (!bounded(backup, 0)) { callback({code: "INVALID_BACKUP"}); return }
    if (!data || backup.format !== "daymatter-backup" || backup.backupVersion !== 1 || data.version !== DATA_VERSION ||
        backup.checksum !== backupChecksum(data) || JSON.stringify(backup).length > 240 * 1024 ||
        !Array.isArray(data.events) || data.events.length > MAX_EVENTS ||
        ["created", "near", "manual"].indexOf(data.sortMode) < 0 || typeof data.primaryId !== "string" ||
        ["merge", "replace"].indexOf(input.mode) < 0 || ["keep", "overwrite"].indexOf(input.conflict) < 0 ||
        !Number.isSafeInteger(input.expectedRevision)) { callback({code: "INVALID_BACKUP"}); return }
    const ids = []
    for (const event of data.events) {
      const validation = validateEventInput(event, false, event && event.name)
      if (!dateUtils.validCalendar(event)) { callback({code:"INVALID_LUNAR"}); return }
      if (!validation.ok || typeof event.id !== "string" || !event.id || event.id.length > 128 ||
          ids.indexOf(event.id) >= 0 || typeof event.on_index !== "boolean" || typeof event.IFStaringDay !== "boolean" ||
          event.date !== dateUtils.normalizeDate(event.date) || event.name.length > 4096 || typeof event.themeColor !== "string" ||
          ["pinned", "archived"].some(k => event[k] !== undefined && typeof event[k] !== "boolean")) {
        callback({code: "INVALID_BACKUP"}); return
      }
      ids.push(event.id)
    }
    if (data.primaryId && !data.events.some(e => e.id === data.primaryId && !e.archived)) { callback({code: "INVALID_BACKUP"}); return }
    enqueue((done) => loadState((error, result) => {
      if (error) return done(error)
      const state = result.state
      if (state.revision !== input.expectedRevision) return done({code: "REVISION_CHANGED"})
      let events = state.events.slice()
      if (input.mode === "replace") events = data.events
      else for (const incoming of data.events) {
        const index = indexOfId(events, incoming.id)
        if (index < 0) events.push(incoming)
        else if (input.conflict === "overwrite") events[index] = incoming
      }
      if (events.length > MAX_EVENTS) return done({code: "LIMIT_REACHED"})
      state.events = events.map((event, index) => normalizeEvent(event, index).event)
      if (input.mode === "replace") { state.primaryId = data.primaryId; state.sortMode = data.sortMode }
      if (state.primaryId && !state.events.some(e => e.id === state.primaryId && !e.archived)) state.primaryId = defaultPrimaryId(state.events)
      state.watchfacePending = false
      state.revision += 1
      commitAndSync(state, current => ({revision:current.revision, primaryId:current.primaryId, sortMode:current.sortMode, events:current.events}), done)
    }), callback)
  }

  function setSortMode(mode, callback) {
    if (["created", "near", "manual"].indexOf(mode) < 0) return callback({code: "INVALID_SORT"})
    enqueue((done) => loadState((error, result) => {
      if (error) return done(error)
      result.state.sortMode = mode
      result.state.revision++
      commitAndSync(result.state, (state) => ({revision: state.revision, sortMode: state.sortMode}), done)
    }), callback)
  }

  function reorder(state, id, direction) {
    const event = state.events[indexOfId(state.events, id)]
    const group = state.events.map((e, i) => ({e, i})).filter(({e}) => e.pinned === event.pinned && e.archived === event.archived)
      .sort((a, b) => a.e.sortOrder - b.e.sortOrder || a.i - b.i)
    const position = group.findIndex(({e}) => e.id === id)
    const next = position + (direction === "up" ? -1 : 1)
    if (next < 0 || next >= group.length) return false
    const other = group[next]; group[next] = group[position]; group[position] = other
    group.forEach(({e}, i) => { e.sortOrder = i })
    return true
  }

  // 整组重编号避免同值无法移动和安全整数溢出；不重排存储数组/旧下标。
  function move(id, direction, callback) {
    if (direction !== "up" && direction !== "down") return callback({code: "INVALID_MOVE"})
    enqueue((done) => loadState((error, result) => {
      if (error) return done(error)
      const state = result.state
      const index = indexOfId(state.events, id)
      if (index < 0) return done({code: "NOT_FOUND"})
      const event = state.events[index]
      if (!reorder(state, id, direction)) return done({code: "MOVE_BOUNDARY"})
      state.sortMode = "manual"
      state.revision++
      commitAndSync(state, (current) => ({event, events: current.events, primaryId: current.primaryId, revision: current.revision, sortMode: current.sortMode}), done)
    }), callback)
  }

  return {
    setSortMode: setSortMode,
    move: move,
    read: read,
    add: add,
    update: update,
    updateByIndex: updateByIndex,
    remove: remove,
    setPrimary: setPrimary,
    restoreBackup: restoreBackup
  }
}

export default {
  DATA_VERSION: DATA_VERSION,
  MAX_EVENTS: MAX_EVENTS,
  MAX_NAME_LENGTH: MAX_NAME_LENGTH,
  THEME_COLORS: THEME_COLORS,
  createEventStore: createEventStore
}
