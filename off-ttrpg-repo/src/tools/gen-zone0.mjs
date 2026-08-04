// Generates zone0-room.json — the Zone 0 map transcribed from the reference
// image (320×1152), scaled ×1.5 so the 24×32 party sprites keep the same
// sprite-to-zone ratio as the reference shot.
import { writeFileSync } from 'node:fs';

const S = 1.5;
const r = v => Math.round(v * S);
const floors = [], structs = [], props = [];
const f = (p, x, y, w, h) => floors.push({ p, x: r(x), y: r(y), w: r(w), h: r(h) });
const g = (t, x, y, w, h) => structs.push({ t, x: r(x), y: r(y), w: r(w), h: r(h) });
const pr = (t, x, y, extra = {}) => props.push({ t, x: r(x), y: r(y), ...extra });

// ---- the building ----
f('gold0', 50, 400, 220, 330);       // shell
f('gold0top', 58, 408, 204, 52);     // upper storey band
f('gold0deep', 58, 460, 204, 262);   // lower storey interior

// ---- porch, corridor, block, plaza ----
f('gold0', 75, 730, 170, 72);
f('gold0', 140, 802, 40, 166);
f('gold0', 133, 968, 54, 72);
f('gold0', 115, 1040, 90, 110);
// corner tabs around the plaza
f('gold0', 86, 1032, 32, 34); f('gold0', 202, 1032, 32, 34);
f('gold0', 86, 1116, 32, 34); f('gold0', 202, 1116, 32, 34);

// ---- the pale paths (pills) ----
f('path0', 90, 426, 74, 18);         // upper storey walk
f('path0', 150, 426, 18, 36);        // elbow down to the ladder
f('path0', 95, 624, 73, 16);         // interior walkway between the two ladders
f('path0', 95, 730, 18, 38);         // off the left ladder
f('path0', 95, 752, 73, 16);         // porch, left arm
f('path0', 160, 752, 78, 16);        // porch, right arm
f('path0', 222, 704, 16, 52);        // down from the white door
f('path0', 152, 752, 16, 324);       // the long walk south, ending in the blob
f('path0', 133, 1064, 54, 60);       // the fist's blob

// ---- the inner house (walls block; the doorway is the way in) ----
f('ink0', 151, 712, 18, 40);         // doorway opening
g('hut0', 125, 672, 26, 80);
g('hut0', 151, 672, 18, 44);         // lintel above the doorway
g('hut0', 169, 672, 23, 80);

// ---- storey edges: cross by ladder, not by walking ----
f('line0', 50, 458, 220, 3);                                     // the visible storey line, unbroken
g('block0', 50, 458, 100, 4); g('block0', 170, 458, 100, 4);     // walk blockers; gap = upper ladder
g('block0', 50, 722, 45, 8); g('block0', 113, 722, 12, 8); g('block0', 192, 722, 78, 8); // gaps = left ladder + house

// ---- props ----
pr('stairs0', 74, 418);
pr('ladder', 154, 462, { h: r(172) });
pr('ladder', 97, 630, { h: r(100) });
for (const [wx, wy] of [[114, 492], [209, 492], [84, 575], [116, 575], [209, 655], [174, 718]]) pr('window0', wx, wy);
pr('doorwhite', 222, 678);           // flush with the bottom wall, above its porch path
for (const [bx, by] of [[92, 1040], [214, 1040], [92, 1126], [214, 1126]]) pr('greyblock', bx, by);
pr('fist', 141, 1068);

const room = {
  w: r(320), h: r(1152),
  bg: 'squiggle0',
  spawn: { x: r(154), y: r(1132) },
  floors, structs, props, pieces: [],
};
writeFileSync(new URL('../server/data/zone0-room.json', import.meta.url), JSON.stringify(room, null, 1) + '\n');
console.log('zone0-room.json:', room.w, 'x', room.h, floors.length, 'floors,', structs.length, 'structs,', props.length, 'props');
