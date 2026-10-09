const fs = require("node:fs")
const crypto = require("node:crypto")
const path = require("node:path")
for (const file of ["../dist/com.yzf.daymatter.release.2.1.rpk",
  "../../daymatter_AstroBox-Plugin/dist/daymatter_astrobox_v2_plugin.wasm",
  "../../daymatter_AstroBox-Plugin/dist/倒数日配置工具.abp"]) {
  const resolved = path.resolve(__dirname,file)
  const bytes = fs.readFileSync(resolved)
  console.log(JSON.stringify({file:resolved,bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")}))
}
