local lvgl = require("lvgl")
local dataman = require("dataman")

local fsRoot = SCRIPT_PATH
local DEBUG_ENABLE = false

local STATE_POSITION_UP = 1
local STATE_POSITION_MID = 2
local STATE_POSITION_BOTTOM = 3

local month = ""
local week = ""
local day = ""

local file = '/data/quickapp/files/com.yzf.daymatter/date.txt'

local function fileExists(name)
    local f = io.open(name, "r")
    if f ~= nil then
        io.close(f)
        return true
    else
        return false
    end
end

local function splitString(inputstr, sep)
    if sep == nil then
        sep = "%s"
    end
    local t = {}
    for str in string.gmatch(inputstr, "([^" .. sep .. "]+)") do
        table.insert(t, str)
    end
    return t
end

local function readFileToStr(file)
    if fileExists(file) == false then
        printf('File Not Found : ' .. file)
        return ''
    end
    local text = ''
    for f in io.lines(file) do
        text = text .. f .. '\n'
    end
    return text
end

local printf = DEBUG_ENABLE and print or function(...)
end

function imgPath(src)
    return fsRoot .. src
end

-- Create an image to support state amim etc.
---@param root Object
---@return Image
local function Image(root, src, pos)
    --- @class Image
    local t = {} -- create new table

    t.widget = root:Image { src = src }
    local w, h = t.widget:get_img_size()
    t.w = w
    t.h = h

    -- current state, center
    t.pos = {
        x = pos[1],
        y = pos[2]
    }

    function t:getImageWidth()
        return t.w
    end

    function t:getImageheight()
        return t.h
    end

    t.defaultY = pos[2]
    t.lastState = STATE_POSITION_MID
    t.state = STATE_POSITION_MID

    t.widget:set {
        w = w,
        h = h,
        x = t.pos.x,
        y = t.pos.y
    }

    -- create animation and put it on hold
    local anim = t.widget:Anim {
        run = false,
        start_value = 0,
        end_value = 1000,
        time = 560, -- 560ms fixed
        repeat_count = 1,
        path = "ease_in_out",
        exec_cb = function(obj, now)
            obj:set { y = now }
            t.pos.y = now
        end
    }

    t.posAnim = anim

    return t
end


local isS3 = fileExists('/font/MiSans-Demibold.ttf')

local TEXT_FONT = lvgl.BUILTIN_FONT.MONTSERRAT_20

function FontChange(font1, font2)
    if DEBUG_ENABLE == false then
        if isS3 then
            TEXT_FONT = lvgl.Font('MiSans-' .. font2 .. '', 20)
        else
            TEXT_FONT = lvgl.Font('misansw_' .. font1 .. '', 20)
        end
    end
end

FontChange("demibold", "Demibold")

local function Label(root, text, pos, color)
    --- @class Label
    local t = {} -- create new table

    t.widget = lvgl.Object(root, {
        outline_width = 0,
        border_width = 0,
        pad_all = 0,
        bg_opa = 0,
        bg_color = 0,
        w = pos.w,
        h = 520,
        align = lvgl.ALIGN.CENTER
    })
    t.widget:clear_flag(lvgl.FLAG.SCROLLABLE)
    t.widget:add_flag(lvgl.FLAG.EVENT_BUBBLE)

    t.label = t.widget:Label {
        w = pos.w,
        -- h = 50,
        x = 0,
        y = pos.y,
        text = text,
        text_color = color,
        font_size = 20,
        text_font = TEXT_FONT,
        text_align = lvgl.ALIGN.TOP_MID,
        long_mode = lvgl.LABEL.LONG_SCROLL_CIRCULAR
    }

    t.lastState = STATE_POSITION_MID
    t.state = STATE_POSITION_MID

    return t
end


---@param root Object
local function imageGroup(root, pos)
    --- @class Image
    local t = {} -- create new table

    t.widget = lvgl.Object(root, {
        outline_width = 0,
        border_width = 0,
        pad_all = 0,
        bg_opa = 0,
        bg_color = 0,
        w = lvgl.SIZE_CONTENT,
        h = lvgl.SIZE_CONTENT,
        x = pos.x,
        y = pos.y,
    })

    function t:setChild(src, pos)
        local img = t.widget:Image { src = src, x = pos.x, y = pos.y }
        return img
    end

    -- current state, center
    t.pos = {
        x = pos[1],
        y = pos[2]
    }

    t.defaultY = pos[2]
    t.lastState = STATE_POSITION_MID
    t.state = STATE_POSITION_MID

    t.widget:set {
        x = t.pos.x,
        y = t.pos.y
    }

    function t:getChildCnt()
        return t.widget:get_child_cnt()
    end

    function t:getChild(i)
        return t.widget:get_child(i)
    end

    function t:getParent()
        return t.widget:get_parent()
    end

    -- create animation and put it on hold
    local anim = t.widget:Anim {
        run = false,
        start_value = 0,
        end_value = 1000,
        time = 560, -- 560ms fixed
        repeat_count = 1,
        path = "ease_in_out",
        exec_cb = function(obj, now)
            obj:set { y = now }
            t.pos.y = now
        end
    }

    t.posAnim = anim

    return t
