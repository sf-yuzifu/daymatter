-- Build script embeds LOGIC and DEVICE above this entry point.
local lvgl = require("lvgl")
local dataman = require("dataman")
local function imagePath(name) return SCRIPT_PATH .. name end
local lastFileText, parsedEvent
local eventPaths = {
    "/data/quickapp/files/com.yzf.daymatter/date.txt",
    "/data/files/com.yzf.daymatter/date.txt",
}
local function readEvent()
    local file
    for _, path in ipairs(eventPaths) do
        file = io.open(path, "r")
        if file then break end
    end
    if not file then
        lastFileText, parsedEvent = nil, nil; return nil
    end
    local ok, text = pcall(function() return file:read(1024) end)
    file:close()
    if not ok then return nil end
    if text ~= lastFileText then
        lastFileText = text; parsedEvent = LOGIC.parse(text)
    end
    return parsedEvent
end
local fontProbe = io.open("/font/MiSans-Demibold.ttf", "r")
local watchFont = fontProbe ~= nil
if fontProbe then fontProbe:close() end
local mediumFont = false
for _, path in ipairs({ "/font/MiSans-Medium.ttf", "/system/font/MiSans-Medium.ttf", "/resource/font/MiSans-Medium.ttf" }) do
    local file = io.open(path, "r")
    if file then
        file:close()
        mediumFont = true
        break
    end
end
local fonts = {}
local function font(size)
    if fonts[size] then return fonts[size] end
    local names = { watchFont and "MiSans-Demibold" or "misansw_demibold" }
    -- Try Demibold directly on Band 9 Pro, without relying on file visibility.
    if DEVICE.width == 336 then names = { "MiSans-Demibold", "MiSans-Regular", "misansw_demibold" } end
    if DEVICE.fontName then names = { DEVICE.fontName, "MiSans-Regular", "misansw_demibold" } end
    if mediumFont then table.insert(names, 1, "MiSans-Medium") end
    for _, name in ipairs(names) do
        local ok, value = pcall(lvgl.Font, name, size)
        if ok and value then
            fonts[size] = value; return value
        end
    end
    return lvgl.BUILTIN_FONT.MONTSERRAT_20
end
local root = lvgl.Object(nil, {
    w = lvgl.HOR_RES(),
    h = lvgl.VER_RES(),
    bg_color = 0,
    bg_opa = lvgl.OPA(100),
    border_width = 0,
    pad_all = 0,
})
root:clear_flag(lvgl.FLAG.SCROLLABLE)
-- Firmware long-press must receive events even when touching blank areas.
root:add_flag(lvgl.FLAG.CLICKABLE)
root:add_flag(lvgl.FLAG.EVENT_BUBBLE)
local face = lvgl.Object(root, {
    w = DEVICE.width,
    h = DEVICE.height,
    align = lvgl.ALIGN.CENTER,
    bg_opa = 0,
    border_width = 0,
    pad_all = 0,
})
face:clear_flag(lvgl.FLAG.SCROLLABLE)
face:add_flag(lvgl.FLAG.EVENT_BUBBLE)
local function image(parent, name, x, y)
    local widget = parent:Image { src = imagePath(name), x = x, y = y }
    widget:clear_flag(lvgl.FLAG.SCROLLABLE)
    widget:add_flag(lvgl.FLAG.EVENT_BUBBLE)
    return widget
end
-- Preserve the original centered label containers, including Band 9's height.
local function label(width, y, size)
    local container = lvgl.Object(face, {
        w = width,
        h = DEVICE.labelHeight,
        align = lvgl.ALIGN.CENTER,
        bg_opa = 0,
        border_width = 0,
        pad_all = 0,
    })
    container:clear_flag(lvgl.FLAG.SCROLLABLE)
    container:add_flag(lvgl.FLAG.EVENT_BUBBLE)
    local widget = container:Label {
        w = width, x = 0, y = y, text = "", text_color = "#ffffff",
        font_size = size or 20, text_font = font(size or 20), text_align = lvgl.ALIGN.TOP_MID,
        long_mode = lvgl.LABEL.LONG_SCROLL_CIRCULAR,
    }
    widget:clear_flag(lvgl.FLAG.SCROLLABLE)
    widget:add_flag(lvgl.FLAG.EVENT_BUBBLE)
    return widget
