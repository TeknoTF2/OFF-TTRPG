// Canon map importer — offline batch converter per assets/level creation/README.
// Reads RPG Maker 2003 LCF binaries (Map####.lmu, RPG_RT.ldb, RPG_RT.lmt) and
// emits, per map: tilemap.json (neutral render recipe, autotile shapes already
// resolved to chipset-relative quadrant rects), collision.json (16px boolean
// grid), pins.json (event positions + Transfer Player destinations); plus one
// global rooms-index.json (names via the LMT + door connectivity).
//
// The engine never parses LCF — it dumb-blits tilemap.json from whichever
// chipset PNG the GM picks. Chunk IDs and tile math verified against the
// EasyRPG project's liblcf/Player documentation of the formats.
//
// Usage: node import-lmu.mjs [--one MapNNNN]   (from anywhere; paths are fixed)
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../assets/level creation/', import.meta.url));
const OUT = fileURLToPath(new URL('../server/data/canon/', import.meta.url));

// ---------------------------------------------------------------- LCF reading
class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  eof() { return this.p >= this.b.length; }
  u8() { return this.b[this.p++]; }
  varint() {                       // big-endian 7-bit groups, high bit = continue
    let v = 0;
    for (;;) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v >>> 0;
    }
  }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  str(n) { return Buffer.from(this.bytes(n)).toString('latin1'); }  // OFF is FR → cp1252-ish
  header() { const n = this.varint(); return this.str(n); }
}

// Read a chunk stream (id 0 terminates when `zeroEnds`); cb(id, dataReader, len).
function chunks(r, cb, { zeroEnds = true } = {}) {
  while (!r.eof()) {
    const id = r.varint();
    if (zeroEnds && id === 0) return;
    const len = r.varint();
    const body = new R(r.bytes(len));
    cb(id, body, len);
  }
}

// LCF array-of-structs: count, then per element: 1-based index, chunk stream.
function lcfArray(r, cb) {
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const idx = r.varint();
    const fields = {};
    chunks(r, (id, body, len) => { fields[id] = { body, len }; });
    cb(idx, fields);
  }
}

