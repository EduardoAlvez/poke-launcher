import zlib from 'node:zlib';

const SIZE = 32;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function buildBallIcon(size = SIZE) {
  const raw = [];
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) {
        raw.push(0, 0, 0, 0);
        continue;
      }
      const upper = dy < -r * 0.15;
      const band = Math.abs(dy + r * 0.15) < r * 0.16;
      const center = dist < r * 0.3;
      let color;
      if (band || center) color = [24, 26, 31, 255];
      else if (upper) color = [227, 178, 60, 255];
      else color = [235, 238, 244, 255];
      raw.push(color[0], color[1], color[2], color[3]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from(raw));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && process.argv[1].endsWith('make-icon.js')) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const out = path.join(process.cwd(), 'assets');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'icon.png'), buildBallIcon(32));
  await fs.writeFile(path.join(out, 'icon-256.png'), buildBallIcon(256));
  console.log('icones gerados em assets/');
}
