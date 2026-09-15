import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { generateIcons } from '../../scripts/generate-icons.js';

test('icon generation preserves canonical artwork and emits reproducible PNG and ICO assets', t => {
  const canonical = new URL('../../build/icons/1024x1024.png', import.meta.url);
  const original = fs.readFileSync(canonical);
  const source = PNG.sync.read(original);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-icons-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  generateIcons(output);
  assert.deepEqual(fs.readFileSync(canonical), original);
  assert.deepEqual(fs.readFileSync(path.join(output, 'icons/1024x1024.png')), original);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const bytes = fs.readFileSync(path.join(output, `icons/${size}x${size}.png`));
    const image = PNG.sync.read(bytes);
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assert.deepEqual(bytes, fs.readFileSync(new URL(`../../build/icons/${size}x${size}.png`, import.meta.url)));
  }
  const main = fs.readFileSync(path.join(output, 'icon.png'));
  assert.deepEqual(main, fs.readFileSync(path.join(output, 'icons/512x512.png')));
  const image = PNG.sync.read(main);
  // Independent 2x2 reference samples prove the output derives from source
  // artwork, including transparent corners and the cyan/green foreground.
  for (const [x, y] of [[0, 0], [10, 110], [150, 170], [256, 256], [256, 350], [400, 330]]) {
    const samples = [0, 1].flatMap(dy => [0, 1].map(dx => {
      const offset = ((y * 2 + dy) * 1024 + x * 2 + dx) * 4;
      return [...source.data.subarray(offset, offset + 4)];
    }));
    const alpha = samples.reduce((sum, pixel) => sum + pixel[3], 0);
    const expected = [0, 1, 2].map(channel => alpha
      ? Math.round(samples.reduce((sum, pixel) => sum + pixel[channel] * pixel[3], 0) / alpha) : 0);
    expected.push(Math.round(alpha / 4));
    assert.deepEqual([...image.data.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)], expected);
  }
  const ico = fs.readFileSync(path.join(output, 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 4);
  for (const [index, size] of [16, 32, 48, 256].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.deepEqual(ico.subarray(offset, offset + length), fs.readFileSync(path.join(output, `icons/${size}x${size}.png`)));
  }
  assert.deepEqual(ico, fs.readFileSync(new URL('../../build/icon.ico', import.meta.url)));
  generateIcons(output);
  assert.deepEqual(fs.readFileSync(path.join(output, 'icon.ico')), ico);
});
