/*
 * Generates the app icon + in-app brand assets from the source logo.
 *   - build/icon.ico                       (Windows app/installer icon)
 *   - src/renderer/src/assets/logo-shield.png  (sidebar / brand mark)
 *   - src/renderer/src/assets/logo-full.png    (full lockup, for larger use)
 *
 * Source: the 640x640 CipherWay logo. The shield occupies the upper square;
 * we crop it out for a clean square mark (the full lockup has text below).
 */
const fs = require('node:fs')
const path = require('node:path')
const Jimp = require('jimp')
const pngToIco = require('png-to-ico')

const SRC = process.argv[2] || 'C:/Users/nirbe/Downloads/logo.jpg'
const ROOT = path.join(__dirname, '..')
const ASSETS = path.join(ROOT, 'src', 'renderer', 'src', 'assets')
const BUILD = path.join(ROOT, 'build')

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true })
  fs.mkdirSync(BUILD, { recursive: true })

  const full = await Jimp.read(SRC)
  // full lockup asset
  await full.clone().writeAsync(path.join(ASSETS, 'logo-full.png'))

  // crop the shield (centered square in the upper portion, above the text)
  const shield = full.clone().crop(150, 60, 340, 340)
  await shield.clone().resize(256, 256).writeAsync(path.join(ASSETS, 'logo-shield.png'))

  // multi-resolution .ico from the shield
  const sizes = [256, 128, 64, 48, 32, 16]
  const buffers = []
  for (const s of sizes) {
    buffers.push(await shield.clone().resize(s, s).getBufferAsync(Jimp.MIME_PNG))
  }
  const ico = await pngToIco(buffers)
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico)

  console.log('generated:')
  console.log('  build/icon.ico')
  console.log('  src/renderer/src/assets/logo-shield.png')
  console.log('  src/renderer/src/assets/logo-full.png')
}

main().catch((e) => {
  console.error('make-icons failed:', e.message)
  process.exit(1)
})
