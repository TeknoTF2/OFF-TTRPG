// OFF TTRPG server — seven seats, server-authoritative, all truth lives here.
// Clients render and request. Player-side messages are validated to legality;
// GM-side operations are never restricted.

import http from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadAll, REPO_ROOT, ASSETS_DIR } from './dataload.js';
import { Store, newCampaign } from './state.js';
import { Battle } from './engine/battle.js';
import { SceneRun } from './scenes.js';
import { memberBase, gearEffects, validateEquip, findGearItem, statsAt } from './engine/members.js';
import { currentElement } from './engine/formulas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(here, '..', 'client');
// Railway: mount a volume and campaign state survives redeploys; falls back to
// a local var/ dir for development.
const VAR_DIR = process.env.DATA_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'off-var') : path.join(here, 'var'));
mkdirSync(VAR_DIR, { recursive: true });

// Optional shared key for public hosting: set ACCESS_KEY and clients must
// present it to claim a seat. Left unset, seats are open (private table).
const ACCESS_KEY = process.env.ACCESS_KEY || null;

let data = loadAll();
const store = new Store(data, VAR_DIR);
const introScene = JSON.parse(readFileSync(path.join(here, 'data', 'intro-scene.json'), 'utf8'));
const zone0Room = JSON.parse(readFileSync(path.join(here, 'data', 'zone0-room.json'), 'utf8'));
const zone0Interiors = JSON.parse(readFileSync(path.join(here, 'data', 'zone0-interiors.json'), 'utf8'));

const PORT = process.env.PORT || 8420;
const seats = new Map();       // seat -> ws
let battle = null;
let sceneRun = null;
let eventQueue = [];
let stateDirtyView = true;

const ZONE_PRICE_MULT = { 'Zone 1': 1, 'Zone 2': 1, 'Zone 3': 1.5, 'The Room': 2, 'Purified': 2 };

// ---------------------------------------------------------------- utilities
function campaign() {
  const c = store.campaign;
  c.musicZones = c.musicZones || {};
  c.sceneMusic = c.sceneMusic || {};
  // Built-in authored rooms ride along with every campaign (theirs to edit).
  // A version bump replaces stale copies (e.g. kit-drawn → real art + collision).
  const BUILTIN_VER = 2;
  c.rooms = c.rooms || {};
  c.notes = c.notes || {};
  for (const [name, room] of [['Zone 0', zone0Room], ...Object.entries(zone0Interiors)]) {
    if (!c.rooms[name] || (+c.notes[`builtinver:${name}`] || 0) < BUILTIN_VER) {
      c.rooms[name] = JSON.parse(JSON.stringify(room));
      c.notes[`builtinver:${name}`] = String(BUILTIN_VER);
    }
    if (!c.notes[`roomzone:${name}`]) c.notes[`roomzone:${name}`] = 'Zone 0';
  }
  return c;
}
function emit(ev) { eventQueue.push(ev); }

// Combat sounds resolve to whatever stinger file matches by name (hot folder:
// missing files just stay silent). Multi-candidate sounds pick uniformly, and
// the pick happens here so every client hears the same file.
const FX_SOUNDS = {
  strike: ['strike01', 'strike02', 'strike05'],
  zap: ['attack2', 'bolt03'],
  heal: ['revive3'],
  item: ['item1'],
};
function fxStinger(sound) {
  const cands = FX_SOUNDS[sound] || [];
  const files = assetTree().stingers;
  const hits = [];
  for (const cand of cands) {
    const f = files.find(f2 => path.basename(f2).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '').endsWith(cand));
    if (f) hits.push(f);
  }
  return hits.length ? hits[Math.floor(Math.random() * hits.length)] : null;
}
function emitBattleFx(ev) {
  emit(ev);
  if (ev.kind === 'combat-fx' && ev.sound) {
    const f = fxStinger(ev.sound);
    if (f) emit({ kind: 'stinger', file: f });
  }
}
function touch() { store.markDirty(); stateDirtyView = true; }

function logCombat(entry) {
  const logs = campaign().log;
  if (!logs.length || logs[logs.length - 1].closed) return;
  logs[logs.length - 1].entries.push(entry);
}

function startCombatLog(name) {
  campaign().log.push({ id: campaign().log.length, name, startedAt: new Date().toISOString(), entries: [], closed: false });
}

function currentRoom() {
  return campaign().rooms[campaign().location.name] || null;
}

// Restore the active scene / battle links after load
function rebuildSceneRun() {
  const c = campaign();
  if (c.scene && !c.scene.done) {
    const def = c.scenes[c.scene.sceneId] || (c.scene.sceneId === 'intro' ? introScene : null);
    if (def) {
      sceneRun = new SceneRun(data, c, def, { emit });
      sceneRun.state = c.scene;
    }
  }
}
rebuildSceneRun();

// ---------------------------------------------------------------- asset tree
const norm = s => s.toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9一-鿿]+/g, '').replace(/\d+$/, '');
const spellings = s => [s, s.replace(/spectre/g, 'specter'), s.replace(/specter/g, 'spectre')];

function walkAssets(dir, rel = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    const r = rel ? `${rel}/${f}` : f;
    try {
      if (statSync(p).isDirectory()) out.push(...walkAssets(p, r));
      else out.push(r);
    } catch { /* ignore */ }
  }
  return out;
}

function assetTree() {
  const all = walkAssets(ASSETS_DIR);
  const tree = { music: {}, stingers: [], sprites: { party: [], enemies: [], npcs: [] }, backdrops: [], rooms: [], portraits: { Party: [], Enemies: [], Bosses: [] }, props: [], fonts: [] };
  for (const f of all) {
    const parts = f.split('/');
    const top = parts[0].toLowerCase();
    if (top === 'music' && parts.length >= 2 && /\.(mp3|ogg|wav|m4a|flac|opus)$/i.test(f)) {
      const zone = parts.length > 2 ? parts[1] : '(root)';
      (tree.music[zone] = tree.music[zone] || []).push(f);
    } else if (top === 'stingers') tree.stingers.push(f);
    else if (top === 'sprites') {
      const cat = (parts[1] || '').toLowerCase();
      if (tree.sprites[cat]) tree.sprites[cat].push(f);
    } else if (top === 'backdrops') tree.backdrops.push(f);
    else if (top === 'rooms' && /\.(png|webp|gif|jpg|jpeg)$/i.test(f)) tree.rooms.push(f);
    else if (top === 'portraits') {
      const cat = parts[1];
      if (tree.portraits[cat]) tree.portraits[cat].push(f);
    } else if (top === 'props') tree.props.push(f);
    else if (top === 'fonts' && f.endsWith('.otf')) tree.fonts.push(f);
  }
  return tree;
}

