const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const AdmZip = require("adm-zip")

const root = path.resolve(__dirname, "..")

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function relativePath(file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function category(name) {
  if (name.startsWith("META-INF/")) return "metadata"
  if (name.startsWith("i18n/")) return "i18n"
  if (/^manifest(?:-[^/]+)?\.json$/.test(name)) return "manifest"
  const extension = path.posix.extname(name).slice(1).toLowerCase()
  if (["png", "jsc", "js", "map"].includes(extension)) return extension
  if (["ttf", "otf", "woff", "woff2"].includes(extension)) return "font"
  return "other"
}

function sumEntries(entries, keyForEntry) {
  const groups = {}
  for (const entry of entries) {
    const key = keyForEntry(entry.entryName)
    const group = groups[key] || (groups[key] = {files: 0, rawBytes: 0, compressedBytes: 0})
    group.files++
    group.rawBytes += entry.header.size
    group.compressedBytes += entry.header.compressedSize
  }
  return Object.fromEntries(Object.keys(groups).sort().map((key) => [key, groups[key]]))
}

function signingCertificate(buffer, zip) {
  // Read only the public certificate; verify that its DER is actually embedded in this RPK.
  const certificatePath = ["sign/release/certificate.pem", "sign/certificate.pem"]
    .find((file) => fs.existsSync(path.join(root, file)) &&
      fs.existsSync(path.join(root, path.dirname(file), "private.pem")))
  if (!certificatePath) return null
  const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(root, certificatePath)))
  const certEntry = zip.getEntry("META-INF/CERT")
  const embeddedMatch = buffer.includes(certificate.raw) ||
    Boolean(certEntry && certEntry.getData().includes(certificate.raw))
  return {path: certificatePath, sha256: sha256(certificate.raw), embeddedMatch}
}

function analyze(file) {
  const buffer = fs.readFileSync(file)
  const zip = new AdmZip(buffer)
  const manifestEntry = zip.getEntry("manifest.json")
  if (!manifestEntry) throw new Error("RPK 中缺少 manifest.json")
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"))
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  const totals = sumEntries(entries, () => "total").total
  const packageConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  return {
    schemaVersion: 1,
    artifact: {
      file: relativePath(file),
      sha256: sha256(buffer),
      bytes: buffer.length,
      ...totals,
      containerOverheadBytes: buffer.length - totals.compressedBytes
    },
    application: {
      package: manifest.package,
      versionName: manifest.versionName,
      versionCode: manifest.versionCode
    },
    build: {
      // This is the current configuration, not a reconstruction of the historical CLI invocation.
      configuredReleaseCommand: packageConfig.scripts.release,
      commandSource: "package.json scripts.release at analysis time",
      embedded: manifest.packageInfo || {},
      signingCertificate: signingCertificate(buffer, zip)
    },
    categories: sumEntries(entries, category),
    directories: sumEntries(entries, (name) => name.startsWith("pages/")
      ? name.split("/").slice(0, 2).join("/") : name.split("/")[0])
  }
}

