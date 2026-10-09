const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const root = path.join(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const pkg = JSON.parse(read("package.json"))
const manifest = JSON.parse(read("src/manifest.json"))
assert.equal(pkg.version, manifest.versionName)
assert.ok(!pkg.scripts.release.includes("--optimize-css-attr"))
assert.ok(!read("src/common/app.css").includes("justify-items"))
const languages = fs.readdirSync(path.join(root, "src/i18n")).filter((f) => f.endsWith(".json"))
const reference = Object.keys(JSON.parse(read("src/i18n/defaults.json"))).sort()
for (const language of languages) {
  assert.deepEqual(
    Object.keys(JSON.parse(read("src/i18n/" + language))).sort(),
    reference,
    language
  )
}
for (const [route, entry] of Object.entries(manifest.router.pages)) {
  assert.ok(fs.existsSync(path.join(root, "src", route, entry.component + ".ux")), route)
}
console.log("版本、路由、四语言键名及CSS兼容配置检查通过")
