/** Generate packaged icons from build/icons/1024x1024.png (canonical artwork).
 * Usage: node scripts/generate-icons.js [output-directory]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const sourcePath = join(buildDir, 'icons', '1024x1024.png');

// --- ICO encoder (embeds PNG images) ---
function encodeICO(pngBuffers, sizes) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: ICO
  header.writeUInt16LE(pngBuffers.length, 4); // image count

  // Directory entries: 16 bytes each
  const dirSize = pngBuffers.length * 16;
  const dir = Buffer.alloc(dirSize);
  let dataOffset = 6 + dirSize;

  for (let i = 0; i < pngBuffers.length; i++) {
    const s = sizes[i];
    const off = i * 16;
    dir[off] = s >= 256 ? 0 : s;     // width (0 = 256)
    dir[off + 1] = s >= 256 ? 0 : s; // height (0 = 256)
    dir[off + 2] = 0;                 // color palette
    dir[off + 3] = 0;                 // reserved
    dir.writeUInt16LE(1, off + 4);    // color planes
    dir.writeUInt16LE(32, off + 6);   // bits per pixel
    dir.writeUInt32LE(pngBuffers[i].length, off + 8);  // image size
    dir.writeUInt32LE(dataOffset, off + 12);            // data offset
    dataOffset += pngBuffers[i].length;
  }

  return Buffer.concat([header, dir, ...pngBuffers]);
}

// Area averaging with premultiplied alpha preserves transparent edges and
// covers fractional source pixels for sizes such as 24 and 48.
function resize(source, size) {
  const data = Buffer.alloc(size * size * 4);
  const scale = source.width / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const left = x * scale, right = (x + 1) * scale;
    const top = y * scale, bottom = (y + 1) * scale;
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
      for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
        const weight = (Math.min(right, sx + 1) - Math.max(left, sx))
          * (Math.min(bottom, sy + 1) - Math.max(top, sy));
        const offset = (sy * source.width + sx) * 4;
        const coverage = source.data[offset + 3] * weight;
        alpha += coverage;
        red += source.data[offset] * coverage;
        green += source.data[offset + 1] * coverage;
        blue += source.data[offset + 2] * coverage;
      }
    }
    const offset = (y * size + x) * 4;
    if (alpha > 0) {
      data[offset] = Math.round(red / alpha);
      data[offset + 1] = Math.round(green / alpha);
      data[offset + 2] = Math.round(blue / alpha);
    }
    data[offset + 3] = Math.round(alpha / (scale * scale));
  }
  return PNG.sync.write({ width: size, height: size, data });
}

export function generateIcons(outputDir = buildDir) {
  const original = readFileSync(sourcePath);
  const source = PNG.sync.read(original);
  if (source.width !== 1024 || source.height !== 1024) {
    throw new Error('Canonical icon must be a 1024x1024 PNG');
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map(sizes.map(size => [size, size === 1024 ? original : resize(source, size)]));
  const iconsDir = join(outputDir, 'icons');
  mkdirSync(iconsDir, { recursive: true });
  for (const [size, png] of pngs) {
    const destination = join(iconsDir, `${size}x${size}.png`);
    if (resolve(destination) !== resolve(sourcePath)) writeFileSync(destination, png);
  }
  writeFileSync(join(outputDir, 'icon.png'), pngs.get(512));
  const icoSizes = [16, 32, 48, 256];
  writeFileSync(join(outputDir, 'icon.ico'), encodeICO(icoSizes.map(size => pngs.get(size)), icoSizes));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcons(process.argv[2] ? resolve(process.argv[2]) : buildDir);
  console.log('Generated icons from the canonical 1024x1024 artwork.');
}
