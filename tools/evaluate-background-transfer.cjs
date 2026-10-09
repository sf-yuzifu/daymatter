// G-07：测量现有addBG整包开销，数字是编码预算，不代表真实链路峰值。
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const source = fs.readFileSync(path.join(__dirname, "test-ime.cjs"), "utf8")
const context = vm.createContext({require, __dirname, console, Buffer})
vm.runInContext(source.slice(0, source.indexOf('\ntest("')) + "\nthis.createHarness = createHarness", context)
const h = context.createHarness()
const home = h.router.push({uri: "/pages/index"})
for (const size of [1024, 10 * 1024, 50 * 1024, 100 * 1024]) {
  const bytes = Buffer.alloc(size)
  // 有界JPEG SOF头；这里验证传输和实际页面路径，不宣称完整JPEG解码。
  Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]).copy(bytes)
  const base64 = bytes.toString("base64")
  const payload = JSON.stringify({type: "addBG", bgBase64: base64})
  home.handleInterconnectMessage({data: payload})
  assert.match(home.bgImage, /\.jpg$/)
  assert.equal(JSON.parse(h.files.get("internal://files/background.json")).uri, home.bgImage)
  assert.ok(payload.length <= 262144)
  console.log(JSON.stringify({imageBytes:size, base64Chars:base64.length, jsonBytes:Buffer.byteLength(payload),
    utf16JsonBytes:payload.length * 2, decodedBytes:size, budgetAccepted:true}))
}