end
local defaultBackground = DEVICE.backgroundImage and imagePath(DEVICE.backgroundImage)
local background = face:Image { x = 0, y = 0 }
background:clear_flag(lvgl.FLAG.SCROLLABLE)
background:add_flag(lvgl.FLAG.EVENT_BUBBLE)
local loadedBackground
local lastBackgroundDiagnostic
local backgroundDebugLabel
local function backgroundDiagnostic(message)
    if not DEBUG_ENABLE then return end
    if message ~= lastBackgroundDiagnostic then
        print("[daymatter:background] " .. message)
        lastBackgroundDiagnostic = message
        if backgroundDebugLabel then
            local display = message:gsub("/data/quickapp/files/com%.yzf%.daymatter/", "")
                :gsub("/data/files/com%.yzf%.daymatter/", "")
            backgroundDebugLabel:set { text = display }
            backgroundDebugLabel:clear_flag(lvgl.FLAG.HIDDEN)
        end
    end
end
local backgroundDirs = { "/data/quickapp/files/com.yzf.daymatter/", "/data/files/com.yzf.daymatter/" }
local function backgroundReference()
    for _, directory in ipairs(backgroundDirs) do
        local file = io.open(directory .. "background.txt", "r")
        if file then
            local ok, text = pcall(function() return file:read(256) end)
            file:close()
            if not ok or not text then return nil end
            local name = text:match("^%s*(.-)%s*$")
            -- Only filenames exported by backgroundStore; never scan old images.
            if not (name:match("^bg_%d+%.png$") or name:match("^bg_%d+%.jpg$")) then return nil end
            return directory .. name
        end
    end
end
local function refreshBackground()
    local resetSource = false
    local path = backgroundReference()
    if path then
        local file = io.open(path, "rb")
        if file then
            file:close()
        else
            backgroundDiagnostic("file open failed: " .. path)
            path = nil
        end
    end
    if path and path ~= loadedBackground then
        -- Query the assigned image: some bindings do not support the optional src argument.
        local ok, error = pcall(function() background:set { src = path } end)
        if ok then
            local sized, width, height = pcall(function() return background:get_img_size() end)
            if sized and type(width) == "number" and type(height) == "number"
                and width >= DEVICE.width and height >= DEVICE.height
                and width <= math.max(512, DEVICE.width + 4) and height <= math.max(512, DEVICE.height + 4) then
                -- Device-reported upload sizes can exceed the layout slightly (470 vs 466).
                -- Keep native pixels and center; the face container clips the excess.
                background:set { x = math.floor((DEVICE.width - width) / 2), y = math.floor((DEVICE.height - height) / 2) }
                background:clear_flag(lvgl.FLAG.HIDDEN)
                loadedBackground = path
                backgroundDiagnostic("loaded: " .. path .. " " .. width .. "x" .. height)
                if backgroundDebugLabel then backgroundDebugLabel:add_flag(lvgl.FLAG.HIDDEN) end
                return
            end
            backgroundDiagnostic("image size/decode failed: " ..
                path .. " got=" .. tostring(width) .. "x" .. tostring(height)
                .. " expected=" .. DEVICE.width .. "x" .. DEVICE.height .. " queryOk=" .. tostring(sized))
        else
            backgroundDiagnostic("set source failed: " .. path .. " " .. tostring(error))
        end
        -- Source may already have changed, so force restoring the default below.
        loadedBackground = nil
        resetSource = true
        path = nil -- Retry failed decoding on the next poll, not permanently cached.
    end
    if path and path == loadedBackground then return end
    if resetSource or loadedBackground ~= defaultBackground then
        if defaultBackground then
            background:set { src = defaultBackground, x = 0, y = 0 }
            background:clear_flag(lvgl.FLAG.HIDDEN)
        else
            background:add_flag(lvgl.FLAG.HIDDEN)
        end
        loadedBackground = defaultBackground
    end