// Filename is display name; matching is normalization only (plus the one
// spectre/specter spelling bridge the real files need). Misses render as
// named silhouettes — missing art never blocks.
function findArt(list, name) {
  const targets = new Set(spellings(norm(name)));
  for (const f of list) {
    const base = path.basename(f);
    if (spellings(norm(base)).some(x => targets.has(x))) return f;
  }
  return null;
}

// ---------------------------------------------------------------- views
function enemyPublicView(e) {
  const revealed = battle && battle.revealed.has(e.id);
  const v = {
    id: e.id, name: e.name, slot: e.slot, dead: e.dead,
    statuses: e.statuses.map(s => ({ name: s.name, turns: s.turnsAfflicted ?? 0 })),
    statChanges: e.statChanges.map(sc => ({ stat: sc.stat, dir: sc.dir, amount: sc.amount, turnsLeft: sc.turnsLeft })),
    elementSet: e.elementSet ? e.elementSet.element : null,
    sprite: e.sprite, portrait: e.portrait, template: e.template,
    size: e.size || 1,
    revealed,
  };
  if (revealed) {
    v.element = currentElement(e);
    v.hp = e.hp; v.maxHp = e.maxHp;
    v.def = e.def; v.res = e.res; v.lck = e.lck;
    v.tiers = e.statusTiers;
    v.gaugeS = e.gaugeS;
  }
  return v;
}

function enemyGmView(e) {
  return {
    ...enemyPublicView(e),
    element: currentElement(e), nativeElement: e.element,
    hp: e.hp, maxHp: e.maxHp, def: e.def, res: e.res, lck: e.lck,
    tiers: e.statusTiers, gauge: e.gauge, gaugeS: e.gaugeS, dpa: e.dpa,
    holding: e.holding, critCharged: e.critCharged, control: e.control,
    cp: e.cp, moves: e.moves, drop: e.drop, wave: e.wave, defending: e.defending,
    revealed: battle ? battle.revealed.has(e.id) : false,
    form: e.form || null,
    watch: e.watch || null,
    prompts: battle && !e.dead
      ? battle.allTriggers(e).filter(t => !battle.triggerSpent(e, t))
          .map(t => ({ id: t.id, label: t.label, ready: battle.triggerReady(e, t) }))
      : [],
  };
}

function memberView(m, { self = false } = {}) {
  const base = memberBase(data, m);
  const v = {
    id: m.id, klass: m.klass, name: m.name, level: m.level, down: m.down, benched: !!m.benched,
    hp: m.hp, cp: m.cp, maxHp: base.hp, maxCp: base.cp,
    element: currentElement(m), nativeElement: m.element,
    elementSet: m.elementSet ? m.elementSet.element : null,
    gauge: m.gauge, holding: m.holding, critCharged: m.critCharged, defending: m.defending,
    gaugeSeconds: battle ? battle.gaugeSeconds(m) : Math.max(1, 40 / base.agi),
    statuses: m.statuses.map(s => ({ name: s.name, turns: s.turnsAfflicted ?? 0 })),
    statChanges: m.statChanges.map(sc => ({ stat: sc.stat, dir: sc.dir, amount: sc.amount, turnsLeft: sc.turnsLeft })),
    gender: m.gender, flavor: m.flavor,
  };
  if (self) {
    v.stats = base;
    v.equipment = m.equipment;
    v.orbs = m.orbs || {};
    const gfx = gearEffects(data, m);
    const kit = data.classKits.classes[m.klass];
    v.competences = kit.competences.map(c => ({
      name: c.name, level: c.level, cp: Math.round(c.cp * gfx.cp_cost_mult),
      target: (data.riders[m.klass][c.name].targetOverride || c.target),
      element: c.element, accuracy: c.accuracy, effect: c.effect,
      unlocked: c.level <= m.level,
      kind: data.riders[m.klass][c.name].kind,
      choosesElement: (data.riders[m.klass][c.name].effects || []).some(e => e.type === 'elementSet' && e.element === 'choose'),
    }));
    v.passives = kit.passives.map(p => ({ ...p, active: m.level >= p.level }));
  }
  return v;
}

function roomViewFor(room, gm) {
  if (!room) return null;
  return {
    ...room,
    pieces: (room.pieces || []).filter(p => gm || !p.hidden),
  };
}

function battleViewFor(seat) {
  if (!battle) return null;
  const gm = seat === 'GM';
  return {
    over: battle.over, frozen: battle.frozen, victory: battle.victory,
    partySlots: battle.partySlots,
    backdrop: battle.encounter.backdrop || null,
    palette: battle.encounter.palette || null,
    enemies: battle.enemies.map(e => gm ? enemyGmView(e) : enemyPublicView(e)),
    pool: gm ? battle.pool : undefined,
    waves: gm ? battle.encounter.waves.map((w, i) => ({ index: i, spawned: !!w.spawned, trigger: w.trigger || 'prev-death', count: w.queue.length })) : undefined,
  };
}

