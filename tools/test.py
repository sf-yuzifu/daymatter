"""Run calendar and generated-entry regression tests with lupa (Lua 5.4)."""
from pathlib import Path
from datetime import date
from lupa.lua54 import LuaRuntime
from config import load_devices

ROOT = Path(__file__).resolve().parents[1]
runtime = LuaRuntime(unpack_returned_tuples=True)
logic = runtime.execute((ROOT / "src/logic.lua").read_text(encoding="utf-8"))
for year in [1, 1900, 2000, 2024, 2026, 2100, 9999]:
    for month in range(1, 13):
        assert logic.ordinal(year, month, 1) == date(year, month, 1).toordinal()
for text in ["", "name,2026-02-30,false", "name,1900-02-29,true", "name,0000-01-01,false", "name,2026-01-01,xxxx", "name,,false"]:
    assert logic.parse(text) is None, text
assert logic.parse("生日,2000-02-29,true\r\n").include
for month, day, expected in [(6, 6, 2026), (6, 7, 2026), (6, 8, 2027), (12, 31, 2027)]:
    now = runtime.table_from(dict(year=2026, month=month, day=day))
    assert logic.fallback(now).year == expected
now = runtime.table_from(dict(year=2026, month=6, day=7))
for target, include, expected in [("2026-06-07", "false", 0), ("2026-06-07", "true", -1), ("2026-06-06", "true", -2), ("2026-06-08", "true", 1)]:
    assert logic.days(logic.parse(f"测试,{target},{include}"), now) == expected
assert logic.decode(2147483647, 9) is None
assert logic.decode(2560, 9) is None
assert logic.decode(2304, 9) == 9