end
local beforeImage = DEVICE.beforeImage or "before.png"
local laterImage = DEVICE.laterImage or "later.png"
local frame = image(face, beforeImage, DEVICE.frameX, DEVICE.frameY)
image(face, laterImage, DEVICE.frameX, DEVICE.frameY + 188)
local group = lvgl.Object(face, {
    w = DEVICE.width,
    h = 140,
    x = DEVICE.daysX,
    y = DEVICE.daysY,
    bg_opa = 0,
    border_width = 0,
    pad_all = 0,
})
group:clear_flag(lvgl.FLAG.SCROLLABLE)
group:add_flag(lvgl.FLAG.EVENT_BUBBLE)
local digits = {}
for i = 1, 4 do digits[i] = image(group, "0.png", 0, 0) end
local today = image(group, "today.png", DEVICE.todayX, DEVICE.todayY)
local hourDigits = {}
for i, x in ipairs(DEVICE.timeX) do hourDigits[i] = image(face, i == 3 and "mao.png" or "0.png", x, DEVICE.timeY) end
local title = label(DEVICE.labelWidth, DEVICE.nameY)
local target = label(DEVICE.labelWidth, DEVICE.targetY)
local dateLabel = label(155, DEVICE.dateY)
local battery = label(84, DEVICE.batteryY, DEVICE.width == 466 and 24 or 20)
-- Temporary on-screen diagnostics, above all watchface content and away from rounded edges.
if DEBUG_ENABLE then
backgroundDebugLabel = face:Label {
    w = math.min(DEVICE.width - 32, 300), h = 180,
    align = lvgl.ALIGN.CENTER, text = "", text_font = font(16), font_size = 16,
    text_color = "#ffffff", text_align = lvgl.ALIGN.CENTER,
    long_mode = lvgl.LABEL.LONG_WRAP, bg_color = 0,
    bg_opa = lvgl.OPA(90), pad_all = 8,
}
backgroundDebugLabel:clear_flag(lvgl.FLAG.SCROLLABLE)
backgroundDebugLabel:add_flag(lvgl.FLAG.EVENT_BUBBLE)
backgroundDebugLabel:add_flag(lvgl.FLAG.HIDDEN)
end
local cache = {}
local function setText(object, text)
    if cache[object] ~= text then
        object:set { text = text }; cache[object] = text
    end
end
local function show(object, visible)
    if visible then object:clear_flag(lvgl.FLAG.HIDDEN) else object:add_flag(lvgl.FLAG.HIDDEN) end
end
local lastDisplay
local function refresh()
    refreshBackground()
    local now = os.date("*t")
    local weekdays = { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }
    setText(dateLabel, string.format("%02d/%02d %s", now.month, now.day, weekdays[now.wday]))
    local event = readEvent() or LOGIC.fallback(now)
    local days = LOGIC.days(event, now)
    local key = event.name .. "|" .. event.date .. "|" .. days
    if key == lastDisplay then return end
    lastDisplay = key
    setText(title, event.name .. (days > 0 and "还有" or days == 0 and "就在" or "已过"))
    setText(target, "目标日: " .. event.date)
    frame:set { src = imagePath(days > 0 and beforeImage or laterImage) }
    for _, digit in ipairs(digits) do show(digit, false) end
    show(today, days == 0)
    if days == 0 then return end
    -- Four image slots: show 9999 plus an explicit overflow marker in the target label.
    local count = math.abs(days)
    if count > 9999 then setText(target, "目标日: " .. event.date .. " · 超过9999天") end
    local text = tostring(math.min(count, 9999))
    local start = DEVICE.digitStart + (4 - #text) * DEVICE.digitStep / 2
    for i = 1, #text do
        digits[i]:set { src = imagePath(text:sub(i, i) .. ".png"), x = start + (i - 1) * DEVICE.digitStep }
        show(digits[i], true)
    end
end
local tokens = {}
local function subscribe(key, object, maximum, callback)
    tokens[#tokens + 1] = dataman.subscribe(key, object, function(obj, encoded)
        local value = LOGIC.decode(encoded, maximum)
        if value ~= nil then callback(obj, value) end
    end)
end
subscribe("systemStatusBattery", battery, 100, function(obj, value) setText(obj, value .. "%") end)
local keys = { "timeHourHigh", "timeHourLow", false, "timeMinuteHigh", "timeMinuteLow" }
for i, key in ipairs(keys) do
    if key then
        subscribe(key, hourDigits[i], 9, function(obj, value)
            if cache[obj] ~= value then
                obj:set { src = imagePath(value .. ".png") }; cache[obj] = value
            end
        end)
    end
end
local active = true
local lastCheck = 0
-- Retain the already-used seconds subscription; throttle file reads without new timer APIs.
subscribe("timeSecondLow", group, 9, function()
    if not active then return end
    local now = os.time()
    if now < lastCheck or now - lastCheck >= 5 then
        lastCheck = now; refresh()
    end
end)
refresh()
function ScreenStateChangedCB(previous, current, reason)
    active = current == "ON"
    if active then
        lastCheck = os.time(); refresh()
    end
end
