/**
 * Generate app icons for HTTP FreeKit in all required sizes.
 * Produces PNG files in build/ directory for electron-builder.
 *
 * Design: Blue circle (#4775e2) with white "H" letterform.
 * Matches the tray icon design in electron/tray.cjs.
 *
 * Usage: node scripts/generate-icons.js
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build');
const iconsDir = join(buildDir, 'icons');

// --- CRC32 ---
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- PNG encoder ---
function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePNG(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data with filter byte per row
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

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

// --- Icon renderer ---
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const off = (y * size + x) * 4;
    pixels[off] = r;
    pixels[off + 1] = g;
    pixels[off + 2] = b;
    pixels[off + 3] = a;
  }

  function blendPixel(x, y, r, g, b, coverage) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const off = (y * size + x) * 4;
    const existing_a = pixels[off + 3] / 255;
    const new_a = coverage;
    const out_a = new_a + existing_a * (1 - new_a);
    if (out_a === 0) return;
    pixels[off] = Math.round((r * new_a + pixels[off] * existing_a * (1 - new_a)) / out_a);
    pixels[off + 1] = Math.round((g * new_a + pixels[off + 1] * existing_a * (1 - new_a)) / out_a);
    pixels[off + 2] = Math.round((b * new_a + pixels[off + 2] * existing_a * (1 - new_a)) / out_a);
    pixels[off + 3] = Math.round(out_a * 255);
  }

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2;

  // Blue circle with anti-aliased edges (#4775e2)
  const br = 71, bg = 117, bb = 226;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 1) {
        setPixel(x, y, br, bg, bb, 255);
      } else if (dist <= radius) {
        // Anti-alias edge
        const coverage = Math.max(0, Math.min(1, radius - dist));
        setPixel(x, y, br, bg, bb, Math.round(coverage * 255));
      }
    }
  }

  // White "H" letterform
  const wr = 255, wg = 255, wb = 255;

  // H proportions relative to icon size
  const hLeft = Math.round(size * 0.25);       // left bar x start
  const hRight = Math.round(size * 0.625);      // right bar x start
  const barWidth = Math.round(size * 0.125);     // bar thickness
  const hTop = Math.round(size * 0.1875);        // top of vertical bars
  const hBottom = Math.round(size * 0.8125);     // bottom of vertical bars
  const crossTop = Math.round(size * 0.4375);    // crossbar top
  const crossBottom = Math.round(size * 0.5625); // crossbar bottom

  // Left vertical bar
  for (let y = hTop; y < hBottom; y++) {
    for (let x = hLeft; x < hLeft + barWidth; x++) {
      blendPixel(x, y, wr, wg, wb, 1);
    }
  }

  // Right vertical bar
  for (let y = hTop; y < hBottom; y++) {
    for (let x = hRight; x < hRight + barWidth; x++) {
      blendPixel(x, y, wr, wg, wb, 1);
    }
  }

  // Horizontal crossbar
  for (let y = crossTop; y < crossBottom; y++) {
    for (let x = hLeft; x < hRight + barWidth; x++) {
      blendPixel(x, y, wr, wg, wb, 1);
    }
  }

  return pixels;
}

// --- Main ---
mkdirSync(buildDir, { recursive: true });
mkdirSync(iconsDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

console.log('Generating app icons...');

// Generate individual PNGs for Linux (in build/icons/)
const pngBuffers = {};
for (const s of sizes) {
  const pixels = renderIcon(s);
  const png = encodePNG(s, s, pixels);
  pngBuffers[s] = png;

  const filename = join(iconsDir, `${s}x${s}.png`);
  writeFileSync(filename, png);
  console.log(`  Created ${s}x${s}.png (${png.length} bytes)`);
}

// Main icon.png at 512x512 for electron-builder
const mainIcon = pngBuffers[512];
writeFileSync(join(buildDir, 'icon.png'), mainIcon);
console.log(`  Created build/icon.png (512x512)`);

// Generate ICO for Windows (embeds 16, 32, 48, 256 as PNG)
const icoSizes = [16, 32, 48, 256];
const icoPngs = icoSizes.map(s => pngBuffers[s]);
const ico = encodeICO(icoPngs, icoSizes);
writeFileSync(join(buildDir, 'icon.ico'), ico);
console.log(`  Created build/icon.ico (${ico.length} bytes)`);

console.log('Done! Icons written to build/');
