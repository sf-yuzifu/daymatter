// 检查真实发布字节码中的CSS属性名，防止不兼容老固件的缩写重新进入产物。
const assert = require("node:assert/strict")
const path = require("node:path")
const AdmZip = require("adm-zip")
const zip = new AdmZip(process.argv[2] || path.join(__dirname, "../dist/com.yzf.daymatter.release.2.1.rpk"))
for (const page of ["index", "list", "edit", "about", "datepicker", "ime"]) {
  const entry = zip.getEntry(`pages/${page}/${page}.jsc`)
  assert.ok(entry, `缺少${page}字节码`)
  const bytes = entry.getData()
  for (const key of ["fontSize", "width", "height"]) {
    assert.ok(bytes.includes(Buffer.from(key)), `${page}缺少完整CSS属性${key}`)
  }
  assert.ok(!bytes.includes(Buffer.from("justifyItems")), `${page}仍含不支持的justifyItems`)
  console.log(`${page}: 完整CSS属性及justifyItems检查通过`)
}
