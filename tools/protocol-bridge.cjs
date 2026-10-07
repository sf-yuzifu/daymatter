// E-14: 复用实际页面/文件模拟器，stdin 接收 Rust 生成的消息，stdout 返回真实腕端回包。
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const source = fs.readFileSync(path.join(__dirname, "test-ime.cjs"), "utf8")
const harnessSource = source.slice(0, source.indexOf('\ntest("'))
const context = vm.createContext({require, __dirname, console})
vm.runInContext(harnessSource + "\nthis.createHarness = createHarness", context)
const input = JSON.parse(fs.readFileSync(0, "utf8"))
const h = context.createHarness()
h.router.push({uri: "/pages/index"})
if (input.events) h.files.set("internal://files/events.json", JSON.stringify({version: 2,
  revision: 10, primaryId: "", events: input.events}))
h.deferWrites = !!input.deferWrites
const connection = h.connection
if (input.failBatch !== undefined) {
  connection.send = (options) => {
    connection.sent.push(options)
    if (options.data.type === "eventListBatch" && options.data.batchIndex === input.failBatch) {
      if (options.fail) options.fail()
    } else if (options.success) options.success()
  }
}
for (const message of input.messages) connection.onmessage({data: message})
h.flushWrites()
process.stdout.write(JSON.stringify({messages: connection.sent.map((item) => item.data),
  store: JSON.parse(h.files.get("internal://files/events.json"))}))
