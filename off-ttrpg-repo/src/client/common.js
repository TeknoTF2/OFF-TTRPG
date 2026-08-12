// Shared client runtime: connection (with seat-restoring reconnect), state store,
// static data, art resolution (missing art never blocks), audio, palette theming.

export const App = {
  seat: null, ws: null, view: null, art: null, staticData: null,
  onState: () => {}, onEvent: () => {}, onJoined: () => {},
};

export function connect(seat) {
  App.seat = seat;
  localStorage.setItem('off-seat', seat);
  // Optional shared key for public hosting: ?key=... is remembered per browser.
  const urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) localStorage.setItem('off-key', urlKey);
  const key = localStorage.getItem('off-key') || undefined;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  App.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', seat, key }));
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'joined') { App.art = msg.art; App.onJoined(msg); }
    if (msg.t === 'state') { App.view = msg.view; App.onState(msg.view); }
    if (msg.t === 'ev') for (const e of msg.events) handleCommonEvent(e);
  };
  ws.onclose = ev => {
    if (ev.code === 4000) { document.body.innerHTML = '<div style="padding:40px;font-family:var(--disp);font-size:30px">SEAT TAKEN OVER ELSEWHERE.</div>'; return; }
    setTimeout(() => connect(seat), 1200);   // refresh-proof: rejoin the seat exactly
  };
}

export function send(msg) { if (App.ws && App.ws.readyState === 1) App.ws.send(JSON.stringify(msg)); }
export function gm(op, extra = {}) { send({ t: 'gm', op, ...extra }); }

export async function loadStaticData() {
  App.staticData = await (await fetch('/api/static-data')).json();
  return App.staticData;
}

function handleCommonEvent(e) {
  if (e.kind === 'stinger' && e.file) playStinger(e.file);
  if (e.kind === 'scene-effect') runEffect(e.effect, e.duration);
  App.onEvent(e);
}

// ---------- palette theming (chrome themes from off-palettes.json sampled values)
export function applyPalette(name) {
  const pals = App.staticData ? App.staticData.palettes : null;
  const p = pals && pals[name];
  if (!p) return;
  const r = document.documentElement.style;
  r.setProperty('--field', p.base);
  r.setProperty('--field-dk', shade(p.base, .62));
  r.setProperty('--tint', p.pale);
  r.setProperty('--pale', p.tint);
}

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = v => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0')}`;
}

// Zone identity colors (combat mockup): flat zone-color field per zone.
export const ZONES = {
  'Canon': { field: '#3a3a33', dk: '#23231e', tint: '#a8a48e', title: 'OFF', sub: '—' },
  'Zone 1': { field: '#2e6d9e', dk: '#1d4b70', tint: '#7fa8c6', title: 'ZONE 1 — PENTEL', sub: 'smoke mines · alma damien shachihata' },
  'Zone 2': { field: '#c8871c', dk: '#8a5c10', tint: '#e0b56a', title: 'ZONE 2 — BISMARK', sub: 'the library · gomez galleries' },
  'Zone 3': { field: '#2f9e44', dk: '#1d6b2d', tint: '#7fc68f', title: 'ZONE 3 — VESPER', sub: 'the sugar works' },
  'The Room': { field: '#d0231f', dk: '#8f1512', tint: '#e07f7c', title: 'THE ROOM', sub: '—' },
  'Purified': { field: '#e8e8e4', dk: '#aaaaaa', tint: '#c9c9c4', title: 'PURIFIED', sub: 'the white' },
};

export function applyZone(zone) {
  const z = ZONES[zone] || ZONES['Zone 1'];
  const r = document.documentElement.style;
  r.setProperty('--field', z.field);
  r.setProperty('--field-dk', z.dk);
  r.setProperty('--tint', z.tint);
  return z;
}

// ---------- art
export function partyArt(klass) { return (App.art && App.art.party[klass]) || {}; }
export function enemyArt(template) { return (App.art && App.art.enemies[template]) || {}; }

// A room image from assets/rooms/, matched by filename = room name. When one
// exists it IS the room's look; the room's shapes become invisible collision.
export function roomArt(name) {
  const list = (App.art && App.art.tree && App.art.tree.rooms) || [];
  const n = String(name || '').toLowerCase().trim();
  for (const f of list) {
    const base = f.split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase().trim();
    if (base === n) return f;
  }
  return null;
}