function viewFor(seat) {
  const c = campaign();
  const gm = seat === 'GM';
  const me = c.party.find(m => m.id === seat);
  const view = {
    seat, mode: c.mode, paused: c.paused, location: c.location,
    credits: c.credits, inventory: c.inventory,
    party: c.party.map(m => memberView(m, { self: gm || m.id === seat })),
    positions: c.positions || {},
    room: roomViewFor(currentRoom(), gm),
    battle: battleViewFor(seat),
    shop: c.shop ? shopViewFor(seat) : null,
    gearOwned: c.gearOwned || {},
    wornBy: (() => {
      const w = {};
      for (const m of c.party) for (const s of Object.keys(m.equipment)) if (m.equipment[s]) w[m.equipment[s]] = m.name;
      return w;
    })(),
    scene: sceneRun && !sceneRun.state.done ? (gm ? sceneRun.gmView([...seats.keys()]) : sceneRun.viewFor(seat)) : null,
    jukebox: { track: c.jukebox.track, playing: c.jukebox.playing, queue: gm ? c.jukebox.queue : undefined },
    connected: [...seats.keys()],   // presence: absent members simply don't render
  };
  if (gm) {
    view.templates = Object.keys(c.templates);
    view.encounters = Object.keys(c.encounters);
    view.notes = c.notes;
    view.snapshots = store.listSnapshots().slice(0, 30);
    view.undo = store.lastUndo ? store.lastUndo.desc : null;
    view.logs = c.log.map(l => ({ id: l.id, name: l.name, startedAt: l.startedAt, entries: l.entries.length }));
    view.zoneDropTables = c.zoneDropTables;
    view.rooms = Object.keys(c.rooms);
    view.scenes = ['intro', ...Object.keys(c.scenes)];
    view.musicZones = c.musicZones;
    view.sceneMusic = c.sceneMusic;
  }
  return view;
}

function shopViewFor(seat) {
  const c = campaign();
  const gm = seat === 'GM';
  const mult = ZONE_PRICE_MULT[c.location.zone] || 1;
  const rows = Object.entries(c.shop.stock).map(([name, s]) => ({
    name, on: s.on, price: s.price, desc: s.desc, category: s.category || 'item',
  }));
  return {
    open: c.shop.open,
    stock: gm ? rows : rows.filter(r => r.on),
    sellRate: 0.5, mult,
  };
}

// ---------------------------------------------------------------- broadcast
function broadcastState() {
  for (const [seat, ws] of seats) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', view: viewFor(seat) }));
  }
}

function flushEvents() {
  if (!eventQueue.length) return;
  const evs = eventQueue; eventQueue = [];
  for (const [seat, ws] of seats) {
    if (ws.readyState !== 1) continue;
    const filtered = evs.filter(e => {
      if (e.kind === 'gm-turn' || e.kind === 'gm-note') return seat === 'GM';
      if (e.kind === 'your-turn') return e.playerId === seat || seat === 'GM';
      if (e.kind === 'private') return e.seat === seat;
      if (e.kind === 'keypad-attempt') return seat === 'GM';
      return true;
    });
    if (filtered.length) ws.send(JSON.stringify({ t: 'ev', events: filtered }));
  }
  stateDirtyView = true;
}

// ---------------------------------------------------------------- battle glue
function launchEncounter(def) {
  const c = campaign();
  const enc = JSON.parse(JSON.stringify(def));
  enc.waves = enc.waves && enc.waves.length ? enc.waves : [{ trigger: 'launch', queue: [] }];
  // Cutpurse steals its bonus drops from the encounter's enemy object pool (GM ruling).
  const isBoss = enc.waves.some(w => w.queue.some(q => {
    const t = c.templates[q.template] || data.enemiesByName[q.template];
    return t && String(t.archetype || '').includes('boss');
  }));
  if (isBoss) store.snapshot(`before ${enc.name || 'boss'}`);   // auto-snapshot before every boss launch
  startCombatLog(enc.name || 'encounter');
  // Only members actually at the table launch into the fight; the GM can send
  // an absent character in from the PLAYERS tab (they arrive gauge-empty).
  // Nobody connected at all (GM prepping/testing solo) → the full un-benched party.
  const present = [...seats.keys()].filter(s => s !== 'GM');
  battle = new Battle(data, c, enc, { emit: emitBattleFx, log: logCombat, present: present.length ? present : null });
  c.mode = 'battle';
  if (enc.music) { c.jukebox.track = enc.music; c.jukebox.playing = true; }
  touch();
}

function endEncounter() {
  if (campaign().log.length) campaign().log[campaign().log.length - 1].closed = true;
  battle = null;
  campaign().mode = 'overworld';
  touch();
}

// ---------------------------------------------------------------- overworld
function walkableAt(room, x, y, inVehicle) {
  if (!room) return true;
  if (x < 0 || y < 0 || x >= (room.w || 384) || y >= (room.h || 288)) return false;
  let ok = false;
  const UNWALKABLE = { water: 1, void: 1, inkwall0: 1 };
  for (const f of room.floors || []) {
    if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) {
      let walk = !UNWALKABLE[f.p];
      if (inVehicle) walk = f.p === 'water';   // the pedalo inverts terrain walkability
      ok = walk;
    }
  }
  for (const s of room.structs || []) {
    if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) ok = false;
  }
  const SOLID = { crate: 1, barrel: 1, cabinet: 1, bottles: 1, counter: 1, plant: 1, stack: 1, lamp: 1, sign: 1, bed: 1, shelf: 1, vat: 1, rock: 1, greyblock: 1 };
  for (const p of room.props || []) {
    if (SOLID[p.t] && x >= p.x && x < p.x + (p.w || 24) && y >= p.y && y < p.y + 24) ok = false;
  }
  return ok;
}

function setLocation(zone, name) {
  const c = campaign();
  c.location = { zone, name };
  // All transitions are GM clicks; one click is one tick. Poisoned ticks 1/10 max HP and can kill.
  for (const m of c.party) {
    if (m.down || !m.statuses.some(s => s.name === 'Poisoned')) continue;
    const gfx = gearEffects(data, m);
    if (gfx.overworld_tick_immune) continue;   // Wednesday: negates the tick; the status persists
    const maxHp = memberBase(data, m).hp;
    m.hp = Math.max(0, m.hp - Math.round(maxHp / 10));
    emit({ kind: 'float', targetId: m.id, text: `${Math.round(maxHp / 10)}`, style: 'dmg' });
    if (m.hp === 0) { m.down = true; emit({ kind: 'announce', text: `${m.name} succumbs to poison!` }); }
  }
  const room = currentRoom();
  c.positions = {};
  const spawn = room && room.spawn ? room.spawn : { x: 48, y: 48 };
  c.party.forEach((m, i) => { c.positions[m.id] = { x: spawn.x + (i % 3) * 20, y: spawn.y + Math.floor(i / 3) * 20, facing: 0 }; });
  if (room && room.music) { c.jukebox.track = room.music; c.jukebox.playing = true; }
  if (c.mode !== 'battle' && c.mode !== 'shop') c.mode = 'overworld';
  emit({ kind: 'announce', text: `The party arrives: ${name}.` });
  touch();
}

