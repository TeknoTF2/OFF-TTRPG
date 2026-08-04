// Generates zone0-interiors.json — the five interior rooms of Zone 0,
// transcribed from the reference shots (320×240 each) at the same ×1.5 scale.
// Interiors float in the dark (bg black0); outlines are inkwall0 underlays,
// so the rim is unwalkable and the golds inset on top are the floor.
import { writeFileSync } from 'node:fs';

const S = 1.5;
const r = v => Math.round(v * S);
const rooms = {};

function makeRoom(name, spawn, build) {
  const floors = [], structs = [], props = [];
  const f = (p, x, y, w, h) => floors.push({ p, x: r(x), y: r(y), w: r(w), h: r(h) });
  const g = (t, x, y, w, h) => structs.push({ t, x: r(x), y: r(y), w: r(w), h: r(h) });
  const pr = (t, x, y, extra = {}) => props.push({ t, x: r(x), y: r(y), ...extra });
  build(f, g, pr);
  rooms[name] = { w: r(320), h: r(240), bg: 'black0', spawn: { x: r(spawn[0]), y: r(spawn[1]) }, floors, structs, props, pieces: [] };
}

// ---- the swan room ----
makeRoom('Z0 — Swan Room', [150, 168], (f, g, pr) => {
  f('inkwall0', 73, 43, 174, 150);
  f('inkwall0', 138, 183, 26, 29);      // exit stub
  f('gold0deep', 76, 46, 168, 40);      // wall band
  f('gold0', 76, 86, 168, 104);         // floor
  f('gold0', 141, 186, 20, 23);         // stub floor
  g('block0', 76, 46, 168, 40);
  pr('mitrenw', 77, 47); pr('mitrene', 203, 47);
  pr('swan0', 118, 92);
});

// ---- the corridor with the tower ----
makeRoom('Z0 — Corridor', [150, 165], (f, g, pr) => {
  f('inkwall0', 183, 13, 70, 104);      // tower outline
  f('inkwall0', 53, 98, 200, 97);       // hall outline
  f('gold0deep', 186, 16, 64, 66);      // tower wall band
  f('gold0', 186, 82, 64, 45);          // tower alcove, opening into the hall
  f('gold0deep', 56, 101, 133, 26);     // hall wall band
  f('gold0', 56, 127, 194, 65);         // hall floor
  f('line0', 102, 101, 2, 26); f('line0', 146, 101, 2, 26);   // wall panel seams
  f('path0', 206, 86, 24, 26);          // the bright arch
  f('path0', 206, 95, 24, 55);          // walk down from the tower
  f('path0', 84, 138, 146, 24);         // walk across the hall
  g('block0', 186, 16, 64, 60);
  g('block0', 56, 101, 133, 26);
  pr('mitrenw', 187, 17); pr('mitrene', 209, 17);
  pr('mitrenw', 57, 102, { h: 36 }); pr('mitrene', 164, 102, { h: 36 });
  pr('doordark0', 208, 26);
  pr('steps0', 60, 126);
});

// ---- the storage room (grey blocks) ----
makeRoom('Z0 — Storage', [150, 172], (f, g, pr) => {
  f('inkwall0', 43, 33, 229, 173);
  f('inkwall0', 227, 203, 30, 26);      // exit stub, bottom right
  f('gold0deep', 46, 36, 223, 40);
  f('gold0', 46, 76, 223, 127);
  f('gold0', 230, 206, 24, 20);
  f('path0', 228, 98, 36, 46);          // the jigsaw tab, right wall
  f('path0', 239, 88, 18, 66);
  g('block0', 46, 36, 223, 40);
  for (const wx of [66, 126, 186]) pr('window0', wx, 46);
  pr('doorwhite', 236, 42);
  for (const [bx, by] of [[97, 86], [125, 86], [153, 86], [97, 114], [125, 114], [153, 114], [181, 114], [97, 142], [125, 142], [153, 142], [125, 170]]) pr('greyblock', bx, by);
  pr('steps0', 48, 112);
});

// ---- the code room (126 · 623) ----
makeRoom('Z0 — Code Room', [155, 172], (f, g, pr) => {
  f('inkwall0', 43, 38, 234, 160);
  f('gold0deep', 46, 41, 228, 42);
  f('gold0', 46, 83, 228, 112);
  f('path0', 95, 112, 130, 56);         // the platform
  f('path0', 86, 126, 22, 26); f('path0', 212, 126, 22, 26);   // its side tabs
  g('block0', 46, 41, 228, 42);
  let dx = 60;
  for (const d of ['1', '2', '6']) { pr('digit0', dx, 52, { text: d }); dx += 20; }
  dx = 208;
  for (const d of ['6', '2', '3']) { pr('digit0', dx, 52, { text: d }); dx += 20; }
  pr('window0', 132, 48); pr('window0', 182, 48);
  pr('pit0', 116, 120, { w: r(88), h: r(40) });
  pr('steps0', 50, 122); pr('steps0', 252, 122);
});

// ---- the number room (1 2 · 3 4) ----
makeRoom('Z0 — Number Room', [155, 172], (f, g, pr) => {
  f('inkwall0', 43, 40, 234, 158);
  f('gold0deep', 46, 43, 228, 42);
  f('gold0', 46, 85, 228, 110);
  f('path0', 95, 116, 130, 56);
  f('path0', 86, 130, 22, 26); f('path0', 212, 130, 22, 26);
  g('block0', 46, 43, 228, 42);
  pr('digit0', 116, 55, { text: '1' }); pr('digit0', 190, 55, { text: '3' });
  pr('digit0', 116, 88, { text: '2' }); pr('digit0', 190, 88, { text: '4' });
  pr('window0', 60, 52); pr('window0', 240, 52);
  pr('steps0', 54, 114); pr('greyblock', 52, 148); pr('greyblock', 70, 140);
  pr('steps0', 242, 114); pr('greyblock', 246, 148); pr('greyblock', 258, 124);
});

writeFileSync(new URL('../server/data/zone0-interiors.json', import.meta.url), JSON.stringify(rooms, null, 1) + '\n');
console.log('zone0-interiors.json:', Object.keys(rooms).join(' · '));
