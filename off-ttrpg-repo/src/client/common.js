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

// 3×4 RPG Maker convention: draw the down-facing idle frame (row 0, column 1).
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
    x.drawImage(img, cw, 0, cw, ch, 0, 0, cw, ch);
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
  musicEl.play().catch(() => {});   // missing track plays silence — never blocks
}

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
  wrap.appendChild(input);
  return wrap;
}

// Re-scan the hot folders without a page reload: new art and tracks appear,
// name-matched, nothing manual.
export async function rescanAssets() {
  App.art = await (await fetch('/api/art')).json();
  return App.art;
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
