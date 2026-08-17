#!/usr/bin/env node
/**
 * Генерация иконок приложения без графических библиотек.
 *
 * Рисуем попиксельно и упаковываем в PNG вручную: zlib есть в стандартной
 * поставке Node, а тянуть ради двух картинок sharp или canvas не хочется.
 *
 *   node scripts/generate-icons.js
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';

const BACKGROUND = [15, 23, 32];
const BALL = [216, 242, 74];
const SEAM = [245, 250, 235];

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {(x:number,y:number)=>[number,number,number]} shade */
function renderPng(size, shade) {
  // Каждая строка PNG начинается с байта фильтра; используем 0 — «без фильтра».
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = shade(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // фильтрация по умолчанию
  ihdr[12] = 0; // без чересстрочности

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Сглаженное покрытие: доля пикселя внутри фигуры по расстоянию до края. */
const coverage = (distance, edge) =>
  Math.max(0, Math.min(1, (edge - distance) / 1.5 + 0.5));

const mix = (from, to, t) => from.map((v, i) => Math.round(v + (to[i] - v) * t));

function tennisBall(size, padding) {
  const center = size / 2;
  const radius = center * (1 - padding);

  // Швы мяча — дуги двух окружностей, чьи центры вынесены по горизонтали.
  const seamRadius = radius * 1.35;
  const seamOffset = radius * 1.62;
  const seamWidth = Math.max(1.4, radius * 0.075);

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    const dist = Math.hypot(px - center, py - center);

    const inBall = coverage(dist, radius);
    if (inBall <= 0) return BACKGROUND;

    let color = mix(BACKGROUND, BALL, inBall);

    for (const cx of [center - seamOffset, center + seamOffset]) {
      const seamDist = Math.abs(Math.hypot(px - cx, py - center) - seamRadius);
      const onSeam = coverage(seamDist, seamWidth / 2) * inBall;
      if (onSeam > 0) color = mix(color, SEAM, onSeam);
    }
    return color;
  };
}

const ICONS = [
  { file: 'public/icon-192.png', size: 192, padding: 0.06 },
  { file: 'public/icon-512.png', size: 512, padding: 0.06 },
  // Maskable-иконку система обрезает по своей форме, поэтому поля крупнее.
  { file: 'public/icon-maskable-512.png', size: 512, padding: 0.22 },
  { file: 'public/favicon-32.png', size: 32, padding: 0.04 },
];

await mkdir('public', { recursive: true });
for (const { file, size, padding } of ICONS) {
  await writeFile(file, renderPng(size, tennisBall(size, padding)));
  console.log(`${file} — ${size}x${size}`);
}
