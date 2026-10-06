const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")
const { PNG } = require("pngjs")

const root = path.resolve(__dirname, "..")

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})

function crc(b) {
  let c = 0xffffffff
  for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type)
  const b = Buffer.alloc(data.length + 12)
  b.writeUInt32BE(data.length, 0)
  t.copy(b, 4)
  data.copy(b, 8)
  b.writeUInt32BE(crc(Buffer.concat([t, data])), data.length + 8)
  return b
}

function paeth(a, b, c) {
  const p = a + b - c
  const x = Math.abs(p - a)
  const y = Math.abs(p - b)
  const z = Math.abs(p - c)
  return x <= y && x <= z ? a : y <= z ? b : c
}

function filterScanlines(raw, w, h, bpp, adaptive) {
  const lineSize = w * bpp
  const out = Buffer.alloc((lineSize + 1) * h)
  for (let y = 0; y < h; y++) {
    let best = null
    let score = Infinity
    let bestType = 0
    const types = adaptive ? [0, 1, 2, 3, 4] : [0]
    for (const type of types) {
      const row = Buffer.alloc(lineSize)
      let s = 0
      for (let x = 0; x < lineSize; x++) {
        const a = x >= bpp ? raw[y * lineSize + x - bpp] : 0
        const b = y ? raw[(y - 1) * lineSize + x] : 0
        const c = y && x >= bpp ? raw[(y - 1) * lineSize + x - bpp] : 0
        const predictor = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c)
        const v = (raw[y * lineSize + x] - predictor) & 255
        row[x] = v
        s += Math.min(v, 256 - v)
      }
      if (s < score) {
        score = s
        best = row
        bestType = type
      }
    }
    out[y * (lineSize + 1)] = bestType
    best.copy(out, y * (lineSize + 1) + 1)
  }
  return out
}

function optimizePngBuffer(sourceBuffer) {
  const png = PNG.sync.read(sourceBuffer)
  const w = png.width
  const h = png.height
  const originalSize = sourceBuffer.length
  let bestBuffer = sourceBuffer
  let method = "original"

  const colors = []
  const lookup = new Map()
  let isGray = true
  for (let i = 0; i < w * h; i++) {
    const r = png.data[i * 4]
    const g = png.data[i * 4 + 1]
    const b = png.data[i * 4 + 2]
    if (r !== g || g !== b) isGray = false
    const rgba = png.data.readUInt32BE(i * 4)
    if (!lookup.has(rgba)) {
      lookup.set(rgba, colors.length)
      colors.push(rgba)
    }
  }

  // Preserve color management chunks if present
  const colorChunks = []
  for (let o = 8; o < sourceBuffer.length;) {
    const n = sourceBuffer.readUInt32BE(o)
    const t = sourceBuffer.toString("ascii", o + 4, o + 8)
    if (["sRGB", "gAMA", "cHRM", "iCCP"].includes(t)) {
      colorChunks.push(sourceBuffer.subarray(o, o + n + 12))
    }
    o += n + 12
  }

  // Candidate 1: Palette PNG8 (colorType 3) if unique RGBA <= 256
  if (colors.length <= 256) {
    const plte = Buffer.alloc(colors.length * 3)
    const trns = Buffer.alloc(colors.length)
    let hasAlpha = false
    colors.forEach((v, i) => {
      plte[i * 3] = (v >>> 24) & 255
      plte[i * 3 + 1] = (v >>> 16) & 255
      plte[i * 3 + 2] = (v >>> 8) & 255
      trns[i] = v & 255
      if (trns[i] < 255) hasAlpha = true
    })
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8
    ihdr[9] = 3

    const idx = Buffer.alloc(w * h)
    for (let i = 0; i < w * h; i++) {
      idx[i] = lookup.get(png.data.readUInt32BE(i * 4))
    }

    for (const adaptive of [false, true]) {
      const filtered = filterScanlines(idx, w, h, 1, adaptive)
      for (const strategy of [0, 1, 2, 3]) {
        const idat = zlib.deflateSync(filtered, { level: 9, strategy })
        const parts = [
          sourceBuffer.subarray(0, 8),
          chunk("IHDR", ihdr),
          ...colorChunks,
          chunk("PLTE", plte)
        ]
        if (hasAlpha) parts.push(chunk("tRNS", trns))
        parts.push(chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)))
        const cand = Buffer.concat(parts)
        if (cand.length < bestBuffer.length) {
          if (PNG.sync.read(cand).data.equals(png.data)) {
            bestBuffer = cand
            method = "palette-PNG8"
          }
        }
      }
    }
  }

  // Candidate 2: Grayscale with Alpha (colorType 4) if all pixels are grayscale
  if (isGray) {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8
    ihdr[9] = 4

    const raw = Buffer.alloc(w * h * 2)
    for (let i = 0; i < w * h; i++) {
      raw[i * 2] = png.data[i * 4]
      raw[i * 2 + 1] = png.data[i * 4 + 3]
    }

    for (const adaptive of [false, true]) {
      const filtered = filterScanlines(raw, w, h, 2, adaptive)
      for (const strategy of [0, 1, 2, 3]) {
        const idat = zlib.deflateSync(filtered, { level: 9, strategy })
        const cand = Buffer.concat([
          sourceBuffer.subarray(0, 8),
          chunk("IHDR", ihdr),
          ...colorChunks,
          chunk("IDAT", idat),
          chunk("IEND", Buffer.alloc(0))
        ])
        if (cand.length < bestBuffer.length) {
          if (PNG.sync.read(cand).data.equals(png.data)) {
            bestBuffer = cand
            method = "gray-alpha"
          }
        }
      }
    }
  }

  // Candidate 3: RGBA recompression (colorType 6) with optimal filtering
  {
    for (const adaptive of [false, true]) {
      const filtered = filterScanlines(png.data, w, h, 4, adaptive)
      for (const strategy of [0, 1, 2, 3]) {
        const idat = zlib.deflateSync(filtered, { level: 9, strategy })
        const ihdr = Buffer.alloc(13)
        ihdr.writeUInt32BE(w, 0)
        ihdr.writeUInt32BE(h, 4)
        ihdr[8] = 8
        ihdr[9] = 6
        const cand = Buffer.concat([
          sourceBuffer.subarray(0, 8),
          chunk("IHDR", ihdr),
          ...colorChunks,
          chunk("IDAT", idat),
          chunk("IEND", Buffer.alloc(0))
        ])
        if (cand.length < bestBuffer.length) {
          if (PNG.sync.read(cand).data.equals(png.data)) {
            bestBuffer = cand
            method = "rgba-opt"
          }
        }
      }
    }
  }

  return {
    bestBuffer,
    originalSize,
    saved: originalSize - bestBuffer.length,
    method,
    pixelsEqual: PNG.sync.read(bestBuffer).data.equals(png.data)
  }
}