function compareReports(current, baseline) {
  const validStats = (stats) => stats && ["files", "rawBytes", "compressedBytes"]
    .every((key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0)
  if (!baseline || baseline.schemaVersion !== 1 || !validStats(baseline.artifact) ||
      !Number.isSafeInteger(baseline.artifact.bytes) || baseline.artifact.bytes < 0 ||
      typeof baseline.artifact.sha256 !== "string" || !baseline.application ||
      !baseline.build || !baseline.categories ||
      !Object.values(baseline.categories).every(validStats)) throw new Error("基线报告格式无效")
  if (current.application.package !== baseline.application.package) {
    throw new Error("当前 RPK 与基线的应用包名不同")
  }
  const difference = (now = {}, before = {}) => Object.fromEntries(
    ["files", "rawBytes", "compressedBytes"].map((key) => [key, (now[key] || 0) - (before[key] || 0)])
  )
  const buildDifferences = []
  if (current.build.configuredReleaseCommand !== baseline.build.configuredReleaseCommand) {
    buildDifferences.push("configuredReleaseCommand")
  }
  for (const key of ["toolkit", "node", "platform", "arch", "component"]) {
    if (current.build.embedded[key] !== baseline.build.embedded?.[key]) {
      buildDifferences.push("embedded." + key)
    }
  }
  if (current.build.signingCertificate?.sha256 !== baseline.build.signingCertificate?.sha256) {
    buildDifferences.push("signingCertificate.sha256")
  }
  if (current.build.signingCertificate?.embeddedMatch !== baseline.build.signingCertificate?.embeddedMatch) {
    buildDifferences.push("signingCertificate.embeddedMatch")
  }
  return {
    baselineSha256: baseline.artifact.sha256,
    identicalArtifact: current.artifact.sha256 === baseline.artifact.sha256,
    bytesDelta: current.artifact.bytes - baseline.artifact.bytes,
    ...difference(current.artifact, baseline.artifact),
    categories: Object.fromEntries([...new Set([
      ...Object.keys(current.categories), ...Object.keys(baseline.categories)
    ])].sort().map((key) => [key, difference(current.categories[key], baseline.categories[key])])),
    buildDifferences
  }
}

function formatBytes(value) {
  return `${value} B (${(value / 1024).toFixed(1)} KiB)`
}

function printGroups(title, groups) {
  console.log("\n" + title + "：")
  console.log("分组\t文件数\t未压缩 B\t包内压缩 B")
  for (const [name, group] of Object.entries(groups)) {
    console.log(`${name}\t${group.files}\t${group.rawBytes}\t${group.compressedBytes}`)
  }
}

function printReport(report) {
  console.log("RPK：" + report.artifact.file)
  console.log("SHA-256：" + report.artifact.sha256)
  console.log("应用：" + report.application.package + " " + report.application.versionName +
    " / " + report.application.versionCode)
  console.log("完整包体：" + formatBytes(report.artifact.bytes))
  console.log("包内文件数：" + report.artifact.files)
  console.log("文件未压缩合计：" + formatBytes(report.artifact.rawBytes))
  console.log("文件压缩合计：" + formatBytes(report.artifact.compressedBytes))
  console.log("容器 / 签名等附加数据：" + formatBytes(report.artifact.containerOverheadBytes))
  console.log("当前 release 配置：" + report.build.configuredReleaseCommand)
  console.log("产物构建信息：" + JSON.stringify(report.build.embedded))
  const certificate = report.build.signingCertificate
  console.log("签名证书 SHA-256：" + (certificate
    ? certificate.sha256 + "；已匹配产物：" + certificate.embeddedMatch : "未核实"))
  printGroups("资源类型", report.categories)
  printGroups("资源目录", report.directories)
  if (report.comparison) {
    const comparison = report.comparison
    console.log("\n基线对比（当前 - 基线；负数表示缩小）：")
    console.log("同一产物：" + comparison.identicalArtifact)
    console.log("完整包体差值：" + formatBytes(comparison.bytesDelta))
    printGroups("资源类型差值", comparison.categories)
    console.log("构建配置差异：" + (comparison.buildDifferences.join(", ") || "无"))
  }
  console.log("\n未压缩体积和 PNG 文件体积均不代表真实运行内存。")
}

function main(args) {
  let file, baselineFile, json = false
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === "--help") {
      console.log("用法：npm run analyze:size -- [RPK路径] [--baseline 报告路径] [--json]")
      console.log("默认分析 dist 中当前应用版本的 release RPK。命令只读取文件，不构建或写入报告。")
      return
    } else if (argument === "--json") {
      json = true
    } else if (argument === "--baseline") {
      baselineFile = args[++i]
      if (!baselineFile || baselineFile.startsWith("--")) throw new Error("--baseline 需要报告路径")
    } else if (argument.startsWith("--") || file) {
      throw new Error("无法识别参数：" + argument)
    } else {
      file = argument
    }
  }
  if (!file) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"))
    file = path.join(root, "dist", `${manifest.package}.release.${manifest.versionName}.rpk`)
  }
  const report = analyze(path.resolve(file))
  if (baselineFile) {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(baselineFile), "utf8"))
    report.comparison = compareReports(report, baseline)
  }
  if (json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error("包体分析失败：" + error.message)
    process.exitCode = 1
  }
}

module.exports = {analyze, compareReports}