STUB = r'''
SCRIPT_PATH = "assets/"
subscriptions, objects, reads = {}, {}, 0
logCount = 0
fontCalls, availableFont = {}, "MiSans-Medium"
print = function() logCount = logCount + 1 end
eventText = "测试,2026-06-07,false"
alternateText = nil
backgroundText, alternateBackgroundText = nil, nil
imagePresent, imageDecodes = true, true
imageExtra = 0
timestamp = 100
local function object(properties)
    local o = {properties = properties or {}, hidden = false, updates = 0, flags = {[1] = true}}
    objects[#objects + 1] = o
    function o:set(values)
        self.updates = self.updates + 1
        for k, v in pairs(values) do self.properties[k] = v end
        if values.src then assert(not values.src:match("/10%.png$")) end
    end
    function o:clear_flag(flag) assert(flag); self.flags[flag] = nil; if flag == 2 then self.hidden = false end end
    function o:add_flag(flag) assert(flag); self.flags[flag] = true; if flag == 2 then self.hidden = true end end
    function o:Image(properties) return object(properties) end
    function o:Label(properties) return object(properties) end
    function o:get_img_size(path)
        if not imageDecodes then return 0, 0 end
        return expectedWidth + imageExtra, expectedHeight + imageExtra
    end
    return o
end
package.preload.lvgl = function() return {
    Object = function(parent, properties) return object(properties) end,
    HOR_RES = function() return 466 end, VER_RES = function() return 466 end,
    OPA = function(v) return v end, Font = function(name, size)
        fontCalls[#fontCalls + 1] = {name = name, size = size}
        if name == availableFont then return name end
        if name == "MiSans-Medium" then error("unavailable font") end
        return nil
    end,
    BUILTIN_FONT = {MONTSERRAT_20 = 1}, ALIGN = {CENTER = 1, TOP_MID = 2},
    FLAG = {SCROLLABLE = 1, HIDDEN = 2, EVENT_BUBBLE = 3, CLICKABLE = 4}, LABEL = {LONG_SCROLL_CIRCULAR = 1, LONG_WRAP = 2}
} end
package.preload.dataman = function() return {
    subscribe = function(key, obj, cb) subscriptions[key] = function(value) cb(obj, value) end; return key end
} end
io.open = function(path)
    if path == "/data/quickapp/files/com.yzf.daymatter/date.txt" then reads = reads + 1 end
    local text
    if path == "/data/quickapp/files/com.yzf.daymatter/date.txt" then text = eventText
    elseif path == "/data/files/com.yzf.daymatter/date.txt" then text = alternateText
    elseif path == "/data/quickapp/files/com.yzf.daymatter/background.txt" then text = backgroundText
    elseif path == "/data/files/com.yzf.daymatter/background.txt" then text = alternateBackgroundText
    elseif path:match("/bg_%d+%.png$") and imagePresent then text = "image" end
    if text == nil then return nil end
    return {read = function() return text end, close = function() end}
end
os.date = function() return {year=2026, month=6, day=7, wday=1} end
os.time = function() return timestamp end
function hasText(text)
    for _, o in ipairs(objects) do if o.properties.text == text then return true end end
    return false
end
function hasSource(path)
    for _, o in ipairs(objects) do if not o.hidden and o.properties.src == path then return true end end
    return false
end
'''
configs = load_devices()
assert configs["band10pro"]["timeX"] == configs["band9pro"]["timeX"]
assert configs["s5_41"]["assets"] == "s4" and configs["s5_41"]["previewSize"] == [480, 480]
assert configs["band11"]["packageAlias"] == "band10"
for device, config in configs.items():
    if config.get("packageAlias"):
        continue
    vm = LuaRuntime(unpack_returned_tuples=True)
    vm.execute(STUB)
    vm.globals().expectedWidth, vm.globals().expectedHeight = config["width"], config["height"]
    vm.execute((ROOT / "build" / device / "app/_lua/daymatter/daymatter.lua").read_text(encoding="utf-8"))
    vm.execute(r'''
        assert(hasText("测试就在"))
        for _, obj in ipairs(objects) do assert(not obj.flags[1] and obj.flags[3]) end
        assert(objects[1].flags[4])
        backgroundText = "bg_123.png"; ScreenStateChangedCB("OFF", "ON")
        assert(hasSource("/data/quickapp/files/com.yzf.daymatter/bg_123.png"))
        imageExtra = 4; backgroundText = "bg_124.png"; ScreenStateChangedCB("OFF", "ON")
        assert(hasSource("/data/quickapp/files/com.yzf.daymatter/bg_124.png"))
        for _, obj in ipairs(objects) do
            if obj.properties.src == "/data/quickapp/files/com.yzf.daymatter/bg_124.png" then
                assert(obj.properties.x == -2 and obj.properties.y == -2)
            end
        end
        imageExtra = 0
        backgroundText = ""; ScreenStateChangedCB("OFF", "ON")
        assert(not hasSource("/data/quickapp/files/com.yzf.daymatter/bg_123.png"))
        backgroundText = nil; alternateBackgroundText = "bg_456.png"
        ScreenStateChangedCB("OFF", "ON"); assert(hasSource("/data/files/com.yzf.daymatter/bg_456.png"))
        imagePresent = false; ScreenStateChangedCB("OFF", "ON")
        assert(not hasSource("/data/files/com.yzf.daymatter/bg_456.png"))
        imagePresent = true; imageDecodes = false; ScreenStateChangedCB("OFF", "ON")
        assert(not hasSource("/data/files/com.yzf.daymatter/bg_456.png"))
        imageDecodes = true; ScreenStateChangedCB("OFF", "ON")
        assert(hasSource("/data/files/com.yzf.daymatter/bg_456.png"))
        backgroundText = "../bg_456.png"; ScreenStateChangedCB("OFF", "ON")
        assert(not hasSource("/data/files/com.yzf.daymatter/bg_456.png"))
        backgroundText, alternateBackgroundText = nil, nil
        eventText = nil; alternateText = "新路径,2026-06-07,false"
        ScreenStateChangedCB("OFF", "ON"); assert(hasText("新路径就在"))
        eventText = ""; ScreenStateChangedCB("OFF", "ON"); assert(hasText("高考就在"))
        alternateText = nil
        subscriptions.timeSecondLow(2147483647)
        eventText = ""; ScreenStateChangedCB("OFF", "ON"); assert(hasText("高考就在"))
        eventText = "bad"; ScreenStateChangedCB("OFF", "ON"); assert(hasText("高考就在"))
        eventText = "测试,0001-01-01,true"; ScreenStateChangedCB("OFF", "ON")
        assert(hasText("测试已过"))
        eventText = "测试,2026-06-07,true"; ScreenStateChangedCB("OFF", "ON")
        assert(hasText("测试已过"))
        ScreenStateChangedCB("ON", "OFF")
        local before = reads; timestamp = timestamp + 20; subscriptions.timeSecondLow(256)
        assert(reads == before)
        ScreenStateChangedCB("OFF", "ON"); before = reads
        timestamp = timestamp + 1; subscriptions.timeSecondLow(512); assert(reads == before)
        timestamp = timestamp + 5; subscriptions.timeSecondLow(768); assert(reads == before + 1)
    ''')
    assert vm.globals().logCount == 0, "Release entry must not print diagnostics"
    vm.execute("for _, obj in ipairs(objects) do assert(obj.properties.long_mode ~= 2) end")
    # Exercise the actual generated debug entry, including failure and recovery visibility.
    debug_vm = LuaRuntime(unpack_returned_tuples=True)
    debug_vm.execute(STUB)
    debug_vm.globals().expectedWidth, debug_vm.globals().expectedHeight = config["width"], config["height"]
    debug_vm.execute((ROOT / "build" / (device + "-debug") / "app/_lua/daymatter/daymatter.lua").read_text(encoding="utf-8"))
    debug_vm.execute(r'''
        local panel
        for _, obj in ipairs(objects) do if obj.properties.long_mode == 2 then panel = obj end end
        assert(panel and panel.hidden)
        backgroundText = "bg_123.png"; imagePresent = false
        ScreenStateChangedCB("OFF", "ON")
        assert(logCount == 1 and not panel.hidden and panel.properties.text:find("file open failed", 1, true))
        ScreenStateChangedCB("OFF", "ON"); assert(logCount == 1)
        imagePresent = true; ScreenStateChangedCB("OFF", "ON")
        assert(logCount == 2 and panel.hidden)
        assert(hasSource("/data/quickapp/files/com.yzf.daymatter/bg_123.png"))
    ''')
    for available in ["MiSans-Medium", "MiSans-Demibold", "misansw_demibold", "none"]:
        font_vm = LuaRuntime(unpack_returned_tuples=True)
        font_vm.execute(STUB)
        font_vm.globals().availableFont = available
        font_vm.globals().expectedWidth, font_vm.globals().expectedHeight = config["width"], config["height"]
        font_vm.execute((ROOT / "build" / device / "app/_lua/daymatter/daymatter.lua").read_text(encoding="utf-8"))
        font_vm.execute(r'''
            local expected = {"MiSans-Medium", "MiSans-Demibold", "misansw_demibold"}
            local attempts = availableFont == "MiSans-Medium" and 1 or availableFont == "MiSans-Demibold" and 2 or 3
            local bySize = {}
            for _, call in ipairs(fontCalls) do
                local count = (bySize[call.size] or 0) + 1
                bySize[call.size] = count
                assert(call.name == expected[count])
            end
            for _, count in pairs(bySize) do assert(count == attempts) end
            for _, obj in ipairs(objects) do
                if obj.properties.text_font then
                    assert(obj.properties.text_font == (availableFont == "none" and 1 or availableFont))
                end
            end
        ''')
    print(f"{device}: Lua 5.4 entry, fallback, overflow and screen refresh passed")
print("Calendar and interface regressions passed")