function findPngs(dir) {
  let res = []
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f)
    if (fs.statSync(full).isDirectory()) res.push(...findPngs(full))
    else if (f.endsWith(".png")) res.push(full)
  }
  return res
}

function formatBytes(bytes) {
  return `${bytes} B (${(bytes / 1024).toFixed(1)} KiB)`
}

function main(args) {
  const checkOnly = args.includes("--check")
  const targetDir = args.find((a) => !a.startsWith("--")) || path.join(root, "src")
  const pngFiles = findPngs(path.resolve(targetDir))

  console.log(`正在检查 ${pngFiles.length} 个 PNG 图片 (模式: ${checkOnly ? "只读检查" : "无损优化写入"})...\n`)

  let totalOriginal = 0
  let totalOptimized = 0
  let optimizedFilesCount = 0

  for (const file of pngFiles) {
    const rel = path.relative(root, file).split(path.sep).join("/")
    const originalBuf = fs.readFileSync(file)
    totalOriginal += originalBuf.length

    const res = optimizePngBuffer(originalBuf)
    totalOptimized += res.bestBuffer.length

    if (!res.pixelsEqual) {
      throw new Error(`CRITICAL: 像素校验不匹配: ${rel}`)
    }

    if (res.saved > 0) {
      optimizedFilesCount++
      console.log(`[优化] ${rel}: ${originalBuf.length} -> ${res.bestBuffer.length} B (节省 ${res.saved} B, 方式: ${res.method})`)
      if (!checkOnly) {
        fs.writeFileSync(file, res.bestBuffer)
      }
    }
  }

  const totalSaved = totalOriginal - totalOptimized
  console.log(`\n统计: 共处理 ${pngFiles.length} 个文件，其中 ${optimizedFilesCount} 个可压缩。`)
  console.log(`原始总大小: ${formatBytes(totalOriginal)}`)
  console.log(`优化后大小: ${formatBytes(totalOptimized)}`)
  console.log(`节省总大小: ${formatBytes(totalSaved)} (节省比例: ${((totalSaved / totalOriginal) * 100).toFixed(1)}%)`)

  if (checkOnly && totalSaved > 0) {
    console.log(`\n提示: 运行 node tools/optimize-png.cjs 可将上述优化写回文件。`)
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error("图片优化失败:", err.message)
    process.exitCode = 1
  }
}

module.exports = { optimizePngBuffer, findPngs }