// Render an element that shows the portrait if present, else the sprite frame,
// else a named grey silhouette. Returns an HTMLElement.
export function artEl(art, name, h = 84) {
  if (art && art.portrait) {
    const img = document.createElement('img');
    img.src = `/assets/${art.portrait}`;
    img.style.cssText = `height:${h}px;image-rendering:pixelated;filter:drop-shadow(0 8px 0 rgba(0,0,0,.25))`;
    img.alt = name;
    return img;
  }
  if (art && art.sprite) return spriteFrameEl(art.sprite, h);
  const d = document.createElement('div');
  d.className = 'silhouette';
  d.style.cssText = `width:${Math.round(h * .66)}px;height:${h}px;font-size:11px;overflow:hidden;text-align:center`;
  d.textContent = name;
  return d;
}

// 3×4 sheet, rows top-to-bottom: up, right, down, left. Draw the down-facing
// idle frame (row 2, column 1).
export function spriteFrameEl(spritePath, h = 84) {
  const canvas = document.createElement('canvas');
  const img = new Image();
  img.onload = () => {
    const cw = Math.floor(img.width / 3), ch = Math.floor(img.height / 4);
    canvas.width = cw; canvas.height = ch;
    canvas.style.height = `${h}px`;
    canvas.style.width = `${Math.round(h * cw / ch)}px`;
    canvas.style.imageRendering = 'pixelated';
    const x = canvas.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage(img, cw, ch * 2, cw, ch, 0, 0, cw, ch);
  };
  img.src = `/assets/${spritePath}`;
  canvas.style.height = `${h}px`;
  return canvas;
}

// ---------- audio
// Volume is per client, never shared: each seat sets its own and it persists
// in this browser only.
let musicEl = null, currentTrack = null, queueLen = 0;
export function getVolume() {
  const v = parseFloat(localStorage.getItem('off-vol'));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
}
export function setVolume(v) {
  localStorage.setItem('off-vol', String(Math.min(1, Math.max(0, v))));
  if (musicEl) musicEl.volume = getVolume();
  // Keep every mounted slider in agreement (top bar + in-scene).
  window.dispatchEvent(new CustomEvent('off-volume'));
}

function ensureMusicEl() {
  if (musicEl) return musicEl;
  musicEl = new Audio();
  musicEl.volume = getVolume();
  musicEl.addEventListener('ended', () => {
    // The GM's client is the jukebox's timekeeper: when a track ends with a
    // queue waiting, it advances everyone. Players just receive the new track.
    if (App.seat === 'GM' && queueLen > 0) gm('jukebox-skip');
    else if (currentTrack) { musicEl.currentTime = 0; musicEl.play().catch(() => {}); }
  });
  return musicEl;
}

export function syncJukebox(jb) {
  if (!jb || !jb.playing || !jb.track) {
    if (musicEl) { musicEl.pause(); currentTrack = null; }
    return;
  }
  queueLen = (jb.queue || []).length;
  ensureMusicEl();
  // 'ended' handles everything: the GM's client advances the queue when one is
  // waiting; otherwise the track restarts — looping by default, playing through
  // a queue when there is one.
  musicEl.loop = false;
  if (jb.track === currentTrack) return;
  currentTrack = jb.track;
  musicEl.src = `/assets/${encodeURIComponent(jb.track).replace(/%2F/g, '/')}`;
  musicEl.volume = getVolume();
  if (!previewFile) musicEl.play().catch(() => {});   // a live preview keeps its duck
}