// ---------------------------------------------------------------- item use (out of combat)
function outOfCombatItem(userSeat, itemName, targetSeat) {
  const c = campaign();
  if (!c.inventory[itemName] || c.inventory[itemName] <= 0) return;
  const item = data.itemsByName[itemName];
  if (!item) return;
  const target = c.party.find(m => m.id === targetSeat) || c.party.find(m => m.id === userSeat);
  const fx = item.effect;
  let used = false;
  const maxOf = m => memberBase(data, m);
  switch (fx.type) {
    case 'healHp': if (target && !target.down) { target.hp = Math.min(maxOf(target).hp, target.hp + fx.amount); used = true; } break;
    case 'healCp': if (target && !target.down) { target.cp = Math.min(maxOf(target).cp, target.cp + fx.amount); used = true; } break;
    case 'revive': if (target && target.down) { target.down = false; target.hp = Math.max(1, Math.round(maxOf(target).hp * fx.hpPct / 100)); used = true; } break;
    case 'cureStatus': if (target) used = !!target.statuses.find(s => s.name === fx.status) && (target.statuses = target.statuses.filter(s => s.name !== fx.status), true); break;
    case 'cureAllStatuses': if (target && target.statuses.length) { target.statuses = []; used = true; } break;
    case 'fullPartyRestore':
      for (const m of c.party) { m.down = false; m.hp = maxOf(m).hp; m.cp = maxOf(m).cp; m.statuses = []; }
      used = true;
      emit({ kind: 'announce', text: "Abaddon's Meat — the party is fully restored." });
      break;
    case 'orb':
      if (target) {
        target.orbs = target.orbs || {};
        target.orbs[fx.stat] = (target.orbs[fx.stat] || 0) + fx.amount;
        if (fx.stat === 'hp') target.hp += fx.amount;
        if (fx.stat === 'cp') target.cp += fx.amount;
        used = true;
        emit({ kind: 'announce', text: `${target.name} absorbs the ${itemName}.` });
      }
      break;
    default: return;
  }
  if (used) {
    c.inventory[itemName]--;
    const itemSting = fxStinger('item');
    if (itemSting) emit({ kind: 'stinger', file: itemSting });
    emit({ kind: 'announce', text: `${c.party.find(m => m.id === userSeat)?.name || userSeat} uses ${itemName}.` });
    touch();
  }
}

// ---------------------------------------------------------------- shop
function defaultStock() {
  const c = campaign();
  const mult = ZONE_PRICE_MULT[c.location.zone] || 1;
  const stock = {};
  for (const it of data.items.catalog) {
    if (it.priceZ1 == null && it.effect.type !== 'orb') continue;
    stock[it.name] = { on: false, price: it.priceZ1 != null ? Math.round(it.priceZ1 * mult) : 300, desc: it.desc, category: 'item' };
  }
  for (const [cat, def] of Object.entries(data.gear.categories)) {
    for (const g of def.items) {
      if (g.price == null) continue;
      stock[g.name] = { on: false, price: g.price, desc: `${cat} · ${g.tier} · ${g.stat ? `+${g.value} ${g.stat.toUpperCase()}` : 'effect'}`, category: 'gear' };
    }
  }
  return stock;
}

function sellPrice(name) {
  const c = campaign();
  const mult = ZONE_PRICE_MULT[c.location.zone] || 1;
  if (c.shop && c.shop.stock[name]) return Math.floor(c.shop.stock[name].price / 2);
  const it = data.itemsByName[name];
  if (it && it.priceZ1 != null) return Math.floor(it.priceZ1 * mult / 2);
  const g = findGearItem(data, name);
  if (g && g.item.price != null) return Math.floor(g.item.price / 2);
  return 0;
}

// ---------------------------------------------------------------- data reload diff (QOL 7)
function deepDiff(a, b, prefix = '', out = [], cap = 400) {
  if (out.length >= cap) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) deepDiff(a[i], b[i], `${prefix}[${i}]`, out, cap);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      deepDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, cap);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${prefix}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return out;
}

let pendingReload = null;
function computeReloadDiff() {
  const fresh = loadAll();
  const diff = [
    ...deepDiff(data.bestiary, fresh.bestiary, 'bestiary'),
    ...deepDiff(data.classKits, fresh.classKits, 'kits'),
    ...deepDiff(data.levelTables, fresh.levelTables, 'levels'),
    ...deepDiff(data.gear, fresh.gear, 'gear'),
    ...deepDiff(data.items, fresh.items, 'items'),
  ];
  pendingReload = fresh;
  return diff;
}

