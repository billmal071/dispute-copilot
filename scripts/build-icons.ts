import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dirname, "..", "public", "icons");
const INK = [21, 23, 26] as const;
const PAPER = [244, 240, 230] as const;
const STAMP = [226, 85, 52] as const;

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

function coverage(u: number, v: number) {
  const roundedRect = (() => {
    const r = 0.22;
    const qx = Math.abs(u - 0.5) - (0.5 - r);
    const qy = Math.abs(v - 0.5) - (0.5 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  })();
  if (roundedRect > 0) return null;

  const dx = u - 0.5;
  const dy = v - 0.5;
  const radius = Math.hypot(dx, dy);
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  const inGap = angle > 40 && angle < 100;
  const onRing = Math.abs(radius - 0.3) < 0.045 && !inGap;
  const cap = (a: number) =>
    Math.hypot(
      u - (0.5 + 0.3 * Math.cos((a * Math.PI) / 180)),
      v - (0.5 + 0.3 * Math.sin((a * Math.PI) / 180)),
    ) < 0.045;
  const ring = onRing || cap(40) || cap(100);
  const check =
    segDist(u, v, 0.395, 0.505, 0.47, 0.585) < 0.045 ||
    segDist(u, v, 0.47, 0.585, 0.62, 0.42) < 0.045;
  return check ? STAMP : ring ? PAPER : INK;
}

function render(size: number): Buffer {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = coverage((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = Math.max(a, 1);
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return png(size, raw);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(size: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + i * 16;
    head[o] = size;
    head[o + 1] = size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

function grain(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let seed = 7;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed >>> 24;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const v = next();
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
      raw[o + 3] = 255;
    }
  }
  return png(size, raw);
}

writeFileSync(join(OUT, "grain.png"), grain(160));
writeFileSync(join(OUT, "apple-touch-icon.png"), render(180));
writeFileSync(join(OUT, "icon-192.png"), render(192));
writeFileSync(join(OUT, "icon-512.png"), render(512));
writeFileSync(
  join(OUT, "favicon.ico"),
  ico([16, 32, 48].map((size) => ({ size, data: render(size) }))),
);

const p = (a: number) => [
  (0.5 + 0.3 * Math.cos((a * Math.PI) / 180)) * 64,
  (0.5 + 0.3 * Math.sin((a * Math.PI) / 180)) * 64,
];
const [x1, y1] = p(100);
const [x2, y2] = p(40);
writeFileSync(
  join(OUT, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Dispute Copilot</title><rect width="64" height="64" rx="14" fill="#15171a"/><path d="M${x1?.toFixed(2)} ${y1?.toFixed(2)} A19.2 19.2 0 1 1 ${x2?.toFixed(2)} ${y2?.toFixed(2)}" fill="none" stroke="#f4f0e6" stroke-width="5.76" stroke-linecap="round"/><path d="M25.3 32.3l4.8 5 9.6-10.6" fill="none" stroke="#e25534" stroke-width="5.76" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);
console.log("icons written");