function readI16(bytes, len) {
  const out = new Int16Array(len / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  return out;
}

// ---------------------------------------------------------------- LMU (maps)
function parseLmu(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfMapUnit') throw new Error('not an LMU');
  const map = { chipsetId: 1, w: 20, h: 15, lower: null, upper: null, events: [] };
  chunks(r, (id, body, len) => {
    if (id === 0x01) map.chipsetId = body.varint();
    else if (id === 0x02) map.w = body.varint();
    else if (id === 0x03) map.h = body.varint();
    else if (id === 0x1f) map.panoFlag = !!body.varint();
    else if (id === 0x20) map.pano = body.str(len).trim();
    else if (id === 0x47) map.lower = readI16(body.b, len);
    else if (id === 0x48) map.upper = readI16(body.b, len);
    else if (id === 0x51) {
      lcfArray(body, (evId, f) => {
        const ev = { id: evId, name: '', x: 0, y: 0, doors: [] };
        if (f[0x01]) ev.name = f[0x01].body.str(f[0x01].len).trim();
        if (f[0x02]) ev.x = f[0x02].body.varint();
        if (f[0x03]) ev.y = f[0x03].body.varint();
        if (f[0x05]) {
          lcfArray(f[0x05].body, (pageId, pf) => {
            // First page: if its graphic is a chipset tile (empty charset name),
            // bake it as static scenery — doors, ladders, signs live here.
            if (pageId === 1) {
              const charset = pf[0x15] ? pf[0x15].body.str(pf[0x15].len).trim() : '';
              const tileIdx = pf[0x16] ? pf[0x16].body.varint() : 0;
              const layer = pf[0x22] ? pf[0x22].body.varint() : 0;
              if (!charset && tileIdx > 0) ev.tile = { idx: tileIdx, above: layer === 2 };
            }
            if (!pf[0x34]) return;
            for (const c of parseCommands(pf[0x34].body)) {
              if (c.code === 10810 && c.params.length >= 3) {
                ev.doors.push({ map: c.params[0], x: c.params[1], y: c.params[2] });
              }
            }
          });
        }
        map.events.push(ev);
      });
    }
  }, { zeroEnds: false });
  return map;
}

function parseCommands(r) {
  const out = [];
  while (!r.eof()) {
    const code = r.varint();
    r.varint();                          // indent
    const slen = r.varint(); r.bytes(slen);
    const argc = r.varint();
    const params = [];
    for (let i = 0; i < argc; i++) params.push(r.varint());
    if (code) out.push({ code, params });
  }
  return out;
}

// ---------------------------------------------------------------- LDB (chipsets)
function parseLdbChipsets(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfDataBase') throw new Error('not an LDB');
  const chipsets = {};
  chunks(r, (id, body) => {
    if (id !== 0x14) return;             // 20 = chipset section
    lcfArray(body, (csId, f) => {
      const cs = { name: '', lower: null, upper: null };
      if (f[0x02]) cs.name = f[0x02].body.str(f[0x02].len).trim();
      if (f[0x04]) cs.lower = Buffer.from(f[0x04].body.b);
      if (f[0x05]) cs.upper = Buffer.from(f[0x05].body.b);
      chipsets[csId] = cs;
    });
  }, { zeroEnds: false });
  return chipsets;
}

// ---------------------------------------------------------------- LMT (names)
function parseLmt(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfMapTree') throw new Error('not an LMT');
  const names = {};
  const parents = {};
  lcfArray(r, (id, f) => {
    if (f[0x01]) names[id] = f[0x01].body.str(f[0x01].len).trim();
    if (f[0x02]) parents[id] = f[0x02].body.varint();
  });
  return { names, parents };              // trailing tree-order data is irrelevant here
}

// ---------------------------------------------------------------- tile math
// Chipset PNGs: 480×256, 16px tiles (30×16 grid). Quadrants are 8×8.
// Lower-layer tile IDs: 0-2999 water A/B · 3000-3999 animated C ·
// 4000-4599 terrain autotiles D (12 × 50 shapes) · 5000-5143 plain lower E.
// Upper-layer IDs: 10000-10143 plain upper F.
// The shape variant is baked into the stored ID — no neighbor matching here.

// Water (A/B) quadrant table: value = A-block row for the quadrant, -1 = take
// the quadrant from the B block instead. Indexed [aShape][row][col].
const A_SUB = [
  [[-1, -1], [-1, -1]], [[3, -1], [-1, -1]], [[-1, 3], [-1, -1]], [[3, 3], [-1, -1]],
  [[-1, -1], [-1, 3]], [[3, -1], [-1, 3]], [[-1, 3], [-1, 3]], [[3, 3], [-1, 3]],
  [[-1, -1], [3, -1]], [[3, -1], [3, -1]], [[-1, 3], [3, -1]], [[3, 3], [3, -1]],
  [[-1, -1], [3, 3]], [[3, -1], [3, 3]], [[-1, 3], [3, 3]], [[3, 3], [3, 3]],
  [[1, -1], [1, -1]], [[1, 3], [1, -1]], [[1, -1], [1, 3]], [[1, 3], [1, 3]],
  [[2, 2], [-1, -1]], [[2, 2], [-1, 3]], [[2, 2], [3, -1]], [[2, 2], [3, 3]],
  [[-1, 1], [-1, 1]], [[-1, 1], [3, 1]], [[3, 1], [-1, 1]], [[3, 1], [3, 1]],
  [[-1, -1], [2, 2]], [[3, -1], [2, 2]], [[-1, 3], [2, 2]], [[3, 3], [2, 2]],
  [[1, 1], [1, 1]], [[2, 2], [2, 2]], [[0, 2], [1, -1]], [[0, 2], [1, 3]],
  [[2, 0], [-1, 1]], [[2, 0], [3, 1]], [[-1, 1], [2, 0]], [[3, 1], [2, 0]],
  [[1, -1], [0, 2]], [[1, 3], [0, 2]], [[0, 0], [1, 1]], [[0, 2], [0, 2]],
  [[1, 1], [0, 0]], [[2, 0], [2, 0]], [[0, 0], [0, 0]],
];

// Terrain (D) quadrant table: [shape][row][col] → [dx, dy] tile offsets into
// the autotile's 3×4 template block.
const D_SUB = [
  [[[1, 2], [1, 2]], [[1, 2], [1, 2]]], [[[2, 0], [1, 2]], [[1, 2], [1, 2]]],
  [[[1, 2], [2, 0]], [[1, 2], [1, 2]]], [[[2, 0], [2, 0]], [[1, 2], [1, 2]]],
  [[[1, 2], [1, 2]], [[1, 2], [2, 0]]], [[[2, 0], [1, 2]], [[1, 2], [2, 0]]],
  [[[1, 2], [2, 0]], [[1, 2], [2, 0]]], [[[2, 0], [2, 0]], [[1, 2], [2, 0]]],
  [[[1, 2], [1, 2]], [[2, 0], [1, 2]]], [[[2, 0], [1, 2]], [[2, 0], [1, 2]]],
  [[[1, 2], [2, 0]], [[2, 0], [1, 2]]], [[[2, 0], [2, 0]], [[2, 0], [1, 2]]],
  [[[1, 2], [1, 2]], [[2, 0], [2, 0]]], [[[2, 0], [1, 2]], [[2, 0], [2, 0]]],
  [[[1, 2], [2, 0]], [[2, 0], [2, 0]]], [[[2, 0], [2, 0]], [[2, 0], [2, 0]]],
  [[[0, 2], [0, 2]], [[0, 2], [0, 2]]], [[[0, 2], [2, 0]], [[0, 2], [0, 2]]],
  [[[0, 2], [0, 2]], [[0, 2], [2, 0]]], [[[0, 2], [2, 0]], [[0, 2], [2, 0]]],
  [[[1, 1], [1, 1]], [[1, 1], [1, 1]]], [[[1, 1], [1, 1]], [[1, 1], [2, 0]]],
  [[[1, 1], [1, 1]], [[2, 0], [1, 1]]], [[[1, 1], [1, 1]], [[2, 0], [2, 0]]],
  [[[2, 2], [2, 2]], [[2, 2], [2, 2]]], [[[2, 2], [2, 2]], [[2, 0], [2, 2]]],
  [[[2, 0], [2, 2]], [[2, 2], [2, 2]]], [[[2, 0], [2, 2]], [[2, 0], [2, 2]]],
  [[[1, 3], [1, 3]], [[1, 3], [1, 3]]], [[[2, 0], [1, 3]], [[1, 3], [1, 3]]],
  [[[1, 3], [2, 0]], [[1, 3], [1, 3]]], [[[2, 0], [2, 0]], [[1, 3], [1, 3]]],
  [[[0, 2], [2, 2]], [[0, 2], [2, 2]]], [[[1, 1], [1, 1]], [[1, 3], [1, 3]]],
  [[[0, 1], [0, 1]], [[0, 1], [0, 1]]], [[[0, 1], [0, 1]], [[0, 1], [2, 0]]],
  [[[2, 1], [2, 1]], [[2, 1], [2, 1]]], [[[2, 1], [2, 1]], [[2, 0], [2, 1]]],
  [[[2, 3], [2, 3]], [[2, 3], [2, 3]]], [[[2, 0], [2, 3]], [[2, 3], [2, 3]]],
  [[[0, 3], [0, 3]], [[0, 3], [0, 3]]], [[[0, 3], [2, 0]], [[0, 3], [0, 3]]],
  [[[0, 1], [2, 1]], [[0, 1], [2, 1]]], [[[0, 1], [0, 1]], [[0, 3], [0, 3]]],
  [[[0, 3], [2, 3]], [[0, 3], [2, 3]]], [[[2, 1], [2, 1]], [[2, 3], [2, 3]]],
  [[[0, 1], [2, 1]], [[0, 3], [2, 3]]], [[[1, 2], [1, 2]], [[1, 2], [1, 2]]],
  [[[1, 2], [1, 2]], [[1, 2], [1, 2]]], [[[0, 0], [0, 0]], [[0, 0], [0, 0]]],
];

// D autotile template top-left (in tile coords) for block 0..11.
function dBlockOrigin(block) {
  if (block < 4) return [(block % 2) * 3, 8 + Math.floor(block / 2) * 4];
  return [6 + (block % 2) * 3, Math.floor((block - 4) / 2) * 4];
}

// A cell is either a single 16×16 source [sx,sy], four 8×8 quadrant sources
// [TLx,TLy,TRx,TRy,BLx,BLy,BRx,BRy], or null (empty). Coordinates in px.
function lowerCell(id) {
  if (id >= 5000 && id < 5144) {
    const t = id - 5000;
    const col = t < 96 ? 12 + t % 6 : 18 + (t - 96) % 6;
    const row = t < 96 ? Math.floor(t / 6) : Math.floor((t - 96) / 6);
    return [col * 16, row * 16];
  }
  if (id >= 4000 && id < 4600) {
    const block = Math.floor((id - 4000) / 50), shape = (id - 4000) % 50;
    const [bx, by] = dBlockOrigin(block);
    const q = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const [dx, dy] = D_SUB[shape][j][i];
      q.push((bx + dx) * 16 + i * 8, (by + dy) * 16 + j * 8);
    }
    return q;
  }
  if (id >= 3000 && id < 4000) {
    const col = 3 + Math.floor((id - 3000) / 50);
    return [col * 16, 4 * 16];           // static frame 0 of the C animation
  }
  if (id >= 0 && id < 3000) {
    // Water: block 0 = A1+coast, 1 = A2+coast, 2 = A1+deep.
    const block = Math.floor(id / 1000);
    const bSub = Math.floor((id % 1000) / 50), aSub = id % 50;
    if (aSub > 46) return null;
    const q = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const a = A_SUB[aSub][j][i];
      let col, row;
      let t = (bSub >> (j * 2 + i)) & 1;
      if (a === -1) {
        if (block === 2) t ^= 3;
        col = 0; row = 4 + t;            // B block, frame 0
      } else {
        col = block === 1 ? 3 : 0;       // A1 or A2, frame 0
        row = a;
      }
      // combined A+B: a B corner overrides where its bit is set
      if (bSub !== 0 && aSub !== 0 && a !== -1) {
        let bt = (bSub >> (j * 2 + i)) & 1;
        if (block === 2) bt *= 2;
        if (bt !== 0) { col = 0; row = 4 + bt; }
      }
      q.push(col * 16 + i * 8, row * 16 + j * 8);
    }
    return q;
  }
  return null;
}

