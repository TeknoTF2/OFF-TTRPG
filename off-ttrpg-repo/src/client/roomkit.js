// The room kit renderer, shared by the player client and the GM console.
// Reference implementation: mockups/off-room-renderer.html — every pattern and
// prop is a ~10-line function; the builder lists whatever the kit contains.

// Zone 0 set: the flat golds, the squiggle-paper background, pill paths,
// ladders, framed windows, the stairs glyph and the fist. Fixed colors —
// Zone 0 looks like Zone 0 whatever chrome palette is active.
const Z0 = {
  paper: '#f2f4d0', squig: '#b0b378',
  gold: '#eac431', top: '#f2da3a', deep: '#cf9012',
  path: '#f7f292', ink: '#211d0c', white: '#fbfbf2', grey: '#5d5d5d',
};

function pill(x, r, col) {
  x.fillStyle = col;
  const rad = Math.min(r.w, r.h) / 2;
  x.beginPath();
  x.roundRect(r.x, r.y, r.w, r.h, rad);
  x.fill();
}

// The room kit: every pattern and prop is a ~10-line function (spec: off-room-renderer.html).
export function drawRoomKit(x, room, pal, phase) {
  const INK = '#000';
  const px = (a, b, w, h, col) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
  const box = (a, b, w, h, f) => { px(a, b, w, h, INK); px(a + 1, b + 1, w - 2, h - 2, f); };
  const FLOORS = {
    plain(r) { px(r.x, r.y, r.w, r.h, pal.pale); },
    brackets(r) {
      px(r.x, r.y, r.w, r.h, pal.dark); x.fillStyle = pal.lite;
      for (let y = r.y + 8; y < r.y + r.h - 8; y += 32) for (let a = r.x + 8; a < r.x + r.w - 8; a += 32) {
        x.fillRect(a, y, 6, 2); x.fillRect(a, y, 2, 6);
        x.fillRect(a + 16, y + 16, 6, 2); x.fillRect(a + 20, y + 12, 2, 6);
      }
    },
    carpet(r) {
      px(r.x, r.y, r.w, r.h, pal.dark); x.fillStyle = 'rgba(0,0,0,.25)';
      for (let y = r.y; y < r.y + r.h; y += 6) for (let a = r.x; a < r.x + r.w; a += 8) x.fillRect(a, y + (a / 8 % 2 ? 0 : 2), 4, 2);
    },
    path(r) {
      px(r.x, r.y, r.w, r.h, pal.lite); x.fillStyle = 'rgba(0,0,0,.18)';
      for (let y = r.y + 3; y < r.y + r.h; y += 10) for (let a = r.x + ((y / 10 % 2) ? 5 : 0); a < r.x + r.w - 3; a += 14) x.fillRect(a, y, 3, 2);
    },
    grass(r) {
      px(r.x, r.y, r.w, r.h, pal.base); x.fillStyle = pal.dark;
      for (let y = r.y + 5; y < r.y + r.h; y += 18) for (let a = r.x + ((y / 18 % 2) ? 9 : 2); a < r.x + r.w - 4; a += 22) { x.fillRect(a, y, 2, 4); x.fillRect(a + 3, y + 1, 2, 3); }
    },
    metal(r) {
      px(r.x, r.y, r.w, r.h, pal.dark); x.fillStyle = 'rgba(255,255,255,.14)';
      for (let y = r.y; y < r.y + r.h; y += 24) x.fillRect(r.x, y, r.w, 2);
      for (let a = r.x; a < r.x + r.w; a += 48) x.fillRect(a, r.y, 2, r.h);
    },
    tracks(r) {
      px(r.x, r.y, r.w, r.h, pal.lite); x.fillStyle = pal.dark;
      for (let y = r.y + 2; y < r.y + r.h; y += 12) x.fillRect(r.x, y, r.w, 3);
      x.fillStyle = INK; x.fillRect(r.x + 6, r.y, 3, r.h); x.fillRect(r.x + r.w - 9, r.y, 3, r.h);
    },
    water(r) {
      px(r.x, r.y, r.w, r.h, pal.dark); x.fillStyle = pal.lite;
      for (let y = r.y; y < r.y + r.h; y += 24) for (let a = r.x + ((y / 24 % 2) ? 8 : 0); a < r.x + r.w - 10; a += 32) x.fillRect(a + (phase ? 2 : 0), y + 8, 10, 2);
    },
    void(r) { px(r.x, r.y, r.w, r.h, '#000'); },
    // Zone 0 flats — walkable golds and the pale pill path.
    gold0(r) { px(r.x, r.y, r.w, r.h, Z0.gold); },
    gold0top(r) { px(r.x, r.y, r.w, r.h, Z0.top); },
    gold0deep(r) { px(r.x, r.y, r.w, r.h, Z0.deep); },
    path0(r) { pill(x, r, Z0.path); },
    ink0(r) { px(r.x, r.y, r.w, r.h, Z0.ink); },
    inkwall0(r) { px(r.x, r.y, r.w, r.h, Z0.ink); },   // same look, unwalkable — room outlines
    line0(r) { px(r.x, r.y, r.w, r.h, '#3a3213'); },   // visual storey line — walkable; pair with block0
  };
  const STRUCT = {
    wall(g) { box(g.x, g.y, g.w, g.h, pal.lite); px(g.x + 1, g.y + g.h - 5, g.w - 2, 4, pal.dark); },
    building(g) { box(g.x, g.y, g.w, g.h, pal.lite); px(g.x + 1, g.y + 1, g.w - 2, 10, pal.dark); px(g.x + 1, g.y + g.h - 5, g.w - 2, 4, 'rgba(0,0,0,.3)'); },
    fence(g) {
      px(g.x, g.y + g.h - 6, g.w, 2, INK); px(g.x, g.y + g.h - 11, g.w, 2, INK);
      for (let a = g.x; a < g.x + g.w; a += 14) px(a, g.y + g.h - 14, 3, 14, INK);
    },
    ledge(g) { px(g.x, g.y, g.w, g.h, pal.dark); px(g.x, g.y, g.w, 3, INK); px(g.x, g.y + g.h - 3, g.w, 3, 'rgba(0,0,0,.4)'); },
    // Zone 0 structure: floors of a building connect by ladder, not by walking
    // across an edge — block0 is an invisible edge blocker (draw a line0 floor
    // under it if the edge should be seen), hut0 a house wall with its roof band.
    block0() {},
    hut0(g) {
      px(g.x, g.y, g.w, g.h, Z0.gold);
      px(g.x, g.y, g.w, 21, Z0.top);
      px(g.x, g.y + 21, g.w, 3, 'rgba(0,0,0,.25)');
    },
  };
  const PROPS = {
    crate(a, b) { box(a, b, 20, 16, pal.lite); px(a + 2, b + 4, 16, 2, pal.dark); px(a + 2, b + 10, 16, 2, pal.dark); },
    barrel(a, b) { box(a, b, 14, 18, pal.lite); px(a + 1, b + 4, 12, 2, INK); px(a + 1, b + 12, 12, 2, INK); },
    cabinet(a, b) { box(a, b, 18, 22, '#4a4a4a'); px(a + 3, b + 3, 12, 7, '#6b6b6b'); px(a + 3, b + 12, 12, 7, '#6b6b6b'); },
    bottles(a, b) { for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { box(a + i * 7, b + j * 10, 6, 9, pal.lite); px(a + i * 7 + 2, b + j * 10 - 2, 2, 3, INK); } },
    counter(a, b, w) { box(a, b, w || 80, 12, pal.lite); px(a + 1, b + 9, (w || 80) - 2, 2, pal.dark); },
    rug(a, b) { px(a, b, 44, 26, pal.pale); px(a + 2, b + 2, 40, 22, pal.dark); px(a + 4, b + 4, 36, 18, pal.pale); },
    door(a, b) { box(a, b, 16, 22, pal.dark); px(a + 11, b + 10, 3, 3, pal.pale); },
    window(a, b) { box(a, b, 14, 12, pal.pale); px(a + 6, b + 1, 2, 10, INK); px(a + 1, b + 5, 12, 2, INK); },
    plant(a, b) { box(a, b + 8, 10, 8, pal.lite); px(a + 2, b, 2, 8, INK); px(a + 6, b + 2, 2, 6, INK); },
    stack(a, b) {
      box(a, b, 12, 30, '#4a4a4a'); px(a + 2, b + 2, 8, 4, '#2c2c2c');
      x.fillStyle = 'rgba(255,255,255,.5)';
      x.fillRect(a + 3 + (phase ? 3 : 0), b - 8, 5, 5); x.fillRect(a + 1 + (phase ? 0 : 4), b - 16, 6, 6); x.fillRect(a + 4 + (phase ? 4 : -2), b - 26, 7, 7);
    },
    lamp(a, b) { px(a + 4, b + 6, 3, 22, INK); box(a, b, 11, 8, pal.pale); },
    sign(a, b) { box(a, b, 20, 12, pal.pale); px(a + 9, b + 12, 3, 8, INK); },
    bed(a, b) { box(a, b, 20, 34, pal.lite); px(a + 2, b + 2, 16, 8, pal.pale); },
    shelf(a, b) { box(a, b, 30, 10, '#4a4a4a'); for (let i = 0; i < 5; i++) px(a + 3 + i * 5, b + 2, 3, 6, pal.lite); },
    vat(a, b) { box(a, b, 24, 26, '#4a4a4a'); px(a + 2, b + 2, 20, 5, pal.dark); px(a + 4, b + 4, 6, 2, pal.pale); },
    dock(a, b) { px(a, b, 26, 10, pal.lite); px(a, b, 26, 2, INK); px(a, b + 8, 26, 2, INK); px(a + 2, b + 10, 3, 4, INK); px(a + 21, b + 10, 3, 4, INK); },
    rock(a, b) { box(a, b + 3, 14, 9, pal.dark); px(a + 3, b, 8, 5, pal.dark); },
    // Zone 0 props.
    ladder(a, b, w, h) {
      const W = w || 21, H = h || 96;
      px(a, b, 3, H, Z0.ink); px(a + W - 3, b, 3, H, Z0.ink);
      for (let y = b + 3; y < b + H - 2; y += 9) px(a + 2, y, W - 4, 3, Z0.ink);
    },
    window0(a, b) { px(a, b, 21, 21, Z0.ink); px(a + 3, b + 3, 15, 15, Z0.white); px(a + 3, b + 13, 5, 5, 'rgba(0,0,0,.3)'); },
    stairs0(a, b) {
      // The little staircase glyph: three ascending steps, inked.
      px(a, b, 33, 30, Z0.ink);
      px(a + 3, b + 3, 27, 24, Z0.top);
      px(a + 3, b + 17, 9, 10, Z0.ink); px(a + 12, b + 10, 9, 17, Z0.ink); px(a + 21, b + 3, 9, 24, Z0.ink);
      px(a + 5, b + 19, 5, 8, Z0.white); px(a + 14, b + 12, 5, 15, Z0.white); px(a + 23, b + 5, 5, 22, Z0.white);
    },
    fist(a, b) {
      // The fist, thumb up.
      const F = Z0.ink, Y = '#f2ea69';
      pill(x, { x: a + 4, y: b + 19, w: 47, h: 40 }, F);
      pill(x, { x: a + 7, y: b + 22, w: 41, h: 34 }, Y);
      pill(x, { x: a + 34, y: b - 2, w: 15, h: 30 }, F);                          // thumb
      pill(x, { x: a + 37, y: b + 1, w: 9, h: 26 }, Y);
      px(a + 12, b + 32, 30, 2, 'rgba(0,0,0,.3)'); px(a + 12, b + 42, 30, 2, 'rgba(0,0,0,.3)'); // knuckle lines
    },
    greyblock(a, b) { px(a, b, 21, 21, '#3c3c3c'); px(a + 2, b + 2, 17, 17, Z0.grey); },
    doorwhite(a, b) { px(a, b, 20, 63, Z0.ink); px(a + 3, b + 3, 14, 57, Z0.white); },
    doordark0(a, b) { px(a, b, 39, 66, '#8f8f85'); px(a + 5, b + 5, 29, 61, '#141410'); px(a + 12, b + 12, 15, 3, '#8f8f85'); },
    mitrenw(a, b, w, h) { const L = h || 60; for (let i = 0; i < L; i += 2) px(a + i, b + i, 3, 3, Z0.ink); },   // frame joint ↘
    mitrene(a, b, w, h) { const L = h || 60; for (let i = 0; i < L; i += 2) px(a + L - i, b + i, 3, 3, Z0.ink); }, // frame joint ↙
    steps0(a, b) {
      // The small stacked-steps glyph that marks Zone 0's stairways.
      box(a, b + 18, 13, 13, Z0.top); box(a + 9, b + 9, 13, 13, Z0.top); box(a + 18, b, 13, 13, Z0.top);
    },
    pit0(a, b, w = 90, h = 60) {
      px(a, b, w, h, '#33332c');
      px(a + 4, b + 4, w - 8, h - 8, '#77776b');
      px(a + 10, b + 10, w - 20, h - 20, '#55554b');
    },
    digit0(a, b, w, h, p) {
      x.fillStyle = Z0.ink;
      x.font = 'bold 26px monospace';
      x.textBaseline = 'top';
      x.fillText((p && p.text) || '?', a, b);
    },
    swan0(a, b) {
      // The swan of Zone 0, in silhouette: body, wing, tail, S-neck, head, beak.
      const D = Z0.deep;
      pill(x, { x: a + 14, y: b + 62, w: 102, h: 46 }, D);          // body
      pill(x, { x: a + 44, y: b + 50, w: 62, h: 34 }, D);           // wing
      pill(x, { x: a + 96, y: b + 44, w: 30, h: 38 }, D);           // tail rise
      px(a + 116, b + 40, 12, 22, D);                               // tail tip
      pill(x, { x: a + 30, y: b + 30, w: 16, h: 48 }, D);           // neck lower
      pill(x, { x: a + 26, y: b + 12, w: 16, h: 34 }, D);           // neck upper
      pill(x, { x: a + 18, y: b + 4, w: 30, h: 20 }, D);            // head
      px(a + 4, b + 8, 18, 9, D);                                   // beak
    },
  };
  if (room.bg === 'squiggle0') {
    // The Nothingness, in pen: rows of hand-drawn zigzag on pale paper.
    const W = room.w || 384, H = room.h || 288;
    px(0, 0, W, H, Z0.paper);
    x.strokeStyle = Z0.squig; x.lineWidth = 1.5;
    for (let y = 5; y < H; y += 8) {
      x.beginPath();
      const off = (y / 8) % 2 ? 6 : 0;
      for (let a = -12; a <= W + 12; a += 12) {
        const yy = y + (((a + off) / 12) % 2 ? 3 : 0);
        a === -12 ? x.moveTo(a, yy) : x.lineTo(a, yy);
      }
      x.stroke();
    }
  } else if (room.bg === 'black0') {
    px(0, 0, room.w || 384, room.h || 288, '#000');   // interiors float in the dark
  } else {
    x.fillStyle = pal.base;
    x.fillRect(0, 0, room.w || 384, room.h || 288);
  }
  for (const f of room.floors || []) (FLOORS[f.p] || FLOORS.plain)(f);
  for (const s of room.structs || []) (STRUCT[s.t] || STRUCT.wall)(s);
  for (const p of room.props || []) {
    if (PROPS[p.t]) PROPS[p.t](p.x, p.y, p.w, p.h, p);
    else { // missing prop renders its footprint with a label — never blocks
      x.strokeStyle = '#000'; x.strokeRect(p.x, p.y, 24, 24);
      x.fillStyle = '#000'; x.font = '8px monospace'; x.fillText(p.t, p.x + 1, p.y + 12);
    }
  }
}

