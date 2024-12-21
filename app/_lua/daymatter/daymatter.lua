local lvgl = require("lvgl")
local dataman = require("dataman")

local fsRoot = SCRIPT_PATH
local DEBUG_ENABLE = false

local STATE_POSITION_UP = 1
local STATE_POSITION_MID = 2
local STATE_POSITION_BOTTOM = 3

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

local TEXT_FONT = lvgl.BUILTIN_FONT.MONTSERRAT_14

function FontChange(font1, font2)
    if DEBUG_ENABLE == false then
        if isS3 then
            TEXT_FONT = lvgl.Font('MiSans-' .. font2 .. '', 24)
        else
            TEXT_FONT = lvgl.Font('misansw_' .. font1 .. '', 24)
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
        h = 490,
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
        font_size = 24,
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
        w = 192,
        h = 490,
    })
    wfRoot:clear_flag(lvgl.FLAG.SCROLLABLE)
    wfRoot:add_flag(lvgl.FLAG.EVENT_BUBBLE)

    -- 背景
    t.objImage = lvgl.Image(wfRoot, { x = 0, y = 0, src = imgPath("bg.bin") })

    -- 充电图标
    t.chargeImg = Image(wfRoot, imgPath("ap.bin"), { 61, 460 })

    -- 电池电量
    t.chargeCont = imageGroup(wfRoot, { 0, 457 })
    t.chargeContChild1 = t.chargeCont:setChild(imgPath("s8.bin"), { x = 80 });
    t.chargeContChild2 = t.chargeCont:setChild(imgPath("s0.bin"), { x = 91 });
    t.chargeContChild3 = t.chargeCont:setChild(imgPath("s%.bin"), { x = 102 });
    t.chargeContChild4 = t.chargeCont:setChild(imgPath("s0.bin"), { x = 114 });

    -- 倒计时天数
    t.timeDay = imageGroup(wfRoot, { 0, 103 })
    t.timeDayChild1 = t.timeDay:setChild(imgPath("0.bin"), { x = 28 })
    t.timeDayChild2 = t.timeDay:setChild(imgPath("9.bin"), { x = 60 })
    t.timeDayChild3 = t.timeDay:setChild(imgPath("2.bin"), { x = 93 })
    t.timeDayChild4 = t.timeDay:setChild(imgPath("8.bin"), { x = 125 })

    -- 小时分钟
    t.timeHourHigh = Image(wfRoot, imgPath("0.bin"), { 21, 303 })
    t.timeHourLow = Image(wfRoot, imgPath("9.bin"), { 54, 303 })
    t.timeGang = Image(wfRoot, imgPath("say.bin"), { 77, 303 })
    t.timeMinuteHigh = Image(wfRoot, imgPath("2.bin"), { 100, 303 })
    t.timeMinuteLow = Image(wfRoot, imgPath("8.bin"), { 133, 303 })

    -- 星期
    t.dateWeek = Image(wfRoot, imgPath("mon.bin"), { 119, 384 })


    -- 文字
    t.gaokao = Label(wfRoot, "", { w = 144, h = 56, x = 24, y = 54 }, "#ffffff")
    t.tian = Image(wfRoot, imgPath("text2.bin"), { 84, 178 })
    t.xianzaishi = Image(wfRoot, imgPath("text3.bin"), { 66, 256 })

    -- 日期
    t.dateCont = imageGroup(wfRoot, { 0, 382 })
    t.dateContChild1 = t.dateCont:setChild(imgPath("s0.bin"), { x = 28 });
    t.dateContChild2 = t.dateCont:setChild(imgPath("s8.bin"), { x = 40 });
    t.dateContChild3 = t.dateCont:setChild(imgPath("gang.bin"), { x = 50 });
    t.dateContChild4 = t.dateCont:setChild(imgPath("s1.bin"), { x = 60 });
    t.dateContChild5 = t.dateCont:setChild(imgPath("s6.bin"), { x = 71 });

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
        watchface.chargeContChild1:add_flag(lvgl.FLAG.HIDDEN)
        watchface.chargeContChild2:add_flag(lvgl.FLAG.HIDDEN)
        watchface.chargeContChild3:add_flag(lvgl.FLAG.HIDDEN)
        watchface.chargeContChild4:add_flag(lvgl.FLAG.HIDDEN)

        local s = 1
        if index < 10 then
            watchface.chargeImg.widget:set({ x = 71 })
            src = string.format("s%d.bin", index)
            watchface.chargeContChild1:set({ src = imgPath(src), x = 90 })
            watchface.chargeContChild1:clear_flag(lvgl.FLAG.HIDDEN)
            watchface.chargeContChild2:set({ src = imgPath("s%.bin"), x = 102 })
            watchface.chargeContChild2:clear_flag(lvgl.FLAG.HIDDEN)
        elseif index < 100 then
            watchface.chargeImg.widget:set({ x = 66 })
            src = string.format("s%d.bin", index // 10)
            watchface.chargeContChild1:set({ src = imgPath(src), x = 85 })
            watchface.chargeContChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", index % 10)
            watchface.chargeContChild2:set({ src = imgPath(src), x = 96 })
            watchface.chargeContChild2:clear_flag(lvgl.FLAG.HIDDEN)
            watchface.chargeContChild3:set({ src = imgPath("s%.bin"), x = 108 })
            watchface.chargeContChild3:clear_flag(lvgl.FLAG.HIDDEN)
            s = 2
        else
            watchface.chargeImg.widget:set({ x = 61 })
            src = string.format("s%d.bin", 1)
            watchface.chargeContChild1:set({ src = imgPath(src), x = 80 })
            watchface.chargeContChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", 0)
            watchface.chargeContChild2:set({ src = imgPath(src), x = 91 })
            watchface.chargeContChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", 0)
            watchface.chargeContChild3:set({ src = imgPath(src), x = 102 })
            watchface.chargeContChild3:clear_flag(lvgl.FLAG.HIDDEN)
            watchface.chargeContChild4:set({ src = imgPath("s%.bin"), x = 114 })
            watchface.chargeContChild4:clear_flag(lvgl.FLAG.HIDDEN)
            s = 3
        end
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

    local targetSeconds

    -- 倒计时天数
    dataman.subscribe("timeSecondLow", watchface.timeDay.widget, function(obj, value)
        -- 倒计时日期设置
        now = os.time()
        if fileExists(file) then
            local jsonStr = readFileToStr(file)
            local time = splitString(splitString(jsonStr, ",")[2], "-")
            targetSeconds = os.time({ year = time[1], month = time[2], day = time[3], hour = 0, min = 0, sec = 0 })
            if targetSeconds - now > 0 then
                watchface.gaokao.label:set({ text = "" .. splitString(jsonStr, ",")[1] .. "还有" })
            else
                watchface.gaokao.label:set({ text = "" .. splitString(jsonStr, ",")[1] .. "已过" })
            end
        else
            targetSeconds = os.time({ year = 2025, month = 6, day = 7, hour = 0, min = 0, sec = 0 })
            if targetSeconds - now > 0 then
                watchface.gaokao.label:set({ text = "高考还有" })
            else
                watchface.gaokao.label:set({ text = "高考已过" })
            end
        end
        remainingSeconds = math.abs(targetSeconds - now)
        days = math.ceil(remainingSeconds / (24 * 60 * 60)) -- 计算剩余天数
        watchface.timeDayChild1:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild2:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild3:add_flag(lvgl.FLAG.HIDDEN)
        watchface.timeDayChild4:add_flag(lvgl.FLAG.HIDDEN)
        if days < 10 then
            src = string.format("%d.bin", days)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 77 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
        elseif days < 100 then
            src = string.format("%d.bin", math.floor(days / 10))
            watchface.timeDayChild2:set({ src = imgPath(src), x = 60 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 93 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
        elseif days < 1000 then
            src = string.format("%d.bin", math.floor(days / 100))
            watchface.timeDayChild2:set({ src = imgPath(src), x = 44 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 10) % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 76 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild4:set({ src = imgPath(src), x = 109 })
            watchface.timeDayChild4:clear_flag(lvgl.FLAG.HIDDEN)
        else
            src = string.format("%d.bin", math.floor(days / 1000))
            watchface.timeDayChild1:set({ src = imgPath(src), x = 28 })
            watchface.timeDayChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 100) % 10)
            watchface.timeDayChild2:set({ src = imgPath(src), x = 60 })
            watchface.timeDayChild2:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", math.floor(days / 10) % 10)
            watchface.timeDayChild3:set({ src = imgPath(src), x = 93 })
            watchface.timeDayChild3:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("%d.bin", days % 10)
            watchface.timeDayChild4:set({ src = imgPath(src), x = 125 })
            watchface.timeDayChild4:clear_flag(lvgl.FLAG.HIDDEN)
        end
    end)

    -- 星期
    dataman.subscribe("dateWeek", watchface.dateWeek.widget, function(obj, value)
        index = value // 256
        index = index + 1
        src = { "sun", "mon", "tue", "wed", "thu", "fri", "sat" }
        str = string.format("%s.bin", src[index])
        obj:set { src = imgPath(str) }
    end)

    -- 月份
    dataman.subscribe("dateMonth", watchface.dateCont.widget, function(obj, value)
        index = value // 256
        watchface.dateContChild1:add_flag(lvgl.FLAG.HIDDEN)
        watchface.dateContChild2:add_flag(lvgl.FLAG.HIDDEN)
        if index < 10 then
            watchface.dateContChild1:set({ src = imgPath("s0.bin") });
            watchface.dateContChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", index)
            watchface.dateContChild2:set({ src = imgPath(src) });
            watchface.dateContChild2:clear_flag(lvgl.FLAG.HIDDEN)
        else
            src = string.format("s%d.bin", index // 10)
            watchface.dateContChild1:set({ src = imgPath(src) });
            watchface.dateContChild1:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", index % 10)
            watchface.dateContChild2:set({ src = imgPath(src) });
            watchface.dateContChild2:clear_flag(lvgl.FLAG.HIDDEN)
        end
    end)

    -- 星期
    dataman.subscribe("dateDay", watchface.dateCont.widget, function(obj, value)
        index = value // 256
        watchface.dateContChild4:add_flag(lvgl.FLAG.HIDDEN)
        watchface.dateContChild5:add_flag(lvgl.FLAG.HIDDEN)
        if index < 10 then
            watchface.dateContChild4:set({ src = imgPath("s0.bin") });
            watchface.dateContChild4:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", index)
            watchface.dateContChild5:set({ src = imgPath(src) });
            watchface.dateContChild5:clear_flag(lvgl.FLAG.HIDDEN)
        else
            src = string.format("s%d.bin", index // 10)
            watchface.dateContChild4:set({ src = imgPath(src) });
            watchface.dateContChild4:clear_flag(lvgl.FLAG.HIDDEN)
            src = string.format("s%d.bin", index % 10)
            watchface.dateContChild5:set({ src = imgPath(src) });
            watchface.dateContChild5:clear_flag(lvgl.FLAG.HIDDEN)
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