// ---------------------------------------------------------------- message handling
function handlePlayer(seat, msg) {
  const c = campaign();
  const me = c.party.find(m => m.id === seat);
  if (!me) return;
  switch (msg.t) {
    case 'action': {
      if (!battle) return;
      const res = battle.playerAction(me, msg.action || {});
      if (res.refuse) return;   // the click simply doesn't respond
      touch();
      break;
    }
    case 'ooc-item':
      if (battle) return;
      outOfCombatItem(seat, msg.item, msg.target);
      break;
    case 'equip': {
      if (battle) return;   // equipment swaps out of combat only
      const { slot, item } = msg;
      if (!(slot in me.equipment)) return;
      if (item == null) { me.equipment[slot] = null; touch(); break; }
      if (!c.gearOwned || !c.gearOwned[item]) return;
      const v = validateEquip(data, me, slot, item);
      if (!v.ok) return;   // silent backstop — the UI never offered this
      // Single-copy pools: an item worn by someone else is not equippable.
      for (const other of c.party) {
        if (other.id === seat) continue;
        for (const s of Object.keys(other.equipment)) {
          if (other.equipment[s] === item) return;
        }
      }
      me.equipment[slot] = item;
      touch();
      break;
    }
    case 'move': {
      if (c.mode !== 'overworld') return;
      const room = currentRoom();
      const pos = (c.positions = c.positions || {})[seat] || { x: 48, y: 48, facing: 0 };
      const { x, y, facing } = msg;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      if (Math.abs(x - pos.x) + Math.abs(y - pos.y) > 24) return;  // one step at a time
      if (walkableAt(room, x + 4, y + 12, me.inVehicle) && walkableAt(room, x + 12, y + 12, me.inVehicle)) {
        c.positions[seat] = { x, y, facing: facing | 0 };
        checkPieceContact(seat, x, y);
        stateDirtyView = true;
        store.markDirty();
      }
      break;
    }
    case 'examine': {
      const room = currentRoom();
      const piece = (room?.pieces || []).find(p => p.id === msg.pieceId && !p.hidden);
      if (!piece) return;
      if (piece.kind === 'pickup') {
        if (piece.item) { c.inventory[piece.item] = (c.inventory[piece.item] || 0) + (piece.count || 1); emit({ kind: 'announce', text: `${me.name} picks up ${piece.item}${piece.count > 1 ? ' ×' + piece.count : ''}.` }); }
        if (piece.credits) { c.credits += piece.credits; emit({ kind: 'announce', text: `${me.name} picks up ${piece.credits} credits.` }); }
        room.pieces = room.pieces.filter(p => p !== piece);
        touch();
      } else if (piece.kind === 'sign') {
        emit({ kind: 'announce', text: `${me.name} reads the ${piece.name || 'sign'}: “${piece.text || '…'}”` });
      } else if (piece.kind === 'switch') {
        piece.state = !piece.state;
        emit({ kind: 'announce', text: `${me.name} flips the switch ${piece.state ? 'ON' : 'OFF'}.` });
        touch();
      } else if (piece.kind === 'dock') {
        me.inVehicle = !me.inVehicle;
        emit({ kind: 'announce', text: `${me.name} ${me.inVehicle ? 'boards the pedalo' : 'steps ashore'}.` });
        touch();
      } else {
        // The core verb: clicking an adjacent piece announces it to all screens; the GM answers by voice.
        emit({ kind: 'announce', text: `${me.name} examines the ${piece.name || piece.g || 'object'}.` });
      }
      break;
    }
    case 'keypad': {
      const room = currentRoom();
      const piece = (room?.pieces || []).find(p => p.id === msg.pieceId);
      if (!piece || piece.kind !== 'keypad') return;
      // Attempts ping the GM privately; examines announce publicly.
      emit({ kind: 'keypad-attempt', text: `${me.name} tries "${msg.code}" on the keypad${piece.code ? ` (staged: ${piece.code})` : ''} — ${piece.code && msg.code === piece.code ? 'MATCH' : 'no match'}.` });
      break;
    }
    case 'shop-buy': {
      if (!c.shop || !c.shop.open) return;
      const s = c.shop.stock[msg.name];
      if (!s || !s.on) return;
      if (c.credits < s.price) return;
      c.credits -= s.price;
      if (s.category === 'gear') (c.gearOwned = c.gearOwned || {})[msg.name] = true;
      else c.inventory[msg.name] = (c.inventory[msg.name] || 0) + 1;
      emit({ kind: 'announce', text: `${me.name} buys ${msg.name}.` });
      touch();
      break;
    }
    case 'shop-sell': {
      if (!c.shop || !c.shop.open) return;
      const name = msg.name;
      if (c.inventory[name] > 0) {
        c.inventory[name]--;
        c.credits += sellPrice(name);
      } else if (c.gearOwned && c.gearOwned[name]) {
        for (const m of c.party) for (const sl of Object.keys(m.equipment)) if (m.equipment[sl] === name) m.equipment[sl] = null;
        delete c.gearOwned[name];
        c.credits += sellPrice(name);
      } else return;
      emit({ kind: 'announce', text: `${me.name} sells ${name}.` });   // Zacharie buys anything
      touch();
      break;
    }
    case 'scene-choose':
      if (sceneRun && !sceneRun.state.done) {
        const gates = sceneRun.openGatesFor(seat);
        if (!gates.some(g => g.beat.key === msg.key)) return;
        sceneRun.recordChoice(seat, msg.key, msg.value);
        c.scene = sceneRun.state;
        touch();
      }
      break;
    case 'scene-hover':
      if (sceneRun) {
        const line = sceneRun.hoverLine(msg.beatIndex, msg.option);
        if (line) {
          const ws = seats.get(seat);
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ev', events: [{ kind: 'private', seat, hover: line }] }));
        }
      }
      break;
  }
}

function checkPieceContact(seat, x, y) {
  const c = campaign();
  const room = currentRoom();
  if (!room) return;
  for (const p of room.pieces || []) {
    const px = p.x, py = p.y;
    if (Math.abs(px - x) < 16 && Math.abs(py - y) < 16) {
      if (p.kind === 'door' && !p._pinged) {
        p._pinged = true;   // door pieces ping the GM on contact; only the Location panel moves the party
        setTimeout(() => { p._pinged = false; }, 5000);
        emit({ kind: 'gm-note', text: `${c.party.find(m => m.id === seat)?.name} is at the door "${p.name || 'door'}" in ${c.location.name}.` });
      }
      if (p.kind === 'trigger' && p.encounter && c.encounters[p.encounter] && !battle) {
        emit({ kind: 'announce', text: 'Ambush!' });
        launchEncounter({ name: p.encounter, ...JSON.parse(JSON.stringify(c.encounters[p.encounter])) });
      }
    }
  }
}