// ---------- GM-side track preview
// Plays on this client ONLY — the table's jukebox is untouched. While a
// preview runs, the shared track is paused locally (ducked) and resumes when
// the preview stops. Calling with the previewing file toggles it off.
let previewEl = null, previewFile = null;
export function previewTrack(file) {
  if (previewFile === file) { stopPreview(); return; }
  ensureMusicEl();
  musicEl.pause();
  if (!previewEl) {
    previewEl = new Audio();
    previewEl.addEventListener('ended', () => stopPreview());
    window.addEventListener('off-volume', () => { if (previewEl) previewEl.volume = getVolume(); });
  }
  previewFile = file;
  previewEl.src = `/assets/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
  previewEl.volume = getVolume();
  previewEl.play().catch(() => {});
}
export function stopPreview() {
  if (!previewFile) return;
  previewFile = null;
  if (previewEl) previewEl.pause();
  if (musicEl && currentTrack) musicEl.play().catch(() => {});   // un-duck the table's track
}
export function previewingTrack() { return previewFile; }

export function playStinger(file) {
  const a = new Audio(`/assets/${encodeURIComponent(file).replace(/%2F/g, '/')}`);
  a.volume = getVolume();
  a.play().catch(() => {});
}

// A small volume slider, mountable in any top bar.
export function volumeSlider() {
  const wrap = el('span', { style: 'display:inline-flex;align-items:center;gap:6px;padding:0 10px' },
    el('span', { style: 'font-size:14px;color:#bbb' }, '♪'));
  const input = el('input', {
    type: 'range', min: '0', max: '100', value: String(Math.round(getVolume() * 100)),
    style: 'width:90px;accent-color:var(--amber);cursor:pointer',
    title: 'your music volume (only yours)',
  });
  input.oninput = () => setVolume(input.value / 100);
  window.addEventListener('off-volume', () => { input.value = String(Math.round(getVolume() * 100)); });
  wrap.appendChild(input);
  return wrap;
}

// Re-scan the hot folders without a page reload: new art and tracks appear,
// name-matched, nothing manual.
export async function rescanAssets() {
  App.art = await (await fetch('/api/art')).json();
  return App.art;
}

// ---------- canon (imported) rooms
// tilemap.json is a neutral render recipe: per cell either [sx,sy] (one 16×16
// blit) or eight numbers (four 8×8 quadrant blits) — autotile shapes were
// resolved at import, so any chipset PNG paints any map. Composed once per
// (map, chipset) into two canvases: ground, and the above-hero overlay that
// draws over sprites. Rendering is async; callers redraw when ready.
const canonCanvases = new Map();
export function canonRoom(mapKey, chipset, onReady = () => {}) {
  const key = `${mapKey}|${chipset}`;
  if (canonCanvases.has(key)) return canonCanvases.get(key);
  const entry = { ready: false, ground: null, overlay: null, w: 0, h: 0, evc: [], chip: null };
  canonCanvases.set(key, entry);
  (async () => {
    try {
      const tm = await (await fetch(`/api/canon/${mapKey}/tilemap.json`)).json();
      const raw = new Image();
      raw.src = `/assets/level creation/chipset/${encodeURIComponent(chipset)}`;
      await raw.decode();
      // RM2k chipsets key transparency to a palette color, stored literally in
      // the PNG. The blank upper tile (F0) is pure key — sample it and knock
      // that exact color out, or every overlay tile carries its backing color.
      const kc = document.createElement('canvas');
      kc.width = raw.width; kc.height = raw.height;
      const kx = kc.getContext('2d');
      kx.drawImage(raw, 0, 0);
      const idat = kx.getImageData(0, 0, kc.width, kc.height);
      const d = idat.data;
      const ki = (128 + 8) * kc.width * 4 + (288 + 8) * 4;   // center of blank F0
      const kr = d[ki], kg = d[ki + 1], kb = d[ki + 2];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === kr && d[i + 1] === kg && d[i + 2] === kb) d[i + 3] = 0;
      }
      kx.putImageData(idat, 0, 0);
      const img = kc;
      entry.w = tm.w * 16; entry.h = tm.h * 16;
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = entry.w; c.height = entry.h;
        const x = c.getContext('2d');
        x.imageSmoothingEnabled = false;
        return [c, x];
      };
      const [g, gx] = mk(), [o, ox] = mk();
      // Panorama (if the map declares one and the file has been dropped into
      // the hot folder) tiles behind everything; keyed cells show through.
      if (tm.pano) {
        try {
          const pano = new Image();
          pano.src = `/assets/level creation/Panorama/${encodeURIComponent(tm.pano)}.png`;
          await pano.decode();
          for (let py = 0; py < entry.h; py += pano.height) {
            for (let px2 = 0; px2 < entry.w; px2 += pano.width) gx.drawImage(pano, px2, py);
          }
        } catch { /* not uploaded yet — keyed cells show black */ }
      }
      const blit = (x, cell, dx, dy) => {
        if (cell.length <= 3) { x.drawImage(img, cell[0], cell[1], 16, 16, dx, dy, 16, 16); return; }
        for (let q = 0; q < 4; q++) x.drawImage(img, cell[q * 2], cell[q * 2 + 1], 8, 8, dx + (q % 2) * 8, dy + Math.floor(q / 2) * 8, 8, 8);
      };
      for (let y = 0; y < tm.h; y++) for (let cx = 0; cx < tm.w; cx++) {
        const lc = tm.lower[y][cx];
        if (lc) blit(gx, lc, cx * 16, y * 16);
        const uc = tm.upper[y][cx];
        if (uc) blit(uc.length === 3 ? ox : gx, uc.length === 3 ? uc.slice(0, 2) : uc, cx * 16, y * 16);
      }
      // static scenery baked from tile-graphic events (ladders, doors, signs)
      for (const e of tm.ev || []) {
        blit(e.c.length === 3 ? ox : gx, e.c.length === 3 ? e.c.slice(0, 2) : e.c, e.x * 16, e.y * 16);
      }
      entry.ground = g; entry.overlay = o; entry.ready = true;
      entry.evc = tm.evc || [];   // conditioned scenery — drawn live, not baked
      entry.chip = img;
      onReady();
    } catch { /* missing map/chipset renders black — never blocks */ }
  })();
  return entry;
}

// Conditioned scenery (hidden doors, chapter changes): tiles the game gates
// behind a switch/item, drawn only when the GM has toggled their group on.
// layer 'ground' draws under sprites, 'above' over them. ghostInactive shows
// the off groups faintly — the GM's x-ray; players never pass it.
// Overworld nametag: clean bold monospace on a dark plate, centered under the
// sprite — readable on any map. cx = sprite center x, y = label baseline.
export function owLabel(x, text, cx, y, accent = false) {
  const t = String(text || '').slice(0, 12).toUpperCase();
  if (!t) return;
  x.font = 'bold 8px ui-monospace, Menlo, Consolas, monospace';
  const w = Math.ceil(x.measureText(t).width);
  x.fillStyle = 'rgba(0,0,0,.72)';
  x.fillRect(cx - w / 2 - 3, y - 8, w + 6, 11);
  x.fillStyle = accent ? '#f2a71b' : '#ffffff';
  x.fillText(t, cx - w / 2, y);
}

export function drawCanonCond(x, entry, condOn, layer = 'all', ghostInactive = false) {
  if (!entry.ready || !entry.evc.length) return;
  for (const e of entry.evc) {
    const above = e.c.length === 3;
    if (layer === 'ground' ? above : layer === 'above' ? !above : false) continue;
    const on = !!(condOn && condOn[e.cond]);
    if (!on && !ghostInactive) continue;
    x.globalAlpha = on ? 1 : 0.35;
    x.drawImage(entry.chip, e.c[0], e.c[1], 16, 16, e.x * 16, e.y * 16, 16, 16);
  }
  x.globalAlpha = 1;
}

// ---------- combat action FX
// One 'combat-fx' event = one action, animated the same on every screen:
//   melee — the attacker's sprite rushes the target, a flash, and returns
//   ranged — a white crosshair marks the target
//   heal — the healer visits the teammate with a green flash
//   item — a soft flash on the target
// Flashes and crosshairs live in fixed coordinates so re-renders can't kill
// them; callers should hold field rebuilds for the returned duration.
export function playCombatFx(e, scopeSel = '') {
  const pick = id => (scopeSel && document.querySelector(`${scopeSel} [data-id="${id}"]`)) || document.querySelector(`[data-id="${id}"]`);
  const actor = pick(e.actorId);
  const targets = (e.targets || []).map(pick).filter(Boolean);
  const t0 = targets[0];
  if (e.style === 'ranged') {
    for (const t of targets) crosshairOver(t);
    return 520;
  }
  if (e.style === 'item') {
    for (const t of targets) flashOver(t, 'item');
    return 420;
  }
  if ((e.style === 'melee' || e.style === 'heal') && actor && t0 && actor !== t0) {
    const a = actor.getBoundingClientRect(), b = t0.getBoundingClientRect();
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const prevZ = actor.style.zIndex;
    actor.style.transition = 'transform .22s ease-in';
    actor.style.zIndex = 40;
    actor.style.transform = `translate(${Math.round(dx * 0.8)}px, ${Math.round(dy * 0.8)}px)`;
    setTimeout(() => {
      for (const t of targets) flashOver(t, e.style === 'heal' ? 'heal' : 'hit');
      actor.style.transition = 'transform .22s ease-out';
      actor.style.transform = '';
      setTimeout(() => { actor.style.transition = ''; actor.style.zIndex = prevZ; }, 260);
    }, 230);
    return 560;
  }
  // no travel possible (self-target, missing node): flash what we have
  for (const t of (targets.length ? targets : actor ? [actor] : [])) {
    flashOver(t, e.style === 'heal' ? 'heal' : 'hit');
  }
  return 420;
}

// The classic RPG hit blink: the sprite's own pixels flash, twice — no
// rectangle overlay washing the artwork grey.
const FLASH_FILTERS = {
  hit: 'brightness(2.6) contrast(1.15)',
  heal: 'brightness(1.7) sepia(1) hue-rotate(70deg) saturate(3.5)',
  item: 'brightness(1.9)',
};
function flashOver(t, kind) {
  const f = FLASH_FILTERS[kind] || FLASH_FILTERS.hit;
  const prev = t.style.filter;
  t.style.filter = f;
  setTimeout(() => { t.style.filter = prev; }, 130);
  setTimeout(() => { t.style.filter = f; }, 240);
  setTimeout(() => { t.style.filter = prev; }, 370);
}

function crosshairOver(t) {
  const r = t.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = Math.max(20, Math.min(r.width, r.height) * 0.45);
  const c = el('div', {
    style: `position:fixed;left:${cx - R}px;top:${cy - R}px;width:${R * 2}px;height:${R * 2}px;pointer-events:none;z-index:60;`
      + 'transition:opacity .25s;opacity:1',
    html: `<svg width="${R * 2}" height="${R * 2}" viewBox="0 0 100 100">`
      + '<circle cx="50" cy="50" r="34" fill="none" stroke="#fff" stroke-width="6"/>'
      + '<line x1="50" y1="0" x2="50" y2="26" stroke="#fff" stroke-width="6"/>'
      + '<line x1="50" y1="74" x2="50" y2="100" stroke="#fff" stroke-width="6"/>'
      + '<line x1="0" y1="50" x2="26" y2="50" stroke="#fff" stroke-width="6"/>'
      + '<line x1="74" y1="50" x2="100" y2="50" stroke="#fff" stroke-width="6"/>'
      + '<circle cx="50" cy="50" r="5" fill="#fff"/></svg>',
  });
  document.body.appendChild(c);
  setTimeout(() => { c.style.opacity = '0'; }, 320);
  setTimeout(() => c.remove(), 600);
}

// ---------- effects (components of scenes)
export function runEffect(effect, duration = 1200) {
  const el = document.getElementById('fxOverlay');
  if (!el) return;
  if (effect === 'inversion') {
    document.body.classList.add('inverted');
    setTimeout(() => document.body.classList.remove('inverted'), duration);
    return;
  }
  el.className = effect;   // static | whiteout
  setTimeout(() => { el.className = ''; }, duration);
}

// ---------- misc
export function el(tag, attrs = {}, ...children) {
  const d = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;   // absent attribute, not the string "undefined"
    if (k === 'class') d.className = v;
    else if (k === 'style') d.style.cssText = v;
    else if (k.startsWith('on')) d[k] = v;
    else if (k === 'html') d.innerHTML = v;
    else d.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    d.append(c.nodeType ? c : document.createTextNode(c));
  }
  return d;
}

export function statusChip(s) {
  const abbr = { Poisoned: 'PSN', Blinded: 'BLI', Muted: 'MUT', Palsied: 'PAL', Asleep: 'SLP', Furious: 'FUR', Madness: 'MAD', Hasty: 'HST', Taunted: 'TNT', Thorns: 'THO', Famine: 'FAM', Impure: 'IMP', Vilified: 'VIL', Corrupted: 'COR', Defamed: 'DFM' };
  return el('span', { class: 'icn', title: `${s.name} — turn ${s.turns} afflicted` }, `${abbr[s.name] || s.name.slice(0, 3).toUpperCase()}·t${s.turns}`);
}

export function statChangeChip(sc) {
  const arrow = sc.dir === 'up' ? '▲' : '▼';
  const val = sc.stat === 'DEF' ? (sc.dir === 'up' ? '+' : '−') + sc.amount : sc.amount + '%';
  return el('span', { class: 'icn ' + (sc.dir === 'up' ? 'up' : 'down'), title: `${sc.stat} ${sc.dir} ${val}, ${sc.turnsLeft} turns` },
    el('b', {}, arrow), `${sc.stat}·${sc.turnsLeft}t`);
}

export function floatOver(container, text, style) {
  const f = el('div', { class: `float ${style} show` }, text);
  container.appendChild(f);
  setTimeout(() => f.remove(), 1100);
}