function upperCell(id) {
  if (id === 10000) return null;         // F tile 0 is the blank upper tile
  if (id >= 10000 && id < 10144) {
    const t = id - 10000;
    const col = t < 48 ? 18 + t % 6 : 24 + (t - 48) % 6;
    const row = t < 48 ? 8 + Math.floor(t / 6) : Math.floor((t - 48) / 6);
    return [col * 16, row * 16];
  }
  return null;
}

// ---------------------------------------------------------------- passability
// passable_data_lower indices: water block 0-2 → 0-2, C → 3-5, D → 6-17,
// E → 18+tile. passable_data_upper: F tile directly. Bits: 1 down, 2 left,
// 4 right, 8 up, 0x10 above-hero, 0x20 wall, 0x40 counter.
function lowerPassIndex(id) {
  if (id >= 5000 && id < 5144) return 18 + (id - 5000);
  if (id >= 4000 && id < 4600) return 6 + Math.floor((id - 4000) / 50);
  if (id >= 3000 && id < 4000) return 3 + Math.floor((id - 3000) / 50);
  if (id >= 0 && id < 3000) return Math.floor(id / 1000);
  return null;
}

function cellWalkable(lowId, upId, cs) {
  const li = lowerPassIndex(lowId);
  const lbits = li != null && cs.lower && li < cs.lower.length ? cs.lower[li] : 0x0f;
  if ((lbits & 0x0f) === 0) return false;
  if (upId > 10000 && upId < 10144 && cs.upper) {   // 10000 itself = blank
    const ubits = cs.upper[upId - 10000] ?? 0x0f;
    if (ubits & 0x10) return true;       // above-hero never blocks
    if ((ubits & 0x0f) === 0) return false;
  }
  return true;
}