// ---------------------------------------------------------------- GM ops
function handleGm(msg) {
  const c = campaign();
  const op = msg.op;
  switch (op) {
    case 'pause':
      c.paused = !c.paused;
      emit({ kind: 'announce', text: c.paused ? 'Time holds. All gauges frozen on every screen.' : 'Time resumes.' });
      touch(); break;

    case 'new-campaign':
      store.campaign = newCampaign(data);
      battle = null; sceneRun = null;
      touch(); break;

    case 'snapshot': emit({ kind: 'gm-note', text: `Snapshot saved: ${store.snapshot(msg.name)}` }); break;
    case 'restore':
      store.restore(msg.file);
      battle = null; sceneRun = null; rebuildSceneRun();
      emit({ kind: 'announce', text: 'The world settles into a remembered shape.' });
      touch(); break;
    case 'undo': {
      const d = store.undo();
      emit({ kind: 'gm-note', text: d ? `Undid: ${d}` : 'Nothing to undo.' });
      touch(); break;
    }

    case 'set-location': setLocation(msg.zone || c.location.zone, msg.name); break;
    case 'set-mode': c.mode = msg.mode; touch(); break;

    case 'rest': {
      for (const m of c.party) {
        m.down = false;
        const b = memberBase(data, m);
        m.hp = b.hp; m.cp = b.cp; m.statuses = []; m.statChanges = []; m.elementSet = null;
      }
      emit({ kind: 'announce', text: 'Rest zone — the party is restored.' });
      touch(); break;
    }

    // ---- scenes
    case 'scene-start': {
      const def = msg.id === 'intro' ? (c.scenes.intro || introScene) : c.scenes[msg.id];
      if (!def) { emit({ kind: 'gm-note', text: `No scene named ${msg.id}.` }); break; }
      sceneRun = new SceneRun(data, c, def, { emit });
      c.scene = sceneRun.state;
      c.mode = 'scene';
      // Scenes autoplay their assigned track, looping — same grammar as encounters.
      if (c.sceneMusic[msg.id]) { c.jukebox.track = c.sceneMusic[msg.id]; c.jukebox.playing = true; }
      touch(); break;
    }
    case 'scene-continue': if (sceneRun) { sceneRun.advance(); c.scene = sceneRun.state; touch(); } break;
    case 'scene-jump': if (sceneRun) { sceneRun.jumpTo(msg.index); c.scene = sceneRun.state; touch(); } break;
    case 'scene-set-choice': if (sceneRun) { sceneRun.recordChoice(msg.seat, msg.key, msg.value); c.scene = sceneRun.state; touch(); } break;
    case 'scene-end':
      if (sceneRun) { sceneRun.state.done = true; c.scene = null; sceneRun = null; c.mode = 'overworld'; touch(); }
      break;
    case 'scene-effect':   // static / inversion / whiteout as components, GM-fired inside scenes
      emit({ kind: 'scene-effect', effect: msg.effect, duration: msg.duration || 1200 });
      break;

    // ---- encounters & battle
    case 'launch-encounter': {
      const def = msg.name && c.encounters[msg.name] ? { name: msg.name, ...JSON.parse(JSON.stringify(c.encounters[msg.name])) } : msg.def;
      if (def) launchEncounter(def);
      break;
    }
    case 'spawn-wave': if (battle) { battle.spawnWave(msg.index, 'manual'); touch(); } break;
    case 'end-encounter': endEncounter(); break;
    case 'enemy-action': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) { battle.gmEnemyAction(e, msg.action); touch(); }
      break;
    }
    case 'toggle-control': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) {
        e.control = e.control === 'ai' ? 'gm' : 'ai';
        // An AI instance holding at full acts immediately on flip.
        if (e.control === 'ai' && e.holding) { e.holding = false; e.gauge = 1; battle.onGaugeFill(e); }
        touch();
      }
      break;
    }
    case 'edit-instance': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) { Object.assign(e, msg.patch || {}); touch(); }
      break;
    }
    case 'enemy-add-status': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) { battle.tryApplyStatus(e, msg.status, null, { force: true }); touch(); }
      break;
    }
    case 'enemy-strip-status': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) { battle.cureStatus(e, msg.status, 'stripped'); touch(); }
      break;
    }
    case 'reveal': {
      if (!battle) break;
      const e = battle.enemies.find(x => x.id === msg.enemyId);
      if (e) { battle.reveal(e); touch(); }
      break;
    }
    case 'pool-edit': {
      if (battle) battle.pool[msg.item] = Math.max(0, (battle.pool[msg.item] || 0) + msg.delta);
      touch(); break;
    }

    // ---- templates & encounter library (clone anything)
    case 'template-save': c.templates[msg.name] = msg.tmpl; touch(); break;
    case 'template-delete': delete c.templates[msg.name]; touch(); break;
    case 'template-clone': {
      const src = c.templates[msg.from] || data.enemiesByName[msg.from];
      if (src) { c.templates[msg.to] = JSON.parse(JSON.stringify({ ...src, name: msg.to })); touch(); }
      break;
    }
    case 'encounter-save': c.encounters[msg.name] = msg.def; touch(); break;
    case 'encounter-delete': delete c.encounters[msg.name]; touch(); break;
    case 'zone-drop-table': c.zoneDropTables[msg.zone] = msg.items || []; touch(); break;

    // ---- items & credits (deduct and set, not just grants)
    case 'grant-item':
      store.recordUndo(`${msg.n > 0 ? 'grant' : 'deduct'} ${msg.name} ×${Math.abs(msg.n)}`);
      c.inventory[msg.name] = Math.max(0, (c.inventory[msg.name] || 0) + msg.n);
      if (msg.n > 0) emit({ kind: 'announce', text: `Party receives ${msg.name} ×${msg.n}.` });
      touch(); break;
    case 'set-item':
      store.recordUndo(`set ${msg.name} to ${msg.n}`);
      c.inventory[msg.name] = Math.max(0, msg.n | 0);
      touch(); break;
    case 'grant-gear':
      store.recordUndo(`grant gear ${msg.name}`);
      (c.gearOwned = c.gearOwned || {})[msg.name] = true;
      emit({ kind: 'announce', text: `Party receives ${msg.name}.` });
      touch(); break;
    case 'grant-credits':
      store.recordUndo(`credits ${msg.n > 0 ? '+' : ''}${msg.n}`);
      c.credits = Math.max(0, c.credits + (msg.n | 0));
      if (msg.n > 0) emit({ kind: 'announce', text: `Party receives ${msg.n} credits.` });
      touch(); break;
    case 'set-credits':
      store.recordUndo(`set credits to ${msg.n}`);
      c.credits = Math.max(0, msg.n | 0);
      touch(); break;
    case 'halve': {
      // The wipe toll, as a one-press convenience: 50% credits and 50% of each consumable stack.
      // Equipment, orbs, and key items survive. The sequence around it stays GM-administered.
      store.recordUndo('halve credits & consumables (wipe toll)');
      c.credits = Math.floor(c.credits / 2);
      for (const name of Object.keys(c.inventory)) {
        const it = data.itemsByName[name];
        if (it && (it.effect.type === 'orb')) continue;
        c.inventory[name] = Math.floor(c.inventory[name] / 2);
      }
      emit({ kind: 'announce', text: 'The world takes its toll.' });
      touch(); break;
    }

    // ---- players panel: the GM's universal override
    case 'player-edit': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`edit ${m.name}`);
      const p = msg.patch || {};
      if ('hp' in p) m.hp = Math.max(0, p.hp | 0);
      if ('cp' in p) m.cp = Math.max(0, p.cp | 0);
      if ('level' in p) store.setLevel(m, p.level | 0);
      if ('name' in p) m.name = String(p.name).slice(0, 40);
      if ('klass' in p && data.classKits.classes[p.klass]) {
        if (Object.keys(data.classKits.classes).includes(m.name)) m.name = p.klass;
        m.klass = p.klass; m.element = data.classKits.classes[p.klass].element;
        const s = statsAt(data, p.klass, m.level); m.hp = Math.min(m.hp, s.hp) || s.hp; m.cp = Math.min(m.cp, s.cp) || s.cp;
      }
      if ('down' in p) {
        m.down = !!p.down;
        if (!m.down && m.hp <= 0) m.hp = 1;
        if (m.down) { m.hp = 0; m.holding = false; m.gauge = 0; }
      }
      if (m.hp === 0 && !('down' in p)) m.down = true;
      if (m.hp > 0 && m.down && 'hp' in p) m.down = false;
      touch(); break;
    }
    case 'player-bench': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`${msg.benched ? 'bench' : 'return'} ${m.name}`);
      m.benched = !!msg.benched;
      if (m.benched) { m.holding = false; m.gauge = 0; }
      if (battle) battle.partySlots = battle.partySlots.filter(id => id !== m.id || !m.benched);
      const joinsFight = battle && !m.benched && !battle.partySlots.includes(m.id);
      if (joinsFight) {
        battle.partySlots.push(m.id);
        m.gauge = 0; m.holding = false; m.defending = false; m.hastySecond = false;
        battle.rollCrit(m);
      }
      emit({ kind: 'announce', text: m.benched ? `${m.name} sits this one out.` : joinsFight ? `${m.name} steps onto the field!` : `${m.name} rejoins the party.` });
      if (battle) battle.checkEnd();
      touch(); break;
    }
    case 'player-action': {
      // The GM pilots the absent character, mirroring the player interface.
      if (!battle) break;
      const m = c.party.find(x => x.id === msg.seat);
      if (m) { battle.playerAction(m, msg.action || {}); touch(); }
      break;
    }
    case 'player-add-status': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`add ${msg.status} to ${m.name}`);
      if (battle) battle.tryApplyStatus(m, msg.status, null, { force: true });
      else if (!m.statuses.some(s => s.name === msg.status)) m.statuses.push({ name: msg.status, applierId: null, applierClass: null, turnsAfflicted: 0, permanent: false });
      touch(); break;
    }
    case 'player-strip-status': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`strip ${msg.status} from ${m.name}`);
      m.statuses = m.statuses.filter(s => s.name !== msg.status);
      touch(); break;
    }
    case 'player-add-statchange': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`add ${msg.stat} ${msg.dir} to ${m.name}`);
      if (battle) battle.applyStatChange(m, { stat: msg.stat, dir: msg.dir, amount: msg.amount, turns: msg.turns });
      else m.statChanges.push({ stat: msg.stat, dir: msg.dir, amount: msg.amount, turnsLeft: msg.turns, fresh: true });
      touch(); break;
    }
    case 'player-strip-statchange': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`strip ${msg.stat} ${msg.dir} from ${m.name}`);
      m.statChanges = m.statChanges.filter(sc => !(sc.stat === msg.stat && sc.dir === msg.dir));
      touch(); break;
    }
    case 'player-set-element': {
      const m = c.party.find(x => x.id === msg.seat);
      if (!m) break;
      store.recordUndo(`element of ${m.name}`);
      m.elementSet = msg.element ? { element: msg.element, turnsLeft: msg.turns || 2, fresh: true } : null;
      touch(); break;
    }

    // ---- rooms & staging
    case 'room-save': c.rooms[msg.location] = msg.room; touch(); break;
    case 'room-clone':
      if (c.rooms[msg.from]) { c.rooms[msg.to] = JSON.parse(JSON.stringify(c.rooms[msg.from])); touch(); }
      break;
    case 'room-delete': delete c.rooms[msg.location]; touch(); break;
    case 'piece-toggle-hidden': {
      const room = c.rooms[msg.location] || currentRoom();
      const piece = (room?.pieces || []).find(p => p.id === msg.pieceId);
      if (piece) { piece.hidden = !piece.hidden; touch(); }   // the GM's reveal action
      break;
    }

    // ---- shop
    case 'shop-open':
      c.shop = { open: false, stock: c.shop && msg.keepStock ? c.shop.stock : defaultStock() };
      c.mode = 'shop';
      touch(); break;
    case 'shop-stock': {
      if (!c.shop) break;
      const s = c.shop.stock[msg.name];
      if (s) { if ('on' in msg) s.on = !!msg.on; if ('price' in msg) s.price = Math.max(0, msg.price | 0); }
      touch(); break;
    }
    case 'shop-open-doors': if (c.shop) { c.shop.open = true; emit({ kind: 'announce', text: 'Zacharie: “Welcome, welcome.”' }); touch(); } break;
    case 'shop-close': c.shop = null; if (c.mode === 'shop') c.mode = 'overworld'; touch(); break;

    // ---- jukebox & stingers
    case 'jukebox-play': c.jukebox.track = msg.file; c.jukebox.playing = true; touch(); break;
    case 'music-zone':
      if (msg.zone) c.musicZones[msg.file] = msg.zone;
      else delete c.musicZones[msg.file];
      touch(); break;
    case 'scene-music':
      if (msg.file) c.sceneMusic[msg.id] = msg.file;
      else delete c.sceneMusic[msg.id];
      touch(); break;
    case 'jukebox-queue-add':
      c.jukebox.queue.push(msg.file); touch(); break;
    case 'jukebox-queue-remove':
      c.jukebox.queue.splice(msg.index, 1); touch(); break;
    case 'jukebox-queue-clear':
      c.jukebox.queue = []; touch(); break;
    case 'jukebox-stop': c.jukebox.playing = false; touch(); break;
    case 'jukebox-queue': c.jukebox.queue = msg.queue || []; touch(); break;
    case 'jukebox-skip': {
      const q = c.jukebox.queue;
      if (q.length) { c.jukebox.track = q.shift(); c.jukebox.playing = true; }
      touch(); break;
    }
    case 'stinger': emit({ kind: 'stinger', file: msg.file }); break;

    // ---- notes (GM screen living inside the console)
    case 'note-set': c.notes[msg.key] = msg.text; touch(); break;

    // ---- data reload with diff
    case 'reload-diff': {
      const diff = computeReloadDiff();
      emit({ kind: 'reload-diff', diff: diff.slice(0, 200), total: diff.length });
      break;
    }
    case 'reload-apply':
      if (pendingReload) { data = pendingReload; store.data = data; pendingReload = null; emit({ kind: 'gm-note', text: 'Data reloaded.' }); touch(); }
      break;
    case 'reload-cancel': pendingReload = null; break;
  }
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (url === '/' || url === '/index.html') return sendFile(res, path.join(CLIENT_DIR, 'index.html'));
    if (url.startsWith('/assets/')) {
      const p = path.normalize(path.join(ASSETS_DIR, url.slice(8)));
      if (!p.startsWith(ASSETS_DIR)) { res.writeHead(403); return res.end(); }
      return sendFile(res, p);
    }
    if (url === '/api/assets') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(assetTree()));
    }
    if (url === '/api/art') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(artIndex()));
    }
    if (url === '/api/static-data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        kits: data.classKits, items: data.items, palettes: data.palettes, gear: data.gear,
        bestiary: Object.values(data.enemiesByName).map(e => ({
          name: e.name, zone: e.zone, hp: e.hp, element: e.element, archetype: e.archetype,
          gauge_s: e.gauge_s, dmg_per_action: e.dmg_per_action, group: e.group,
          def: e.def, res: e.res, lck: e.lck, moves: e.moves, status_tiers: e.status_tiers,
          special: e.special || null, anchor_level: e.anchor_level,
        })),
        riders: data.riders,
        scripts: data.scripts,
      }));
    }
    const logMatch = url.match(/^\/api\/log\/(\d+)(\.txt|\.json)?$/);
    if (logMatch) {
      const l = campaign().log[+logMatch[1]];
      if (!l) { res.writeHead(404); return res.end('no such log'); }
      if (logMatch[2] === '.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(l.entries.map(e => `${(e.t / 1000).toFixed(1)}s ${e.ev} ${JSON.stringify(e)}`).join('\n'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(l, null, 1));
    }
    // client files
    const p = path.normalize(path.join(CLIENT_DIR, url));
    if (p.startsWith(CLIENT_DIR) && existsSync(p) && statSync(p).isFile()) return sendFile(res, p);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

function sendFile(res, p) {
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(p));
}

