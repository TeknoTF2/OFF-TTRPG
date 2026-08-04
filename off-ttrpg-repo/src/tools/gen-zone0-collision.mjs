// Derives invisible collision for the Zone 0 room IMAGES (assets/backdrops/
// rooms/Zone 0/) by classifying their pixels: golds and pale paths walk,
// ink/white/grey and the paper background don't. Hand patches cover the few
// places art and rules disagree (ladders must stay crossable, the house door
// alcove opens, the swan is floor art). Output replaces zone0-room.json and
// zone0-interiors.json — rooms whose look IS the image, shapes collision-only.
//
// Dev tool: needs the server running on :8420 (images load through it) and
// Playwright (rendering happens in Chromium).
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const S = 1.5;                 // 320-wide art → in-game px (24×32 sprites)
const CELL = 4;

const ROOMS = [
  {
    name: 'Zone 0', file: 'Zone 0.jpg', mode: 'map', spawn: [152, 1138],
    // blocks first, then walks override
    block: [[46, 640, 226, 112]],                    // the lower building is structure…
    walk: [
      [160, 445, 20, 200],                           // central ladder (storey line included)
      [93, 626, 20, 132],                            // left ladder, down to the porch
      [96, 620, 82, 22],                             // the walkway between the ladders
      [142, 716, 20, 44],                            // house doorway alcove
      [222, 712, 20, 60],                            // path below the white door
    ],
  },
  { name: 'Z0 — Code Wall', file: 'Zone 0 room1.jpg', mode: 'interior', spawn: [152, 165] },
  { name: 'Z0 — Number Room', file: 'Zone 0 room2.jpg', mode: 'interior', spawn: [160, 160], walk: [[95, 82, 140, 18]] },
  { name: 'Z0 — Code Room', file: 'Zone 0 room3.jpg', mode: 'interior', spawn: [160, 165] },
  { name: 'Z0 — Storage', file: 'Zone 0 room4.jpg', mode: 'interior', spawn: [150, 170] },
  { name: 'Z0 — Corridor', file: 'Zone 0 room5.jpg', mode: 'interior', spawn: [150, 165] },
  { name: 'Z0 — Swan Room', file: 'Zone 0 room6.jpg', mode: 'interior', spawn: [150, 168], walk: [[92, 92, 138, 88]] },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('http://localhost:8420/');

const out = {};
for (const cfg of ROOMS) {
  const res = await page.evaluate(async ({ file, mode, block = [], walk = [], CELL }) => {
    const img = new Image();
    img.src = `/assets/backdrops/rooms/Zone 0/${encodeURIComponent(file)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
    // 1 = walkable, 0 = not
    const grid = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let walkPx = 0, darkPx = 0, n = 0;
      for (let py = gy * CELL; py < Math.min(H, gy * CELL + CELL); py++) {
        for (let px = gx * CELL; px < Math.min(W, gx * CELL + CELL); px++) {
          const i = (py * W + px) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          n++;
          const gold = r > 195 && g > 165 && g < 235 && b < 90;
          const mustard = r > 180 && r < 235 && g > 120 && g < 180 && b < 90;
          const pale = r > 200 && g > 200 && b < 130;
          if (gold || pale || (mode === 'map' && mustard)) walkPx++;
          if (r < 90 && g < 90 && b < 90) darkPx++;
        }
      }
      grid[gy * gw + gx] = (walkPx / n >= 0.55 && darkPx < 5) ? 1 : 0;
    }
    const inRect = (gx, gy, [rx, ry, rw, rh]) => {
      const cx = gx * CELL + CELL / 2, cy = gy * CELL + CELL / 2;
      return cx >= rx && cx < rx + rw && cy >= ry && cy < ry + rh;
    };
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      for (const r of block) if (inRect(gx, gy, r)) grid[gy * gw + gx] = 0;
      for (const r of walk) if (inRect(gx, gy, r)) grid[gy * gw + gx] = 1;
    }
    // despeckle: small non-walkable islands fully inside walkable space (digit
    // strokes, knuckle lines) become walkable; real obstacles are bigger
    const idx = (gx, gy) => gy * gw + gx;
    const visited = new Uint8Array(gw * gh);
    for (let gy = 1; gy < gh - 1; gy++) for (let gx = 1; gx < gw - 1; gx++) {
      if (grid[idx(gx, gy)] || visited[idx(gx, gy)]) continue;
      const comp = [[gx, gy]]; visited[idx(gx, gy)] = 1;
      let edgeOk = true;
      for (let qi = 0; qi < comp.length && comp.length <= 5; qi++) {
        const [cx2, cy2] = comp[qi];
        for (const [nx, ny] of [[cx2 + 1, cy2], [cx2 - 1, cy2], [cx2, cy2 + 1], [cx2, cy2 - 1]]) {
          if (nx <= 0 || ny <= 0 || nx >= gw - 1 || ny >= gh - 1) { edgeOk = false; continue; }
          if (grid[idx(nx, ny)]) continue;
          if (!visited[idx(nx, ny)]) { visited[idx(nx, ny)] = 1; comp.push([nx, ny]); }
        }
      }
      if (edgeOk && comp.length <= 5) for (const [cx2, cy2] of comp) grid[idx(cx2, cy2)] = 1;
    }
    // rect decomposition: horizontal runs per row, merged with identical runs above
    const rects = [];
    const open = new Map();   // "x0,x1" -> rect
    for (let gy = 0; gy < gh; gy++) {
      const rowRuns = [];
      let run = null;
      for (let gx = 0; gx <= gw; gx++) {
        if (gx < gw && grid[idx(gx, gy)]) { run = run || [gx, gx]; run[1] = gx; }
        else if (run) { rowRuns.push(run); run = null; }
      }
      const next = new Map();
      for (const [a, b] of rowRuns) {
        const key = `${a},${b}`;
        const prev = open.get(key);
        if (prev && prev.y1 === gy - 1) { prev.y1 = gy; next.set(key, prev); }
        else { const r = { x0: a, x1: b, y0: gy, y1: gy }; rects.push(r); next.set(key, r); }
      }
      open.clear(); for (const [k, v] of next) open.set(k, v);
    }
    return { W, H, rects: rects.map(r => [r.x0 * CELL, r.y0 * CELL, (r.x1 - r.x0 + 1) * CELL, (r.y1 - r.y0 + 1) * CELL]) };
  }, { ...cfg, CELL });

  const r15 = v => Math.round(v * S);
  out[cfg.name] = {
    w: r15(res.W), h: r15(res.H),
    backdrop: 'image', image: `backdrops/rooms/Zone 0/${cfg.file}`,
    spawn: { x: r15(cfg.spawn[0]), y: r15(cfg.spawn[1]) },
    floors: res.rects.map(([a, b, w2, h2]) => ({ p: 'gold0', x: r15(a), y: r15(b), w: r15(w2), h: r15(h2) })),
    structs: [], props: [], pieces: [],
  };
  console.log(cfg.name, `${res.W}x${res.H}`, out[cfg.name].floors.length, 'collision rects');
}
await browser.close();

const dataDir = new URL('../server/data/', import.meta.url).pathname;
writeFileSync(dataDir + 'zone0-room.json', JSON.stringify(out['Zone 0'], null, 1) + '\n');
const interiors = {};
for (const cfg of ROOMS) if (cfg.name !== 'Zone 0') interiors[cfg.name] = out[cfg.name];
writeFileSync(dataDir + 'zone0-interiors.json', JSON.stringify(interiors, null, 1) + '\n');
console.log('written: zone0-room.json + zone0-interiors.json');
