-- Pure calendar/file logic: no device APIs, shared by all targets.
local M = {}
local lengths = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
function M.valid(y, m, d)
    if not y or not m or not d or y < 1 or y > 9999 or m < 1 or m > 12 then return false end
    local leap = y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0)
    return d >= 1 and d <= (m == 2 and leap and 29 or lengths[m])
end

function M.ordinal(y, m, d)
    local previous = y - 1
    local n = previous * 365 + previous // 4 - previous // 100 + previous // 400 + d
    for month = 1, m - 1 do n = n + lengths[month] end
    if m > 2 and y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0) then n = n + 1 end
    return n
end

function M.parse(text)
    if type(text) ~= "string" then return nil end
    local name, date, flag = text:match("^([^,\r\n]+),(%d%d%d%d%-%d%d?%-%d%d?),%s*(%a+)%s*$")
    if not name or (flag ~= "true" and flag ~= "false") then return nil end
    local y, m, d = date:match("^(%d+)%-(%d+)%-(%d+)$")
    y, m, d = tonumber(y), tonumber(m), tonumber(d)
    if not M.valid(y, m, d) then return nil end
    return {
        name = name,
        year = y,
        month = m,
        day = d,
        include = flag == "true",
        date = string.format("%04d-%02d-%02d", y, m, d)
    }
end

function M.fallback(now)
    local y = now.year
    if now.month > 6 or (now.month == 6 and now.day > 7) then y = y + 1 end
    return {
        name = "高考",
        year = y,
        month = 6,
        day = 7,
        include = false,
        date = string.format("%04d-06-07", y)
    }
end

function M.days(event, now)
    local n = M.ordinal(event.year, event.month, event.day) - M.ordinal(now.year, now.month, now.day)
    if event.include and n <= 0 then n = n - 1 end
    return n
end

function M.decode(value, maximum)
    if type(value) ~= "number" or value == 2147483647 or value < 0 then return nil end
    local n = value // 256
    if n > maximum then return nil end
    return n
end

return M
