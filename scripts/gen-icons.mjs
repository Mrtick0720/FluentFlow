// Generates original LinguaFlow icons programmatically (no external assets).
// Design: rounded square, indigo→teal diagonal gradient, four white "text line"
// bars — top pair solid (original text), bottom pair translucent (translation).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const INDIGO = [0x63, 0x66, 0xf1];
const TEAL = [0x14, 0xb8, 0xa6];
// [yStart, yEnd, xStart, xEnd, alpha] as fractions of icon size
const BARS = [
  [0.22, 0.32, 0.2, 0.8, 1],
  [0.4, 0.5, 0.2, 0.62, 1],
  [0.58, 0.68, 0.2, 0.8, 0.6],
  [0.76, 0.86, 0.2, 0.56, 0.6],
];

function pixel(x, y, size) {
  const r = size * 0.22; // corner radius
  const cx = Math.max(r - x, x - (size - 1 - r), 0);
  const cy = Math.max(r - y, y - (size - 1 - r), 0);
  if (cx * cx + cy * cy > r * r) return [0, 0, 0, 0];

  const t = (x + y) / (2 * (size - 1));
  let [pr, pg, pb] = INDIGO.map((c, i) => Math.round(c + (TEAL[i] - c) * t));

  for (const [y0, y1, x0, x1, a] of BARS) {
    if (y >= y0 * size && y < y1 * size && x >= x0 * size && x < x1 * size) {
      pr = Math.round(pr + (255 - pr) * a);
      pg = Math.round(pg + (255 - pg) * a);
      pb = Math.round(pb + (255 - pb) * a);
      break;
    }
  }
  return [pr, pg, pb, 255];
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size, pixel));
  console.log(`wrote icon${size}.png`);
}
