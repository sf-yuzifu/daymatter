"""Run calendar and generated-entry regression tests with lupa (Lua 5.4)."""
from pathlib import Path
from datetime import date
from lupa.lua54 import LuaRuntime

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
eventText = "测试,2026-06-07,false"
alternateText = nil
timestamp = 100
local function object(properties)
    local o = {properties = properties or {}, hidden = false, updates = 0}
    objects[#objects + 1] = o
    function o:set(values)
        self.updates = self.updates + 1
        for k, v in pairs(values) do self.properties[k] = v end
        if values.src then assert(not values.src:find("10.png", 1, true)) end
    end
    function o:clear_flag(flag) if flag == 2 then self.hidden = false end end
    function o:add_flag(flag) if flag == 2 then self.hidden = true end end
    function o:Image(properties) return object(properties) end
    function o:Label(properties) return object(properties) end
    return o
end
package.preload.lvgl = function() return {
    Object = function(parent, properties) return object(properties) end,
    HOR_RES = function() return 466 end, VER_RES = function() return 466 end,
    OPA = function(v) return v end, Font = function() return 1 end,
    BUILTIN_FONT = {MONTSERRAT_20 = 1}, ALIGN = {CENTER = 1, TOP_MID = 2},
    FLAG = {SCROLLABLE = 1, HIDDEN = 2}, LABEL = {LONG_SCROLL_CIRCULAR = 1}
} end
package.preload.dataman = function() return {
    subscribe = function(key, obj, cb) subscriptions[key] = function(value) cb(obj, value) end; return key end
} end
io.open = function(path)
    reads = reads + 1
    local text
    if path == "/data/quickapp/files/com.yzf.daymatter/date.txt" then text = eventText
    elseif path == "/data/files/com.yzf.daymatter/date.txt" then text = alternateText end
    if text == nil then return nil end
    return {read = function() return text end, close = function() end}
end
os.date = function() return {year=2026, month=6, day=7, wday=1} end
os.time = function() return timestamp end
function hasText(text)
    for _, o in ipairs(objects) do if o.properties.text == text then return true end end
    return false
end
'''
for device in ["band9", "band10", "band9pro", "s4", "band10pro", "redmiwatch6", "s5_46", "s5_41"]:
    vm = LuaRuntime(unpack_returned_tuples=True)
    vm.execute(STUB)
    vm.execute((ROOT / "build" / device / "app/_lua/daymatter/daymatter.lua").read_text(encoding="utf-8"))
    vm.execute(r'''
        assert(hasText("测试就在"))
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
    print(f"{device}: Lua 5.4 entry, fallback, overflow and screen refresh passed")
print("Calendar and interface regressions passed")