function upperAbove(upId, cs) {
  if (upId >= 10000 && upId < 10144 && cs.upper) return !!(cs.upper[upId - 10000] & 0x10);
  return false;
}

// ---------------------------------------------------------------- batch
const only = process.argv.includes('--one') ? process.argv[process.argv.indexOf('--one') + 1] : null;

const ldb = parseLdbChipsets(readFileSync(path.join(SRC, 'RPG_RT.ldb')));
const lmt = parseLmt(readFileSync(path.join(SRC, 'RPG_RT.lmt')));
const chipFiles = readdirSync(path.join(SRC, 'chipset')).filter(f => /\.png$/i.test(f));
console.log(`LDB: ${Object.keys(ldb).length} chipsets · LMT: ${Object.keys(lmt.names).length} map names · ${chipFiles.length} chipset PNGs`);

const mapFiles = readdirSync(path.join(SRC, 'maps')).filter(f => /^Map\d+\.lmu$/i.test(f)).sort();
const index = { maps: {}, chipsets: chipFiles };
let done = 0, failed = 0;

for (const mf of mapFiles) {
  const mapKey = mf.replace(/\.lmu$/i, '');
  if (only && mapKey !== only) continue;
  const mapId = parseInt(mapKey.slice(3), 10);
  try {
    const m = parseLmu(readFileSync(path.join(SRC, 'maps', mf)));
    if (!m.lower || m.lower.length !== m.w * m.h) throw new Error(`layer size mismatch (${m.w}×${m.h}, ${m.lower ? m.lower.length : 'none'})`);
    const cs = ldb[m.chipsetId] || { name: '', lower: null, upper: null };

    // tilemap: rows of cells; upper cells get a trailing 1 when above-hero.
    const lower = [], upper = [];
    for (let y = 0; y < m.h; y++) {
      const lrow = [], urow = [];
      for (let x = 0; x < m.w; x++) {
        const li = m.lower[y * m.w + x], ui = m.upper ? m.upper[y * m.w + x] : 0;
        lrow.push(lowerCell(li));
        const uc = upperCell(ui);
        if (uc && upperAbove(ui, cs)) uc.push(1);
        urow.push(uc);
      }
      lower.push(lrow); upper.push(urow);
    }

    // collision: string rows of 0/1 at the 16px grid
    const grid = [];
    for (let y = 0; y < m.h; y++) {
      let row = '';
      for (let x = 0; x < m.w; x++) {
        row += cellWalkable(m.lower[y * m.w + x], m.upper ? m.upper[y * m.w + x] : 0, cs) ? '1' : '0';
      }
      grid.push(row);
    }

    // pins: every event; doors carry their Transfer Player destination
    const pins = m.events.map(ev => ({
      id: ev.id, name: ev.name, x: ev.x, y: ev.y,
      door: ev.doors.length ? { map: ev.doors[0].map, x: ev.doors[0].x, y: ev.doors[0].y } : null,
    }));

    const nativeChip = chipFiles.find(f => f.replace(/\.png$/i, '').toLowerCase() === (cs.name || '').toLowerCase()) || null;
    // Static scenery from tile-graphic events (ladders, doors, signs): the
    // upper-tile source rect at the event's cell. Visual only — no behavior.
    const evTiles = [];
    for (const ev of m.events) {
      if (!ev.tile) continue;
      const cell = upperCell(10000 + ev.tile.idx);
      if (!cell) continue;
      if (ev.tile.above) cell.push(1);
      evTiles.push({ x: ev.x, y: ev.y, c: cell });
    }

    const dir = path.join(OUT, mapKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'tilemap.json'), JSON.stringify({
      w: m.w, h: m.h, tile: 16, lower, upper, ev: evTiles,
      pano: m.panoFlag && m.pano ? m.pano : null,       // panorama shows through keyed-transparent cells
    }));
    writeFileSync(path.join(dir, 'collision.json'), JSON.stringify({ width: m.w, height: m.h, grid }));
    writeFileSync(path.join(dir, 'pins.json'), JSON.stringify(pins));

    index.maps[mapKey] = {
      id: mapId,
      name: lmt.names[mapId] || mapKey,
      parent: lmt.parents[mapId] || 0,
      w: m.w, h: m.h,
      chipset: nativeChip,
      doorsTo: [...new Set(m.events.flatMap(ev => ev.doors.map(d => `Map${String(d.map).padStart(4, '0')}`)))],
      pinCount: pins.length,
      doorCount: pins.filter(p => p.door).length,
      pano: m.panoFlag && m.pano ? m.pano : null,
    };
    done++;
  } catch (err) {
    failed++;
    console.log(`SKIP ${mapKey}: ${err.message}`);
  }
}

if (!only) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'rooms-index.json'), JSON.stringify(index, null, 0));
}
console.log(`converted ${done} maps, skipped ${failed}${only ? ` (only ${only})` : ''}`);
