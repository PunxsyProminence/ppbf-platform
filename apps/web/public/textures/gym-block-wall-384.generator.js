/* A black-painted concrete block wall, generated as a seamless tileable RGB
   PNG. No image library: node's zlib compresses, the PNG container is built
   by hand.

   WHY BLOCK AND NOT FLAT PAINT. The gym is block-built -- it is visible behind
   the boards in the club's own photographs -- and coursing is identity you can
   read at a glance without writing anything on the wall. Structure, not
   content: nothing here competes with an object hung in front of it.

   SEAMLESS BY CONSTRUCTION. The tile is exactly two blocks wide and two
   courses tall, and the running bond offsets the second course by half a
   block, so the half-block at the left edge completes the half-block at the
   right. Vertical wrap is the two courses. Every noise field wraps on the same
   period. That means one ~100KB file covers any viewport with no seam and no
   stretching, which a single photograph cannot do.

   DETERMINISTIC from a seed, so a regenerated file is byte-identical and a
   diff means somebody changed something on purpose. */
const zlib = require('zlib');
const fs = require('fs');

const BW = 192, BH = 96;            // one block
const W = BW * 2, H = BH * 2;       // the tile: 2 blocks x 2 courses
const JOINT = 5;                    // mortar joint, px
const SEED = 20260926;

let s = SEED >>> 0;
const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

/* Wrapping value noise, so the tooth wraps with the tile. */
function lattice(px, py) {
  const g = new Float64Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x, y) => {
    const fx = x * px / W, fy = y * py / H;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (a, b) => g[(((b % py) + py) % py) * px + (((a % px) + px) % px)];
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy)
         + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}
const cloud = lattice(4, 2);
const tooth = lattice(24, 12);

/* Per-block value jitter, keyed so the same block always gets the same value
   and the wrap stays consistent. Two courses, two blocks each. */
const blockShift = [];
for (let i = 0; i < 4; i++) blockShift.push((rnd() - 0.5) * 11);

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const row = y * (W * 3 + 1);
  raw[row] = 0;                                   // filter: none
  const course = Math.floor(y / BH);              // 0 or 1
  const offset = course === 1 ? BW / 2 : 0;       // running bond
  const yInBlock = y - course * BH;

  for (let x = 0; x < W; x++) {
    const xs = (x + offset) % W;
    const xInBlock = xs % BW;
    const blockIndex = course * 2 + Math.floor(xs / BW);

    // Distance into the joint, horizontally and vertically.
    const dx = Math.min(xInBlock, BW - 1 - xInBlock);
    const dy = Math.min(yInBlock, BH - 1 - yInBlock);
    const inJoint = dx < JOINT || dy < JOINT;

    /* Warm near-black. The wall is painted, so the joint is painted too --
       it reads as a recess in the same colour rather than grey mortar. */
    let v = 34 + blockShift[blockIndex];
    v += (cloud(x, y) - 0.5) * 9;
    v += (tooth(x, y) - 0.5) * 11;
    v += (rnd() - 0.5) * 3.5;                     // paint grit

    if (inJoint) {
      const d = Math.min(dx, dy);
      v -= 22 * (1 - d / JOINT);                   // recessed, shadowed
    } else if (dy > BH - 1 - JOINT - 3 && dy > JOINT) {
      v += 0;                                     // no-op, kept for clarity
    }
    /* Light catches the top arris of each block, the way it does on a real
       painted wall lit from above. */
    if (!inJoint && yInBlock < JOINT + 4) v += 7 * (1 - (yInBlock - JOINT) / 4);

    const r = Math.max(0, Math.min(255, Math.round(v + 1.5)));
    const g = Math.max(0, Math.min(255, Math.round(v + 0.4)));
    const b = Math.max(0, Math.min(255, Math.round(v)));
    const p = row + 1 + x * 3;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
  }
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;   // 8-bit, colour type 2 = RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(process.argv[2], png);
console.log('wrote', process.argv[2], png.length, 'bytes', W + 'x' + H, 'RGB, seed', SEED);