end


---@param parent Object
local function createWatchface(parent)
    local t = {}

    local wfRoot = lvgl.Object(parent, {
        outline_width = 0,
        border_width = 0,
        pad_all = 0,
        bg_opa = 0,
        bg_color = 0,
        align = lvgl.ALIGN.CENTER,
        w = 212,
        h = 520,
    })
    wfRoot:clear_flag(lvgl.FLAG.SCROLLABLE)
    wfRoot:add_flag(lvgl.FLAG.EVENT_BUBBLE)

    -- 背景
    t.objImage = lvgl.Image(wfRoot, { x = 0, y = 0, src = imgPath("bg.bin") })

    --倒数日方框
    t.countdown1 = Image(wfRoot, imgPath("before.bin"), { 6, 74 })
    t.countdown2 = Image(wfRoot, imgPath("later.bin"), { 6, 262 })

    -- 电量
    t.chargeCont = Label(wfRoot, "100%", { w = 84, h = 27, x = 64, y = 480 }, "#ffffff")

    -- 倒计时天数
    t.timeDay = imageGroup(wfRoot, { 0, 109 })
    t.timeDayChild1 = t.timeDay:setChild(imgPath("0.bin"), { x = 24 })
    t.timeDayChild2 = t.timeDay:setChild(imgPath("7.bin"), { x = 65 })
    t.timeDayChild3 = t.timeDay:setChild(imgPath("2.bin"), { x = 106 })
    t.timeDayChild4 = t.timeDay:setChild(imgPath("1.bin"), { x = 147 })
    t.timeDayChild5 = t.timeDay:setChild(imgPath("today.bin"), { x = 34, y = 4 })

    -- 小时分钟
    t.timeHourHigh = Image(wfRoot, imgPath("0.bin"), { 15.5, 297 })
    t.timeHourLow = Image(wfRoot, imgPath("9.bin"), { 56.5, 297 })
    t.timeGang = Image(wfRoot, imgPath("mao.bin"), { 85.5, 297 })
    t.timeMinuteHigh = Image(wfRoot, imgPath("2.bin"), { 114.5, 297 })
    t.timeMinuteLow = Image(wfRoot, imgPath("8.bin"), { 155.5, 297 })


    -- 文字
    t.gaokao = Label(wfRoot, "", { w = 200, h = 27, x = 16, y = 76.5 }, "#ffffff")
    t.countdown = Label(wfRoot, "目标日: 2026-6-8", { w = 200, h = 27, x = 6, y = 200.5 }, "#ffffff")

    -- 日期
    t.dateCont = Label(wfRoot, "03/08 周六", { w = 155, h = 27, x = 29, y = 388.5 }, "#ffffff")

    return t
end