// ---------------------------------------------------------------- WS
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let seat = null;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'hello') {
      const want = String(msg.seat || '');
      if (!['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'GM'].includes(want)) return;
      if (ACCESS_KEY && msg.key !== ACCESS_KEY) { ws.close(4001, 'bad key'); return; }
      // Reconnection restores the seat exactly; a new connection replaces the old one.
      const old = seats.get(want);
      if (old && old !== ws && old.readyState === 1) old.close(4000, 'seat taken over');
      seat = want;
      seats.set(seat, ws);
      ws.send(JSON.stringify({ t: 'joined', seat, art: artIndex() }));
      ws.send(JSON.stringify({ t: 'state', view: viewFor(seat) }));
      stateDirtyView = true;
      return;
    }
    if (!seat) return;
    if (seat === 'GM' && msg.t === 'gm') { handleGm(msg); return; }
    if (seat !== 'GM') handlePlayer(seat, msg);
  });
  ws.on('close', () => {
    if (seat && seats.get(seat) === ws) { seats.delete(seat); stateDirtyView = true; }
  });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat so hosting proxies (Railway et al.) don't reap idle seats.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 30000);

// Rebuilt from disk on every call: drop a file named after an enemy into the
// hot folders and it's matched on the next connect or RESCAN — no manual step.
function artIndex() {
  const tree = assetTree();
  const enemies = {};
  const names = new Set([
    ...Object.keys(data.enemiesByName),            // bestiary + compound-fight units
    ...Object.keys(campaign().templates || {}),    // GM-created templates
  ]);
  for (const name of names) {
    enemies[name] = {
      sprite: findArt(tree.sprites.enemies, name),
      portrait: findArt([...tree.portraits.Enemies, ...tree.portraits.Bosses], name),
    };
  }
  const party = {};
  for (const k of Object.keys(data.classKits.classes)) {
    party[k] = { sprite: findArt(tree.sprites.party, k), portrait: findArt(tree.portraits.Party, k) };
  }
  return { tree, enemies, party };
}

// ---------------------------------------------------------------- main loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;
  if (battle) {
    battle.tick(dt);
    stateDirtyView = true;
  }
  flushEvents();
}, 100);

setInterval(() => {
  if (stateDirtyView) { broadcastState(); stateDirtyView = false; }
}, 180);

setInterval(() => store.persist(), 4000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OFF TTRPG server listening on http://localhost:${PORT}`);
  console.log(`assets: ${ASSETS_DIR}`);
  console.log(`state dir: ${VAR_DIR}${ACCESS_KEY ? ' · access key required' : ''}`);
});
