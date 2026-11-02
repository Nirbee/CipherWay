/*
 * Generates the two tray icons from the in-app shield mark:
 *   - resources/tray/tray-on.ico   connected: full-colour shield + green dot
 *   - resources/tray/tray-off.ico  disconnected: greyed-out shield
 *
 * Run: node scripts/make-tray-icons.cjs   (output is committed; shipped via
 * extraResources -> <resources>/tray).
 */
const fs = require('node:fs')
const path = require('node:path')
const Jimp = require('jimp')
const pngToIco = require('png-to-ico')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo-shield.png')
const OUT = path.join(ROOT, 'resources', 'tray')
const SIZES = [48, 32, 24, 20, 16]

function dot(img, size) {
  // status dot in the bottom-right corner, with a dark ring for contrast
  const r = Math.max(3, Math.round(size * 0.2))
  const cx = size - r - 1
  const cy = size - r - 1
  const ring = Jimp.rgbaToInt(10, 14, 28, 255)
  const green = Jimp.rgbaToInt(52, 211, 153, 255)
  img.scan(0, 0, size, size, (x, y) => {
    const d = Math.hypot(x - cx, y - cy)
    if (d <= r) img.setPixelColor(d <= r - 1.2 ? green : ring, x, y)
  })
  return img
}

async function build(variant) {
  const base = await Jimp.read(SRC)
  const buffers = []
  for (const s of SIZES) {
    let img = base.clone().resize(s, s, Jimp.RESIZE_BICUBIC)
    if (variant === 'off') img = img.greyscale().brightness(-0.1).fade(0.25)
    else img = dot(img, s)
    buffers.push(await img.getBufferAsync(Jimp.MIME_PNG))
  }
  const file = path.join(OUT, `tray-${variant}.ico`)
  fs.writeFileSync(file, await pngToIco(buffers))
  console.log(`  ${path.relative(ROOT, file)}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('generated:')
  await build('on')
  await build('off')
}

main().catch((e) => {
  console.error('make-tray-icons failed:', e.message)
  process.exit(1)
})