local function uiCreate()
    local root = lvgl.Object(nil, {
        w = lvgl.HOR_RES(),
        h = lvgl.VER_RES(),
        bg_color = 0,
        bg_opa = lvgl.OPA(100),
        border_width = 0,
    })
    root:clear_flag(lvgl.FLAG.SCROLLABLE)
    root:add_flag(lvgl.FLAG.EVENT_BUBBLE)

    local watchface = createWatchface(root)

    local function screenONCb()
        -- printf("screen on")
    end

    local function screenOFFCb()
        --printf("screen off")
    end

    screenONCb() -- screen is ON when watchface created

    -- 电池电量
    dataman.subscribe("systemStatusBattery", watchface.chargeCont.widget, function(obj, value)
        local index = value // 256
        watchface.chargeCont.label:set({ text = index .. '%' })
    end)

    -- 小时分钟
    dataman.subscribe("timeHourHigh", watchface.timeHourHigh.widget, function(obj, value)
        src = string.format("%d.bin", value // 256)
        obj:set { src = imgPath(src) }
    end)
    dataman.subscribe("timeHourLow", watchface.timeHourLow.widget, function(obj, value)
        src = string.format("%d.bin", value // 256)
        obj:set { src = imgPath(src) }
    end)
    dataman.subscribe("timeMinuteHigh", watchface.timeMinuteHigh.widget, function(obj, value)
        src = string.format("%d.bin", value // 256)
        obj:set { src = imgPath(src) }
    end)
    dataman.subscribe("timeMinuteLow", watchface.timeMinuteLow.widget, function(obj, value)
        src = string.format("%d.bin", value // 256)
        obj:set { src = imgPath(src) }
    end)

    -- 倒数日计算器
    local function calculateDaysLeft(targetYear, targetMonth, targetDay)
        -- 获取当前日期的0点0分0秒
        local now = os.date("*t") -- 获取当前时间的详细表
        now.hour = 0
        now.min = 0
        now.sec = 0
        local currentTime = os.time(now) -- 转换为时间戳（当天0点）

        -- 设置目标日期的0点0分0秒
        local targetTime = os.time({
            year = targetYear,
            month = targetMonth,
            day = targetDay,
            hour = 0,
            min = 0,
            sec = 0
        })

        -- 计算差值（秒）并转换为天数
        local daysLeft = math.floor((targetTime - currentTime) / 86400) -- 86400 = 24*60*60

        return daysLeft
    end
    local daysLeft

    -- 倒计时天数
    dataman.subscribe("timeSecondLow", watchface.timeDay.widget, function(obj, value)
        watchface.dateCont.label:set({ text = month .. "/" .. day .. " " .. week })
        watchface.countdown1.widget:set({ src = imgPath("later.bin") })
        -- 倒计时日期设置
        if fileExists(file) then
            local jsonStr = readFileToStr(file)
            watchface.countdown.label:set({ text = "目标日: " .. splitString(jsonStr, ",")[2] })
            local time = splitString(splitString(jsonStr, ",")[2], "-")
            daysLeft = calculateDaysLeft(time[1], time[2], time[3])
            if daysLeft > 0 then
                watchface.gaokao.label:set({ text = "" .. splitString(jsonStr, ",")[1] .. "还有" })
                watchface.countdown1.widget:set({ src = imgPath("before.bin") })
            elseif daysLeft == 0 then
                watchface.gaokao.label:set({ text = "" .. splitString(jsonStr, ",")[1] .. "就在" })
            else
                watchface.gaokao.label:set({ text = "" .. splitString(jsonStr, ",")[1] .. "已过" })
            end
        else
            watchface.countdown.label:set({ text = "目标日: 2026-6-7" })
            daysLeft = calculateDaysLeft(2026, 6, 7)
            if daysLeft > 0 then
                watchface.gaokao.label:set({ text = "高考还有" })
                watchface.countdown1.widget:set({ src = imgPath("before.bin") })
            elseif daysLeft == 0 then
                watchface.gaokao.label:set({ text = "高考就在" })
            else
                watchface.gaokao.label:set({ text = "高考已过" })
            end
        end
        days = math.abs(daysLeft)
        watchface.timeDayChild1:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild2:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild3:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild4:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild5:add_flag(lvgl.FLAG.HIDDEN)
        if days == 0 then
            watchface.timeDayChild5:clear_flag(lvgl.FLAG.HIDDEN)
        elseif days < 10 then
            src = string.format("%d.bin", days)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 85.5 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
        elseif days < 100 then
            src = string.format("%d.bin", math.floor(days / 10))
            watchface.timeDayChild2:set({ src = imgPath(src), x = 65 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 106 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
        elseif days < 1000 then
            src = string.format("%d.bin", math.floor(days / 100))
            watchface.timeDayChild2:set({ src = imgPath(src), x = 44.5 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 10) % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 85.5 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild4:set({ src = imgPath(src), x = 126.5 })
            watchface.timeDayChild4:clear_flag(lvgl.FLAG.HIDDEN)
        else
            src = string.format("%d.bin", math.floor(days / 1000))
            watchface.timeDayChild1:set({ src = imgPath(src), x = 24 })
            watchface.timeDayChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 100) % 10)
            watchface.timeDayChild2:set({ src = imgPath(src), x = 65 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 10) % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 106 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild4:set({ src = imgPath(src), x = 147 })
            watchface.timeDayChild4:clear_flag(lvgl.FLAG.HIDDEN)
        end
    end)

    -- 星期
    dataman.subscribe("dateWeek", watchface.dateCont.widget, function(obj, value)
        index = value // 256
        index = index + 1
        src = { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }
        week = src[index]
    end)

    -- 月份
    dataman.subscribe("dateMonth", watchface.dateCont.widget, function(obj, value)
        index = value // 256
        if index < 10 then
            month = "0" .. index
        else
            month = index
        end
    end)

    -- 星期
    dataman.subscribe("dateDay", watchface.dateCont.widget, function(obj, value)
        index = value // 256
        if index < 10 then
            day = "0" .. index
        else
            day = index
        end
    end)

    return screenONCb, screenOFFCb
end

local on, off = uiCreate()

function ScreenStateChangedCB(pre, now, reason)
    --printf("screen state", pre, now, reason)
    if pre ~= "ON" and now == "ON" then
        on()
    elseif pre == "ON" and now ~= "ON" then
        off()
    end
end
