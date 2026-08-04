// GM console. Organizes and suggests, never restricts: every list reachable,
// every value editable, and nothing here ever says "you can't."

import { App, connect, send, gm, loadStaticData, applyZone, applyPalette, el, statusChip, statChangeChip, floatOver, partyArt, enemyArt, artEl, syncJukebox, volumeSlider, rescanAssets } from '/common.js';
import { drawRoomKit } from '/roomkit.js';

const $ = id => document.getElementById(id);
const STATUSES = ['Poisoned', 'Blinded', 'Muted', 'Palsied', 'Asleep', 'Furious', 'Madness', 'Hasty', 'Taunted', 'Thorns', 'Famine', 'Impure', 'Vilified', 'Corrupted', 'Defamed'];
const RING = ['Plastic', 'Metal', 'Smoke', 'Meat', 'Sugar'];

let activeTab = null;
let leftMode = 'create';
let pendingAction = null;      // {enemyId, kind, move|item} — an enemy acting at the party
let pendingPilot = null;       // {seat, kind, comp?, item?, element?, wants:'enemy'|'ally'} — the GM playing an absent character
let stagedRoom = null;         // local editing copy of the current room
let stagedDirty = false;
let tool = null, dragA = null, stamp = null;
let editingTmpl = null;        // enemy editor working copy
let enc = null;                // encounter builder working copy
let lastStateAt = 0;

await loadStaticData();
connect('GM');

App.onEvent = e => {
  if (e.kind === 'announce') announce(e.text);
  if (e.kind === 'gm-note') announce(e.text);
  if (e.kind === 'keypad-attempt') announce(e.text);
  if (e.kind === 'float') showFloat(e.targetId, e.text, e.style);
  if (e.kind === 'gm-turn') announce('An enemy gauge is full — click it to act.');
  if (e.kind === 'reload-diff') showReloadDiff(e.diff, e.total);
};

let wasBattle = false;
App.onState = view => {
  lastStateAt = performance.now();
  document.body.classList.toggle('paused', !!view.paused);
  const inBattle = view.mode === 'battle' && !!view.battle;
  if (inBattle && !wasBattle) setLeftMode('party');   // the fight starts: monitors up
  if (!inBattle && wasBattle) setLeftMode('create');
  wasBattle = inBattle;
  render(view);
};

function announce(t) { $('announce').textContent = t; }
function showFloat(targetId, text, style) {
  const host = document.querySelector(`[data-id="${targetId}"]`);
  if (host) floatOver(host, text, style);
}

// ---------------------------------------------------------------- chrome
const TABS = ['Location', 'Enemies', 'Encounter', 'Items', 'Players', 'Shop', 'Jukebox', 'Stingers', 'Cutscene', 'System'];
for (const t of TABS) {
  const b = el('button', { class: 'tab', id: `tab-${t}` }, t);
  b.onclick = () => { activeTab = activeTab === t ? null : t; renderPanels(); };
  $('tabs').appendChild(b);
}
$('pausebtn').onclick = () => gm('pause');
$('pausebtn').parentElement.insertBefore(volumeSlider(), $('pausebtn'));
$('lt-create').onclick = () => setLeftMode('create');
$('lt-party').onclick = () => setLeftMode('party');
function setLeftMode(m) {
  leftMode = m;
  $('createcol').style.display = m === 'create' ? '' : 'none';
  $('partycol').style.display = m === 'party' ? '' : 'none';
  $('lt-create').classList.toggle('on', m === 'create');
  $('lt-party').classList.toggle('on', m === 'party');
}

// ---------------------------------------------------------------- render root
function render(view) {
  applyZone(view.location.zone);
  $('zn').textContent = `${view.location.zone} · ${view.location.name}`;
  const pb = $('pausebtn');
  pb.classList.toggle('on', view.paused);
  pb.textContent = view.paused ? '▶ RESUME' : '❚❚ PAUSE';

  if (!stagedDirty) stagedRoom = view.room ? JSON.parse(JSON.stringify(view.room)) : null;

  renderCreateCol(view);
  renderPartyCol(view);
  renderField(view);
  renderStrip(view);
  renderPanels();
  syncJukebox(view.jukebox);
}

// ---------------------------------------------------------------- CREATE column
function renderCreateCol(view) {
  const col = $('createcol');
  if (col.dataset.built && !col.dataset.stale) return;
  col.dataset.built = '1';
  col.innerHTML = '';
  col.appendChild(el('div', { class: 'dsec' }, 'BUILD — DRAG RECTANGLES ON THE FIELD'));
  const tools = el('div', { class: 'btool' });
  const floorTools = ['brackets', 'carpet', 'plain', 'path', 'grass', 'metal', 'tracks', 'water', 'void', 'gold0', 'gold0top', 'gold0deep', 'path0', 'ink0', 'line0'];
  for (const f of floorTools) tools.appendChild(toolBtn(`F·${f}`, `floor:${f}`));
  for (const s of ['wall', 'building', 'fence', 'ledge', 'block0', 'hut0']) tools.appendChild(toolBtn(`S·${s}`, `struct:${s}`));
  tools.appendChild(toolBtn('Erase', 'erase'));
  tools.appendChild(toolBtn('Done', null));
  col.appendChild(tools);

  col.appendChild(el('div', { class: 'dsec' }, 'PROP STAMPS'));
  const props = el('div', { class: 'dgrid' });
  for (const p of ['crate', 'barrel', 'cabinet', 'bottles', 'counter', 'rug', 'door', 'window', 'plant', 'stack', 'lamp', 'sign', 'bed', 'shelf', 'vat', 'dock', 'rock',
    'ladder', 'window0', 'stairs0', 'fist', 'greyblock', 'doorwhite']) {
    props.appendChild(stampBtn(p, { stampKind: 'prop', t: p }));
  }
  col.appendChild(props);

  col.appendChild(el('div', { class: 'dsec' }, 'PIECES — SPRITES · PICKUPS · INTERACTION'));
  const pieces = el('div', { class: 'dgrid' });
  pieces.appendChild(stampBtn('item ◇', { stampKind: 'piece', kind: 'pickup', g: '◇' }));
  pieces.appendChild(stampBtn('credits ¤', { stampKind: 'piece', kind: 'pickup', g: '¤', credits: true }));
  pieces.appendChild(stampBtn('sign ✉', { stampKind: 'piece', kind: 'sign', g: '✉' }));
  pieces.appendChild(stampBtn('switch ⌥', { stampKind: 'piece', kind: 'switch', g: '⌥' }));
  pieces.appendChild(stampBtn('keypad ⌨', { stampKind: 'piece', kind: 'keypad', g: '⌨' }));
  pieces.appendChild(stampBtn('door ⌸', { stampKind: 'piece', kind: 'door', g: '⌸' }));
  pieces.appendChild(stampBtn('dock ⚓', { stampKind: 'piece', kind: 'dock', g: '⚓' }));
  pieces.appendChild(stampBtn('trigger ⚠', { stampKind: 'piece', kind: 'trigger', g: '⚠' }));
  pieces.appendChild(stampBtn('rest ✚', { stampKind: 'piece', kind: 'rest', g: '✚' }));
  col.appendChild(pieces);

  col.appendChild(el('div', { class: 'dsec' }, 'NPC / ENEMY SPRITES (HOT FOLDER)'));
  const sprites = el('div', { class: 'dgrid' });
  const tree = App.art ? App.art.tree : { sprites: { npcs: [], enemies: [], party: [] } };
  for (const f of [...(tree.sprites.npcs || []), ...(tree.sprites.enemies || [])]) {
    const name = f.split('/').pop().replace(/\.[a-z]+$/i, '');
    sprites.appendChild(stampBtn(name, { stampKind: 'piece', kind: 'npc', sprite: f, g: '♟' }));
  }
  col.appendChild(sprites);
  col.appendChild(el('div', { class: 'dnote' }, 'CLICK A STAMP THEN CLICK THE FIELD · CLICK PIECE = HIDE · DBL-CLICK = REMOVE'));
  const save = el('button', { class: 'bigbtn', style: 'margin:8px 12px' }, 'SAVE ROOM');
  save.onclick = saveRoom;
  col.appendChild(save);
}

function toolBtn(label, t) {
  const b = el('button', { class: 'bt' }, label);
  b.onclick = () => {
    tool = t; stamp = null;
    document.querySelectorAll('.bt').forEach(x => x.classList.remove('on'));
    if (t) b.classList.add('on');
    $('field').classList.toggle('building', !!t);
  };
  return b;
}

function stampBtn(label, s) {
  const b = el('div', { class: 'dpiece' }, el('span', { class: 'g' }, s.g || '▣'), el('span', { class: 'n' }, label));
  b.onclick = () => {
    stamp = s; tool = null;
    document.querySelectorAll('.dpiece').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.bt').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('field').classList.add('building');
  };
  return b;
}

function saveRoom() {
  if (!stagedRoom) stagedRoom = { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] };
  gm('room-save', { location: App.view.location.name, room: stagedRoom });
  stagedDirty = false;
  announce(`Room saved: ${App.view.location.name} (${(stagedRoom.floors || []).length + (stagedRoom.structs || []).length} shapes, ${(stagedRoom.pieces || []).length} pieces).`);
}

// ---------------------------------------------------------------- PARTY column
function renderPartyCol(view) {
  const col = $('partycol');
  col.innerHTML = '';
  col.classList.toggle('targeting', !!pendingAction);
  // Only present members: in battle that's the roster; otherwise connected, un-benched
  // seats. Absent characters live in the PLAYERS tab, not on the table.
  const present = view.party.filter(m => !m.benched &&
    ((view.battle && (view.battle.partySlots || []).includes(m.id)) || (view.connected || []).includes(m.id)));
  if (!present.length) col.appendChild(el('div', { style: 'padding:10px;font-size:13px;color:#666' }, 'NOBODY PRESENT — SEE PLAYERS TAB'));
  for (const m of present) {
    const pm = el('div', { class: 'pm' + (m.down ? ' dead' : ''), 'data-id': m.id });
    pm.appendChild(el('div', { class: 'pmn' }, `${m.name} `, el('span', { style: 'font-size:13px;color:#777' }, `LV${m.level}`),
      (view.connected || []).includes(m.id) ? null : el('span', { class: 'icn', style: 'margin-left:4px;color:#888' }, 'OFFLINE — PILOT')));
    pm.appendChild(el('div', { class: 'pmnums' },
      el('span', { class: 'pmv' }, `${m.hp}`, el('em', {}, 'hp'), el('i', { style: `width:${Math.round(m.hp / m.maxHp * 100)}%` })),
      el('span', { class: 'pmv cp' }, `${m.cp}`, el('em', {}, 'cp'), el('i', { style: `width:${Math.round(m.cp / m.maxCp * 100)}%` }))));
    const g = el('div', { class: 'gauge' + (m.critCharged ? ' critcharge' : '') + (m.holding ? ' held' : ''), style: 'margin-top:5px;height:6px', 'data-gid': m.id },
      el('i', { style: `width:${Math.round(m.gauge * 100)}%` }));
    pm.appendChild(g);
    const icons = el('div', { class: 'picons' });
    if (m.defending) icons.appendChild(el('span', { class: 'icn up' }, '▲DEF·25'));
    for (const s of m.statuses) icons.appendChild(statusChip(s));
    for (const sc of m.statChanges) icons.appendChild(statChangeChip(sc));
    pm.appendChild(icons);
    pm.onclick = () => {
      if (pendingAction) return targetPlayer(m);
      if (pendingPilot && pendingPilot.wants === 'ally') return pilotTarget(m);
      if (m.holding && !m.down && !m.benched && App.view.battle) return openPilotStack(m);
    };
    col.appendChild(pm);
  }
}

// ---------------------------------------------------------------- piloting an absent character
// "The GM pilots the absent character" — the action stack mirrors the player interface.
function openPilotStack(pm) {
  const st = $('estack');
  st.innerHTML = '';
  st.style.left = '38%'; st.style.top = '18%';
  st.appendChild(el('div', { class: 'eact', style: 'border-left-color:var(--amber);cursor:default;color:var(--amber)' },
    `PILOTING ${pm.name.toUpperCase()}`, el('small', {}, `${pm.hp}/${pm.maxHp} hp · ${pm.cp} cp${pm.critCharged ? ' · CRIT CHARGED' : ''}`)));
  const atk = el('button', { class: 'eact' }, 'Attack', el('small', {}, 'then click an enemy'));
  atk.onclick = () => { st.classList.remove('open'); armPilot(pm, { kind: 'attack', wants: 'enemy' }, 'Attack — click an enemy.'); };
  st.appendChild(atk);
  for (const c of (pm.competences || []).filter(c => c.unlocked)) {
    const afford = pm.cp >= c.cp;
    const b = el('button', { class: 'eact', style: afford ? '' : 'opacity:.4' },
      `${c.name} — ${c.cp}`, el('small', {}, `${c.target}${c.element ? ' · ' + c.element : ''} · ${c.effect}`));
    b.onclick = () => {
      if (!afford) return;
      if (c.choosesElement) {
        st.innerHTML = '';
        for (const elName of ['Plastic', 'Metal', 'Smoke', 'Meat']) {
          const eb = el('button', { class: 'eact' }, elName);
          eb.onclick = () => { st.classList.remove('open'); pilotComp(pm, c, elName); };
          st.appendChild(eb);
        }
        return;
      }
      st.classList.remove('open');
      pilotComp(pm, c, null);
    };
    st.appendChild(b);
  }
  const def = el('button', { class: 'eact' }, 'Defend', el('small', {}, '+25 DEF until next fill'));
  def.onclick = () => { st.classList.remove('open'); gm('player-action', { seat: pm.id, action: { kind: 'defend' } }); };
  st.appendChild(def);
  const inv = App.view.inventory || {};
  const names = Object.keys(inv).filter(n => inv[n] > 0);
  const obj = el('button', { class: 'eact' }, 'Objects', el('small', {}, names.length ? `${names.length} kinds in the shared inventory` : 'inventory is empty'));
  obj.onclick = () => {
    st.innerHTML = '';
    for (const n of names) {
      const item = App.staticData.items.catalog.find(c => c.name === n);
      if (!item || item.effect.outOfCombatOnly) continue;
      const b = el('button', { class: 'eact' }, `${n} ×${inv[n]}`, el('small', {}, item.desc));
      b.onclick = () => {
        st.classList.remove('open');
        const wants = item.effect.target === 'one enemy' ? 'enemy' : 'ally';
        armPilot(pm, { kind: 'item', item: n, wants }, `${n} — click ${wants === 'enemy' ? 'an enemy' : 'a party member'}.`);
      };
      st.appendChild(b);
    }
    st.classList.add('open');
  };
  st.appendChild(obj);
  st.classList.add('open');
}

function pilotComp(pm, c, element) {
  if (c.target === 'one enemy') return armPilot(pm, { kind: 'competence', comp: c.name, element, wants: 'enemy' }, `${c.name} — click an enemy.`);
  if (c.target === 'one ally') return armPilot(pm, { kind: 'competence', comp: c.name, element, wants: 'ally' }, `${c.name} — click a party member.`);
  gm('player-action', { seat: pm.id, action: { kind: 'competence', competence: c.name, element } });
}

function armPilot(pm, arm, note) {
  pendingPilot = { seat: pm.id, ...arm };
  announce(`Piloting ${pm.name}: ${note} (Esc lowers it.)`);
  render(App.view);
}

function pilotTarget(t) {
  if (!pendingPilot) return;
  const a = pendingPilot;
  pendingPilot = null;
  if (a.kind === 'attack') gm('player-action', { seat: a.seat, action: { kind: 'attack', targetId: t.id } });
  if (a.kind === 'competence') gm('player-action', { seat: a.seat, action: { kind: 'competence', competence: a.comp, targetId: t.id, element: a.element } });
  if (a.kind === 'item') gm('player-action', { seat: a.seat, action: { kind: 'item', item: a.item, targetId: t.id } });
  render(App.view);
}

function targetPlayer(m) {
  if (!pendingAction || m.down) return;
  const a = pendingAction;
  pendingAction = null;
  if (a.kind === 'move') gm('enemy-action', { enemyId: a.enemyId, action: { kind: 'move', move: a.move, targetId: m.id } });
  if (a.kind === 'pool-item') gm('enemy-action', { enemyId: a.enemyId, action: { kind: 'pool-item', item: a.item, targetId: m.id } });
  render(App.view);
}

addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pendingAction) { pendingAction = null; announce('Action lowered.'); render(App.view); }
    if (pendingPilot) { pendingPilot = null; announce('Pilot action lowered.'); render(App.view); }
    $('estack').classList.remove('open');
  }
});

// ---------------------------------------------------------------- FIELD
const SLOT_POS = [
  { left: 6, top: 16 }, { left: 20, top: 28 }, { left: 34, top: 16 }, { left: 48, top: 28 },
  { left: 10, top: 52 }, { left: 24, top: 62 }, { left: 38, top: 52 }, { left: 52, top: 62 },
];

function renderField(view) {
  const field = $('field');
  const overlay = $('fieldOverlay');
  const canvas = $('roomcanvas');
  const inBattle = view.mode === 'battle' && view.battle;
  overlay.innerHTML = '';
  if (inBattle) {
    canvas.style.display = 'none';
    field.classList.remove('building');
    if (view.battle.backdrop) {
      field.classList.add('backdrop');
      field.style.backgroundImage = `url('/assets/backdrops/${view.battle.backdrop}')`;
      if (view.battle.palette) applyPalette(view.battle.palette);
    }
    // slot markers render on the GM's field only
    for (let i = 0; i < 8; i++) {
      overlay.appendChild(el('div', { class: 'slot', style: `left:${SLOT_POS[i].left}%;top:${SLOT_POS[i].top}%` }, `${i + 1}`));
    }
    // The party, on the field where the GM can see the whole stage.
    const anchors = [
      { right: '7vw', bottom: '16%', h: 130 },
      { right: '17vw', bottom: '28%', h: 108 },
      { right: '2vw', bottom: '33%', h: 108 },
      { right: '14vw', bottom: '47%', h: 104 },
      { right: '1vw', bottom: '52%', h: 104 },
      { right: '8vw', bottom: '63%', h: 100 },
    ];
    (view.battle.partySlots || []).forEach((pid, i) => {
      const pm = view.party.find(x => x.id === pid);
      if (!pm || pm.benched) return;
      const a = anchors[i] || anchors[0];
      const targeting = pendingAction && !pm.down && pendingAction.kind !== 'pool-item-friendly';
      const div = el('div', {
        class: 'benemy' + (pm.down ? ' deadE' : '') + (targeting ? ' gm-target' : ''),
        style: `right:${a.right};bottom:${a.bottom};left:auto;top:auto;width:130px`,
        'data-id': pm.id,
      });
      div.appendChild(artEl(partyArt(pm.klass), pm.name, a.h));
      div.appendChild(el('div', { class: 'ename outline' }, pm.name));
      div.appendChild(el('div', { class: 'ehp' }, el('i', { style: `width:${Math.round(pm.hp / pm.maxHp * 100)}%` })));
      div.appendChild(el('div', { class: 'eg' + (pm.critCharged ? ' critcharge' : '') },
        el('i', { style: `width:${Math.round(pm.gauge * 100)}%;background:${pm.critCharged ? 'var(--red)' : 'var(--wht)'}`, 'data-gid2': pm.id })));
      const icons = el('div', { class: 'picons', style: 'justify-content:center' });
      for (const st of pm.statuses) icons.appendChild(statusChip(st));
      for (const sc of pm.statChanges) icons.appendChild(statChangeChip(sc));
      div.appendChild(icons);
      div.onclick = () => {
        if (pendingAction) return targetPlayer(pm);
        if (pendingPilot && pendingPilot.wants === 'ally') return pilotTarget(pm);
        if (pm.holding && !pm.down && !pm.benched) return openPilotStack(pm);
      };
      overlay.appendChild(div);
    });
    for (const e of view.battle.enemies) {
      const p = SLOT_POS[(e.slot || 1) - 1] || SLOT_POS[0];
      const wantsMe = pendingPilot && pendingPilot.wants === 'enemy' && !e.dead;
      const div = el('div', { class: 'benemy' + (e.dead ? ' deadE' : '') + (wantsMe ? ' gm-target' : ''), style: `left:${p.left}%;top:${p.top}%`, 'data-id': e.id });
      div.appendChild(artEl(enemyArt(e.template), e.name, Math.round(90 * (e.size || 1))));
      div.appendChild(el('div', { class: 'ename outline' }, e.name));
      div.appendChild(el('div', { class: 'ehp' }, el('i', { style: `width:${Math.round(e.hp / e.maxHp * 100)}%` })));
      div.appendChild(el('div', { class: 'eg' + (e.critCharged ? ' critcharge' : '') }, el('i', { style: `width:${Math.round(e.gauge * 100)}%`, 'data-egid': e.id })));
      const tag = el('div', { class: 'ectl' + (e.control === 'gm' ? ' gm' : '') }, e.control.toUpperCase());
      tag.onclick = ev => { ev.stopPropagation(); gm('toggle-control', { enemyId: e.id }); };
      div.appendChild(tag);
      div.onclick = () => {
        if (pendingPilot && pendingPilot.wants === 'enemy' && !e.dead) return pilotTarget(e);
        enemyClicked(e);
      };
      overlay.appendChild(div);
    }
  } else {
    field.classList.remove('backdrop');
    field.style.backgroundImage = '';
    canvas.style.display = 'block';
    drawStaging(view);
  }
}

let phase = 0;
setInterval(() => { phase = !phase; if (App.view && App.view.mode !== 'battle') drawStaging(App.view); }, 380);

function fieldScale() {
  const field = $('field');
  if (!field) return 1;   // seat taken over: the console DOM is gone, intervals wind down
  const room = stagedRoom || { w: 768, h: 576 };
  return Math.min(field.clientWidth / (room.w || 768), field.clientHeight / (room.h || 576));
}

function drawStaging(view) {
  const canvas = $('roomcanvas');
  if (!canvas) return;
  const room = stagedRoom || { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] };
  room.w = room.w || 768; room.h = room.h || 576;
  const sc = fieldScale();
  canvas.width = room.w; canvas.height = room.h;
  canvas.style.width = `${room.w * sc}px`; canvas.style.height = `${room.h * sc}px`;
  const x = canvas.getContext('2d');
  x.imageSmoothingEnabled = false;
  const pals = App.staticData.palettes;
  const p = pals[room.palette];
  const zmap = { 'Zone 1': ['#2e6d9e', '#1d4b70', '#7fa8c6', '#cfe3f2'], 'Zone 2': ['#c8871c', '#8a5c10', '#e0b56a', '#f4e2bb'], 'Zone 3': ['#2f9e44', '#1d6b2d', '#7fc68f', '#c9ecc9'], 'The Room': ['#d0231f', '#8f1512', '#e07f7c', '#f2c9c7'] };
  const [zb, zd, zl, zp] = zmap[view.location.zone] || zmap['Zone 1'];
  const pal = p ? { base: p.base, dark: zd, lite: p.pale, pale: p.tint } : { base: zb, dark: zd, lite: zl, pale: zp };
  drawRoomKit(x, room, pal, phase);
  // pieces as DOM over the canvas
  const overlay = $('fieldOverlay');
  for (const piece of room.pieces || []) {
    const d = el('div', {
      style: `position:absolute;left:${piece.x * sc}px;top:${piece.y * sc}px;font-size:${26 * sc}px;color:var(--wht);cursor:pointer;z-index:3;`
        + `text-shadow:2px 0 var(--blk),-2px 0 var(--blk),0 2px var(--blk),0 -2px var(--blk);${piece.hidden ? 'opacity:.35' : ''}`,
      title: `${piece.name || piece.kind}${piece.hidden ? ' (hidden)' : ''}`,
    }, piece.g || '◇');
    if (piece.hidden) d.append(el('span', { style: 'font-size:10px;color:var(--wht)' }, '◌'));
    d.onclick = ev => { ev.stopPropagation(); piece.hidden = !piece.hidden; stagedDirty = true; drawStaging(view); };
    d.ondblclick = ev => { ev.stopPropagation(); room.pieces = room.pieces.filter(z => z !== piece); stagedDirty = true; drawStaging(view); };
    overlay.appendChild(d);
  }
  // party tokens on the GM camera
  for (const [pid, pp] of Object.entries(view.positions || {})) {
    const pm = view.party.find(z => z.id === pid);
    if (!pm) continue;
    const d = el('div', { style: `position:absolute;left:${pp.x * sc}px;top:${pp.y * sc}px;z-index:2;font-size:10px;font-family:var(--disp);text-transform:uppercase;color:var(--amber)` }, pm.name.slice(0, 8).toUpperCase());
    $('fieldOverlay').appendChild(d);
  }
}

// staging mouse: drag rects for floors/structs, click for stamps
const SNAP = 16;
$('field').onmousedown = e => {
  if (App.view && App.view.mode === 'battle') return;
  if (!tool && !stamp) return;
  const pt = fieldPoint(e);
  if (stamp) { placeStamp(pt); return; }
  if (tool === 'erase') { eraseAt(pt); return; }
  dragA = pt;
};
$('field').onmousemove = e => {
  if (!tool || !dragA) return;
  const b = fieldPoint(e), pv = $('preview');
  const sc = fieldScale();
  pv.style.display = 'block';
  pv.style.left = `${Math.min(dragA.x, b.x) * sc}px`;
  pv.style.top = `${Math.min(dragA.y, b.y) * sc}px`;
  pv.style.width = `${Math.abs(b.x - dragA.x) * sc}px`;
  pv.style.height = `${Math.abs(b.y - dragA.y) * sc}px`;
};
$('field').onmouseup = e => {
  if (!tool || !dragA) return;
  const b = fieldPoint(e);
  const g = { x: Math.min(dragA.x, b.x), y: Math.min(dragA.y, b.y), w: Math.abs(b.x - dragA.x), h: Math.abs(b.y - dragA.y) };
  dragA = null;
  $('preview').style.display = 'none';
  if (g.w < SNAP || g.h < SNAP) return;
  if (!stagedRoom) stagedRoom = { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] };
  if (tool.startsWith('floor:')) (stagedRoom.floors = stagedRoom.floors || []).push({ p: tool.split(':')[1], ...g });
  else if (tool.startsWith('struct:')) (stagedRoom.structs = stagedRoom.structs || []).push({ t: tool.split(':')[1], ...g });
  stagedDirty = true;
  drawStaging(App.view);
};

function fieldPoint(e) {
  const r = $('roomcanvas').getBoundingClientRect();
  const sc = fieldScale();
  return { x: Math.round((e.clientX - r.left) / sc / SNAP) * SNAP, y: Math.round((e.clientY - r.top) / sc / SNAP) * SNAP };
}

function eraseAt(p) {
  if (!stagedRoom) return;
  for (const key of ['props', 'structs', 'floors']) {
    const arr = stagedRoom[key] || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const g = arr[i];
      const w = g.w || 24, h = g.h || 24;
      if (p.x >= g.x && p.x <= g.x + w && p.y >= g.y && p.y <= g.y + h) { arr.splice(i, 1); stagedDirty = true; drawStaging(App.view); return; }
    }
  }
}

function placeStamp(p) {
  if (!stagedRoom) stagedRoom = { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] };
  if (stamp.stampKind === 'prop') {
    (stagedRoom.props = stagedRoom.props || []).push({ t: stamp.t, x: p.x, y: p.y });
  } else {
    const piece = { id: `pc${Date.now()}${Math.floor(Math.random() * 999)}`, kind: stamp.kind, g: stamp.g, x: p.x, y: p.y, hidden: false };
    if (stamp.sprite) { piece.sprite = stamp.sprite; piece.name = stamp.sprite.split('/').pop().replace(/\.[a-z]+$/i, ''); }
    if (stamp.kind === 'pickup') {
      if (stamp.credits) { piece.credits = +(prompt('Credits amount?', '40') || 0); piece.name = `${piece.credits} credits`; }
      else { piece.item = prompt('Item name?', 'Luck Ticket') || 'Luck Ticket'; piece.count = 1; piece.name = piece.item; }
    }
    if (stamp.kind === 'sign') { piece.text = prompt('Sign text?', '…') || ''; piece.name = 'sign'; }
    if (stamp.kind === 'keypad') { piece.code = prompt('Staged code?', '1234') || ''; piece.name = 'keypad'; }
    if (stamp.kind === 'trigger') { piece.encounter = prompt('Encounter name to launch on contact?', '') || ''; piece.name = `trigger:${piece.encounter}`; }
    if (stamp.kind === 'door') { piece.name = prompt('Door label?', 'door') || 'door'; }
    (stagedRoom.pieces = stagedRoom.pieces || []).push(piece);
  }
  stagedDirty = true;
  drawStaging(App.view);
}

// ---------------------------------------------------------------- battle interactions
function enemyClicked(e) {
  if (e.dead) return;
  if (e.control !== 'gm') { announce(`${e.name} is AI-controlled — click its tag to take the reins.`); return; }
  if (!e.holding) { announce(`${e.name}'s gauge is still filling.`); return; }
  const st = $('estack');
  st.innerHTML = '';
  st.style.left = '30%'; st.style.top = '18%';
  for (const pr of e.prompts || []) {
    const b = el('button', { class: 'eact prompt', style: pr.ready ? '' : 'opacity:.55' },
      (pr.ready ? '▶ ' : '') + pr.label,
      el('small', {}, pr.ready ? 'scripted — fire it, or ignore it' : 'condition not met — yours to call early anyway'));
    b.onclick = () => { st.classList.remove('open'); gm('enemy-action', { enemyId: e.id, action: { kind: 'trigger', triggerId: pr.id } }); };
    st.appendChild(b);
  }
  for (const mv of e.moves) {
    const fx = (App.staticData.scripts.moveEffects[e.template] || {})[mv.n] || {};
    if (fx.scripted) continue;
    const b = el('button', { class: 'eact' }, mv.n, el('small', {}, `${mv.t} · MP ${mv.mp} · acc ${mv.acc ?? '—'}${mv.fx ? ' · ' + mv.fx : ''}`));
    b.onclick = () => {
      st.classList.remove('open');
      if (mv.t === 'one') {
        pendingAction = { enemyId: e.id, kind: 'move', move: mv.n };
        setLeftMode('party');
        render(App.view);
        announce(`${mv.n} — click a party sprite on the field (or the PARTY column).`);
      } else {
        gm('enemy-action', { enemyId: e.id, action: { kind: 'move', move: mv.n } });
      }
    };
    st.appendChild(b);
  }
  const d = el('button', { class: 'eact' }, 'Defend', el('small', {}, '+25 DEF until next fill'));
  d.onclick = () => { st.classList.remove('open'); gm('enemy-action', { enemyId: e.id, action: { kind: 'defend' } }); };
  st.appendChild(d);
  const pool = App.view.battle.pool || {};
  const names = Object.keys(pool).filter(n => pool[n] > 0);
  const o = el('button', { class: 'eact' }, 'Objects', el('small', {}, names.length ? names.map(n => `${n} ×${pool[n]}`).join(' · ') : 'pool is empty'));
  o.onclick = () => {
    st.innerHTML = '';
    for (const n of names) {
      const item = App.staticData.items.catalog.find(c => c.name === n);
      const hostile = item && item.effect.type === 'attack';
      const bi = el('button', { class: 'eact' }, `${n} ×${pool[n]}`, el('small', {}, item ? item.desc : ''));
      bi.onclick = () => {
        st.classList.remove('open');
        if (hostile) {
          pendingAction = { enemyId: e.id, kind: 'pool-item', item: n };
          setLeftMode('party');
          render(App.view);
          announce(`${n} — click a party sprite on the field (or the PARTY column).`);
        } else {
          // friendly pool item: target one of the GM's own creatures
          pendingAction = { enemyId: e.id, kind: 'pool-item-friendly', item: n };
          announce(`${n} — click one of your creatures in the strip.`);
        }
      };
      st.appendChild(bi);
    }
    if (!names.length) st.appendChild(el('button', { class: 'eact' }, 'pool is empty'));
    st.classList.add('open');
  };
  st.appendChild(o);
  st.classList.add('open');
}

// ---------------------------------------------------------------- STRIP (enemy seats)
function renderStrip(view) {
  const strip = $('strip');
  strip.innerHTML = '';
  if (!view.battle) {
    strip.appendChild(el('div', { style: 'padding:12px 16px;font-size:14px;color:#666;letter-spacing:2px' },
      'NO ENCOUNTER RUNNING — BUILD ONE IN THE ENCOUNTER TAB'));
    return;
  }
  const b = view.battle;
  for (const e of b.enemies) {
    const pc = el('div', { class: 'pc' + (e.dead ? ' deadslot' : '') + (e.control === 'gm' ? ' gmown' : ''), 'data-id': e.id });
    const tag = el('span', { class: 'ctl' + (e.control === 'ai' ? ' ai' : '') }, e.control.toUpperCase());
    tag.onclick = ev => { ev.stopPropagation(); gm('toggle-control', { enemyId: e.id }); };
    pc.appendChild(el('div', { class: 'pname' }, `${e.name} `, tag));
    pc.appendChild(el('div', { class: 'nums' },
      el('div', { class: 'num' }, `${e.hp}`, el('em', {}, 'hp'), el('i', { style: `width:${Math.round(e.hp / e.maxHp * 100)}%` })),
      el('div', { class: 'num cp' }, `${e.cp == null ? '∞' : e.cp}`, el('em', {}, 'cp'))));
    pc.appendChild(el('div', { class: 'gauge' + (e.critCharged ? ' critcharge' : '') + (e.holding ? ' held' : '') }, el('i', { style: `width:${Math.round(e.gauge * 100)}%`, 'data-egid': e.id })));
    const icons = el('div', { class: 'picons' });
    if (e.defending) icons.appendChild(el('span', { class: 'icn up' }, '▲DEF'));
    for (const s of e.statuses) icons.appendChild(statusChip(s));
    for (const sc of e.statChanges) icons.appendChild(statChangeChip(sc));
    pc.appendChild(icons);
    pc.onclick = () => {
      if (pendingPilot && pendingPilot.wants === 'enemy' && !e.dead) return pilotTarget(e);
      if (pendingAction && pendingAction.kind === 'pool-item-friendly') {
        const a = pendingAction; pendingAction = null;
        gm('enemy-action', { enemyId: a.enemyId, action: { kind: 'pool-item', item: a.item, targetId: e.id } });
        return;
      }
      enemyClicked(e);
    };
    pc.oncontextmenu = ev => { ev.preventDefault(); instanceEditor(e); };
    strip.appendChild(pc);
  }
  for (const w of b.waves || []) {
    if (w.spawned) continue;
    const cell = el('div', { class: 'pc waveslot' },
      el('div', { class: 'pname', style: 'color:#666' }, `WAVE ${w.index + 1}`),
      el('div', { class: 'picons' }, el('span', { class: 'icn' }, `${w.count} queued · ${w.trigger}`)));
    const btn = el('button', { class: 'qbtn', style: 'margin-top:4px' }, 'SPAWN NOW');
    btn.onclick = () => gm('spawn-wave', { index: w.index });
    cell.appendChild(btn);
    strip.appendChild(cell);
  }
  const poolCell = el('div', { class: 'pc waveslot' }, el('div', { class: 'pname', style: 'color:var(--amber)' }, 'OBJECTS'));
  const icons = el('div', { class: 'picons' });
  const pool = b.pool || {};
  const names = Object.keys(pool).filter(n => pool[n] > 0);
  if (names.length) for (const n of names) icons.appendChild(el('span', { class: 'icn' }, `${n} ×${pool[n]}`));
  else icons.appendChild(el('span', { class: 'icn', style: 'color:#555' }, 'empty'));
  poolCell.appendChild(icons);
  strip.appendChild(poolCell);
  const endCell = el('div', { class: 'pc waveslot' });
  const endBtn = el('button', { class: 'qbtn' }, b.over ? 'CLOSE ENCOUNTER' : 'END ENCOUNTER');
  endBtn.onclick = () => gm('end-encounter');
  endCell.appendChild(endBtn);
  strip.appendChild(endCell);
}

function instanceEditor(e) {
  const st = $('estack');
  st.innerHTML = '';
  st.style.left = '34%'; st.style.top = '24%';
  st.appendChild(el('div', { class: 'eact prompt', style: 'cursor:default' },
    `EDIT ${e.name.toUpperCase()}`, el('small', {}, 'this creature only — template untouched')));
  const box = el('div', { style: 'background:var(--blk);padding:12px 16px;display:flex;flex-direction:column;gap:8px;transform:skewX(-4deg)' });
  const mkRow = (lbl, node) => el('div', { style: 'display:flex;align-items:center;gap:10px;transform:skewX(4deg)' },
    el('span', { style: 'font-size:13px;letter-spacing:1px;color:#999;width:70px' }, lbl), node);
  const hpI = el('input', { type: 'number', min: '0', value: String(e.hp), style: 'width:110px;background:#111;border:1px solid #333;color:var(--wht);padding:4px 8px' });
  box.appendChild(mkRow(`HP /${e.maxHp}`, hpI));
  const szSel = el('select', { style: 'background:#111;border:1px solid #333;color:var(--wht);padding:4px 8px' });
  for (const s of ENC_SIZES) szSel.appendChild(el('option', { value: String(s), selected: (e.size || 1) === s ? '' : undefined }, `×${s}`));
  box.appendChild(mkRow('SIZE', szSel));
  const bar = el('div', { style: 'display:flex;gap:8px;transform:skewX(4deg)' });
  const apply = el('button', { class: 'qbtn gmctl' }, 'APPLY');
  apply.onclick = () => {
    gm('edit-instance', { enemyId: e.id, patch: { hp: Math.max(0, +hpI.value || 0), size: +szSel.value } });
    st.classList.remove('open');
  };
  const cancel = el('button', { class: 'qbtn' }, 'CANCEL');
  cancel.onclick = () => st.classList.remove('open');
  bar.append(apply, cancel);
  box.appendChild(bar);
  st.appendChild(box);
  st.classList.add('open');
}

// enemy gauge animation
setInterval(() => {
  const view = App.view;
  if (!view || view.paused || !view.battle || view.battle.frozen || view.battle.over) return;
  const dt = (performance.now() - lastStateAt) / 1000;
  for (const e of view.battle.enemies) {
    for (const g of document.querySelectorAll(`[data-egid="${e.id}"]`)) {
      const w = e.holding || e.dead ? e.gauge : Math.min(1, e.gauge + dt / (e.gaugeS || 5));
      g.style.width = `${Math.round(w * 100)}%`;
    }
  }
  for (const pm of view.party) {
    const w = pm.holding || pm.down ? pm.gauge : Math.min(1, pm.gauge + dt / pm.gaugeSeconds);
    const g = document.querySelector(`[data-gid="${pm.id}"] i`);
    if (g) g.style.width = `${Math.round(w * 100)}%`;
    const g2 = document.querySelector(`[data-gid2="${pm.id}"]`);
    if (g2) g2.style.width = `${Math.round(w * 100)}%`;
  }
}, 120);

// ---------------------------------------------------------------- PANELS
function renderPanels() {
  let host = $('panels');
  host.innerHTML = '';
  for (const t of TABS) $(`tab-${t}`).classList.toggle('on', activeTab === t);
  if (!activeTab || !App.view) return;
  const panel = el('div', { class: 'gmpanel open' });
  host.appendChild(panel);
  ({
    Location: renderLocation, Enemies: renderEnemies, Encounter: renderEncounter,
    Items: renderItems, Players: renderPlayers, Shop: renderShopGate,
    Jukebox: renderJukebox, Stingers: renderStingers, Cutscene: renderCutscene, System: renderSystem,
  })[activeTab](panel, App.view);
}

// ---- Location
function renderLocation(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'LOCATION'));
  p.appendChild(el('div', { class: 'ps' }, 'STAGE A ROOM, SAVE IT, TELEPORT THE PARTY IN LATER — PLACEMENTS ARE SILENT, HIDDEN PIECES STAY HIDDEN. ONE CLICK = ONE POISON TICK.'));
  const zones = ['Zone 1', 'Zone 2', 'Zone 3', 'The Room', 'Purified'];
  const roomNames = view.rooms || [];
  for (const z of zones) {
    p.appendChild(el('div', { class: 'dsec' }, z.toUpperCase()));
    const row = el('div', { class: 'locrow' });
    const inZone = roomNames.filter(r => (App.view.notes[`roomzone:${r}`] || 'Zone 1') === z || (z === 'Zone 1' && !App.view.notes[`roomzone:${r}`]));
    for (const name of new Set([...(z === view.location.zone ? [view.location.name] : []), ...inZone])) {
      if (name === 'lobby') continue;
      const b = el('button', { class: 'loc' + (view.location.name === name ? ' here' : '') }, name);
      b.onclick = () => gm('set-location', { zone: z, name });
      row.appendChild(b);
    }
    const add = el('button', { class: 'loc', style: 'border-style:dashed;color:#888' }, '+ new');
    add.onclick = () => {
      const name = prompt(`New location in ${z}:`);
      if (!name) return;
      gm('note-set', { key: `roomzone:${name}`, text: z });
      gm('room-save', { location: name, room: { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] } });
      gm('set-location', { zone: z, name });
    };
    row.appendChild(add);
    p.appendChild(row);
  }
  const cur = view.location.name;
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, `THIS ROOM — ${cur}`),
    labeled('Palette', paletteSelect(stagedRoom?.palette, v => { ensureRoom(); stagedRoom.palette = v || undefined; stagedDirty = true; })),
    labeled('Music', musicSelect(stagedRoom?.music, v => { ensureRoom(); stagedRoom.music = v || undefined; stagedDirty = true; })),
    labeled('Size', (() => {
      const wI = el('input', { type: 'number', value: stagedRoom?.w || 768, style: 'width:70px' });
      const hI = el('input', { type: 'number', value: stagedRoom?.h || 576, style: 'width:70px' });
      wI.onchange = () => { ensureRoom(); stagedRoom.w = +wI.value; stagedDirty = true; };
      hI.onchange = () => { ensureRoom(); stagedRoom.h = +hI.value; stagedDirty = true; };
      return el('span', {}, wI, ' × ', hI);
    })()),
    (() => {
      const b = el('button', { class: 'bigbtn', style: 'margin-top:8px' }, `SAVE ROOM — ${cur}`);
      b.onclick = () => { saveRoom(); renderPanels(); };
      return b;
    })(),
    (() => {
      const b = el('button', { class: 'bigbtn ghost', style: 'margin-left:8px' }, 'CLONE ROOM…');
      b.onclick = () => { const to = prompt('Clone this room as:'); if (to) gm('room-clone', { from: cur, to }); };
      return b;
    })(),
    noteBox(`room:${cur}`, view)));
  const rest = el('button', { class: 'bigbtn', style: 'margin-top:10px' }, '✚ REST ZONE — FULL RESTORE');
  rest.onclick = () => gm('rest');
  p.appendChild(rest);
}

function ensureRoom() { if (!stagedRoom) stagedRoom = { w: 768, h: 576, floors: [], structs: [], props: [], pieces: [] }; }
function labeled(lbl, node) { return el('div', { class: 'statrow' }, el('span', { class: 'sl' }, lbl), node); }

function paletteSelect(cur, onchange) {
  const s = el('select', {});
  s.appendChild(el('option', { value: '' }, '(zone default)'));
  for (const name of Object.keys(App.staticData.palettes)) {
    if (name.startsWith('_')) continue;
    const o = el('option', { value: name }, name);
    if (cur === name) o.selected = true;
    s.appendChild(o);
  }
  s.onchange = () => onchange(s.value);
  return s;
}

const MUSIC_ZONES = ['Zone 1', 'Zone 2', 'Zone 3', 'The Room', 'Purified'];

function musicLibrary() {
  // heading -> files, honoring the GM's re-shelving (folders are layout, never restriction)
  const zones = (App.view && App.view.musicZones) || {};
  const tree = App.art ? App.art.tree.music : {};
  const byHeading = {};
  for (const [folder, files] of Object.entries(tree)) {
    for (const f of files) {
      const heading = zones[f] || folder;
      (byHeading[heading] = byHeading[heading] || []).push(f);
    }
  }
  const order = [...MUSIC_ZONES.filter(z => byHeading[z]), ...Object.keys(byHeading).filter(h => !MUSIC_ZONES.includes(h)).sort()];
  return { byHeading, order };
}

function trackName(f) { return f.split('/').pop().replace(/\.[a-z0-9]+$/i, ''); }

function musicSelect(cur, onchange) {
  const s = el('select', {});
  s.appendChild(el('option', { value: '' }, '(none)'));
  const { byHeading, order } = musicLibrary();
  for (const heading of order) {
    const og = el('optgroup', { label: heading });
    for (const f of byHeading[heading]) {
      const o = el('option', { value: f }, trackName(f));
      if (cur === f) o.selected = true;
      og.appendChild(o);
    }
    s.appendChild(og);
  }
  s.onchange = () => onchange(s.value);
  return s;
}

function noteBox(key, view) {
  const wrap = el('div', { style: 'margin-top:10px' });
  wrap.appendChild(el('div', { class: 'sl', style: 'font-size:9px;color:#777;letter-spacing:2px;margin-bottom:4px' }, 'GM NOTE'));
  const ta = el('textarea', { class: 'notebox' });
  ta.value = view.notes[key] || '';
  ta.onchange = () => gm('note-set', { key, text: ta.value });
  wrap.appendChild(ta);
  return wrap;
}

// ---- Enemies
function renderEnemies(p, view) {
  if (editingTmpl) return renderEnemyEditor(p, view);
  p.appendChild(el('div', { class: 'ph' }, 'ENEMIES'));
  p.appendChild(el('div', { class: 'ps' }, 'TEMPLATES FROM THE CAMPAIGN BESTIARY — CLICK TO EDIT · EDITS SAVE AS CAMPAIGN OVERLAY, THE DATA FILE IS UNTOUCHED'));
  const cards = el('div', { class: 'cards' });
  const all = [...App.staticData.bestiary];
  for (const name of view.templates || []) {
    if (!all.find(e => e.name === name)) all.push({ name, custom: true, ...( {} ) });
  }
  for (const e of all) {
    const overlay = (view.templates || []).includes(e.name);
    const card = el('div', { class: 'card' },
      el('span', { class: 'ce' }, (e.element || '?').toUpperCase()),
      el('div', {}, artEl(enemyArt(e.name), e.name, 40)),
      el('div', { class: 'cn' }, e.name + (overlay ? ' ·' : '')),
      el('div', { class: 'cs' }, `HP ${e.hp ?? '?'} · dmg ${e.dmg_per_action ?? '?'} · ${e.gauge_s ?? '?'}s · ${e.zone || 'custom'}${e.archetype ? ' · ' + e.archetype : ''}`));
    card.onclick = () => { editingTmpl = JSON.parse(JSON.stringify({ ...e })); renderPanels(); };
    cards.appendChild(card);
  }
  const fresh = el('div', { class: 'card new' }, '+ CREATE NEW');
  fresh.onclick = () => {
    editingTmpl = {
      name: 'New Enemy', element: 'Smoke', hp: 100, dmg_per_action: 10, gauge_s: 5.0, def: 0, res: 8, lck: 3,
      group: 1, zone: 'custom', archetype: 'custom',
      status_tiers: { tiers: Object.fromEntries(['Poisoned', 'Blinded', 'Muted', 'Palsied', 'Asleep', 'Furious', 'Madness'].map(s => [s, 'neutral'])) },
      moves: [{ n: 'Attack', t: 'one', mp: 1.0, acc: 95, fx: null }],
    };
    renderPanels();
  };
  cards.appendChild(fresh);
  p.appendChild(cards);
}

function renderEnemyEditor(p, view) {
  const t = editingTmpl;
  const back = el('button', { class: 'bigbtn ghost' }, '← LIBRARY');
  back.onclick = () => { editingTmpl = null; renderPanels(); };
  p.appendChild(back);
  const nameI = el('input', { type: 'text', value: t.name, style: 'font-family:var(--disp);text-transform:uppercase;font-size:26px;background:transparent;border:0;border-bottom:2px solid #333;color:var(--wht);width:320px;margin-left:14px' });
  nameI.onchange = () => { t.name = nameI.value; };
  p.appendChild(nameI);
  const grid = el('div', { class: 'edgrid', style: 'margin-top:14px' });
  const stats = el('div', { class: 'edsec' }, el('h4', {}, 'STATS'));
  const statDefs = [['hp', 'HP', 10], ['dmg_per_action', 'DMG/ACT', 2], ['gauge_s', 'GAUGE s', 0.2], ['def', 'DEF', 5], ['res', 'RES', 2], ['lck', 'LCK', 1], ['group', 'GROUP', 1], ['size', 'SIZE ×', 0.25]];
  for (const [key, label, step] of statDefs) {
    stats.appendChild(labeled(label, stepper(t[key] ?? (key === 'size' ? 1 : 0), step, v => { t[key] = v; })));
  }
  stats.appendChild(el('h4', { style: 'margin-top:12px' }, 'ELEMENT'));
  const ring = el('div', { class: 'elring' });
  for (const elName of RING) {
    const b = el('span', { class: 'el' + (t.element === elName ? ' on' : '') }, elName.toUpperCase());
    b.onclick = () => { t.element = elName; renderPanels(); };
    ring.appendChild(b);
  }
  stats.appendChild(ring);
  grid.appendChild(stats);

  const right = el('div', { class: 'edsec' }, el('h4', {}, 'STATUS TIERS — CLICK TO CYCLE V·N·L·S'));
  const tg = el('div', { class: 'tiergrid' });
  const tiers = (t.status_tiers = t.status_tiers || { tiers: {} }).tiers;
  const cycle = ['vulnerable', 'neutral', 'light_immune', 'strong_immune'];
  const letters = { vulnerable: 'V', neutral: 'N', light_immune: 'L', strong_immune: 'S' };
  for (const st of ['Poisoned', 'Blinded', 'Muted', 'Palsied', 'Asleep', 'Furious', 'Madness', 'Hasty', 'Taunted']) {
    const cur = tiers[st] || 'neutral';
    const cell = el('div', { class: 'tier' }, el('span', { class: 'tn' }, st.toUpperCase()), el('span', { class: `tv ${letters[cur]}` }, letters[cur]));
    cell.onclick = () => { tiers[st] = cycle[(cycle.indexOf(tiers[st] || 'neutral') + 1) % 4]; renderPanels(); };
    tg.appendChild(cell);
  }
  right.appendChild(tg);
  right.appendChild(el('h4', { style: 'margin-top:12px' }, 'COMPETENCES'));
  for (const mv of t.moves || []) {
    const row = el('div', { class: 'mv' },
      el('span', { class: 'mn' }, mv.n),
      el('span', { class: 'mstat' }, 'TGT ', (() => { const s = el('select', {}); for (const o of ['one', 'all', 'self']) { const oo = el('option', { value: o }, o); if (mv.t === o) oo.selected = true; s.appendChild(oo); } s.onchange = () => mv.t = s.value; return s; })()),
      el('span', { class: 'mstat' }, 'MP ', stepper(mv.mp, 0.1, v => mv.mp = v)),
      el('span', { class: 'mstat' }, 'ACC ', stepper(mv.acc ?? 0, 1, v => mv.acc = v || null)),
      el('span', { class: 'mstat', style: 'flex-basis:100%' }, mv.fx ? `fx: ${mv.fx}` : ''));
    const x = el('button', { class: 'qx' }, '×');
    x.onclick = () => { t.moves = t.moves.filter(m => m !== mv); renderPanels(); };
    row.appendChild(x);
    right.appendChild(row);
  }
  const addMv = el('button', { class: 'addwave' }, '+ ADD COMPETENCE');
  addMv.onclick = () => {
    const n = prompt('Move name?');
    if (!n) return;
    (t.moves = t.moves || []).push({ n, t: 'one', mp: 1.0, acc: 95, fx: prompt('Effect note (fx string, blank for plain damage):') || null });
    renderPanels();
  };
  right.appendChild(addMv);
  grid.appendChild(right);
  p.appendChild(grid);
  p.appendChild(noteBox(`tmpl:${t.name}`, view));
  const bar = el('div', { style: 'margin-top:14px;display:flex;gap:10px' });
  const save = el('button', { class: 'bigbtn' }, 'SAVE TEMPLATE');
  save.onclick = () => { gm('template-save', { name: t.name, tmpl: t }); editingTmpl = null; renderPanels(); };
  const clone = el('button', { class: 'bigbtn ghost' }, 'CLONE AS…');
  clone.onclick = () => { const to = prompt('Clone as:', t.name + ' (variant)'); if (to) { const c = JSON.parse(JSON.stringify(t)); c.name = to; gm('template-save', { name: to, tmpl: c }); } };
  const discard = el('button', { class: 'bigbtn ghost' }, 'DISCARD');
  discard.onclick = () => { editingTmpl = null; renderPanels(); };
  bar.append(save, clone, discard);
  p.appendChild(bar);
}

function stepper(val, step, onchange) {
  const wrap = el('span', { class: 'step' });
  const v = el('span', { class: 'v' }, `${val}`);
  const mk = d => {
    const b = el('button', {}, d > 0 ? '+' : '−');
    b.onclick = () => {
      let n = parseFloat(v.textContent) + d;
      if (step % 1 !== 0) n = Math.round(n * 10) / 10;
      n = Math.max(0, n);
      v.textContent = n;
      onchange(n);
    };
    return b;
  };
  wrap.append(mk(-step), v, mk(step));
  return wrap;
}

// ---- Encounter
function blankEnc() {
  return { name: 'encounter', waves: [{ trigger: 'launch', queue: [] }], pool: {}, cutpurseTable: [], backdrop: null, palette: null, music: null };
}

function renderEncounter(p, view) {
  enc = enc || blankEnc();
  p.appendChild(el('div', { class: 'ph' }, 'ENCOUNTER'));
  p.appendChild(el('div', { class: 'ps' }, 'BUILD THE QUEUE — LAUNCH WHEN THE PARTY WALKS IN. WAVES SPAWN AT LAUNCH, ON THE PREVIOUS WAVE\'S DEATH, OR ON YOUR CLICK.'));
  const grid = el('div', { style: 'display:grid;grid-template-columns:240px 1fr;gap:18px' });

  // library
  const lib = el('div', {});
  lib.appendChild(el('div', { class: 'ps' }, 'ADD FROM LIBRARY'));
  const zoneSel = el('select', { style: 'margin-bottom:8px;width:100%' });
  for (const z of ['Zone 1', 'Zone 2', 'Zone 3', 'The Room', 'Purified Zones & Superbosses', 'custom']) zoneSel.appendChild(el('option', { value: z }, z));
  lib.appendChild(zoneSel);
  const libList = el('div', {});
  const fillLib = () => {
    libList.innerHTML = '';
    const all = [...App.staticData.bestiary.filter(e => e.zone === zoneSel.value), ...(zoneSel.value === 'custom' ? (view.templates || []).map(n => ({ name: n, hp: '?' })) : [])];
    for (const e of all) {
      const c = el('div', { class: 'card', style: 'margin-bottom:6px' }, el('div', { class: 'cn' }, e.name), el('div', { class: 'cs' }, `HP ${e.hp}${e.group ? ' · ×' + e.group + ' canon group' : ''}`));
      c.onclick = () => { enc.waves[enc.waves.length - 1].queue.push({ template: e.name, control: 'ai', slot: null, drop: { type: 'none' } }); renderPanels(); };
      libList.appendChild(c);
    }
  };
  zoneSel.onchange = fillLib;
  fillLib();
  lib.appendChild(libList);
  grid.appendChild(lib);

  // builder
  const right = el('div', {});
  labeledRow(right, 'Name', (() => { const i = el('input', { type: 'text', value: enc.name }); i.onchange = () => enc.name = i.value; return i; })());
  labeledRow(right, 'Backdrop', (() => {
    const s = el('select', {});
    s.appendChild(el('option', { value: '' }, '(zone chrome only)'));
    for (const f of (App.art ? App.art.tree.backdrops : [])) {
      const o = el('option', { value: f }, f.split('/').pop());
      if (enc.backdrop === f) o.selected = true;
      s.appendChild(o);
    }
    s.onchange = () => enc.backdrop = s.value || null;
    return s;
  })());
  labeledRow(right, 'Palette', paletteSelect(enc.palette, v => enc.palette = v || null));
  labeledRow(right, 'Music', musicSelect(enc.music, v => enc.music = v || null));

  enc.waves.forEach((w, wi) => {
    const wave = el('div', { class: 'wave' });
    const trigSel = el('select', {});
    for (const tr of ['launch', 'prev-death', 'manual']) {
      const o = el('option', { value: tr }, tr === 'launch' ? 'SPAWNS AT LAUNCH' : tr === 'prev-death' ? 'ON PREVIOUS WAVE DEATH' : 'MANUAL TRIGGER');
      if ((w.trigger || (wi === 0 ? 'launch' : 'prev-death')) === tr) o.selected = true;
      trigSel.appendChild(o);
    }
    trigSel.onchange = () => w.trigger = trigSel.value;
    wave.appendChild(el('h4', {}, `WAVE ${wi + 1}`, trigSel, (() => {
      const x = el('button', { class: 'qx' }, '×');
      x.onclick = () => { enc.waves.splice(wi, 1); if (!enc.waves.length) enc.waves.push({ trigger: 'launch', queue: [] }); renderPanels(); };
      return x;
    })()));
    for (const q of w.queue) wave.appendChild(encRow(q, w));
    right.appendChild(wave);
  });
  const addWave = el('button', { class: 'addwave' }, '+ ADD WAVE');
  addWave.onclick = () => { enc.waves.push({ trigger: 'prev-death', queue: [] }); renderPanels(); };
  right.appendChild(addWave);

  // enemy pool + cutpurse table
  const poolSec = el('div', { class: 'wave' });
  poolSec.appendChild(el('h4', {}, 'ENEMY OBJECTS', el('span', { style: 'font-size:9px;color:#666' }, 'SHARED POOL — ANY CREATURE CAN SPEND A TURN ON THESE · URSA SHOT STEALS FROM HERE')));
  const poolRow = el('div', { class: 'grant' });
  for (const it of App.staticData.items.catalog.filter(i => i.priceZ1 != null || i.name === "Abaddon's Meat")) {
    const b = el('button', {}, `+ ${it.name}`);
    b.onclick = () => { enc.pool[it.name] = (enc.pool[it.name] || 0) + 1; renderPanels(); };
    poolRow.appendChild(b);
  }
  poolSec.appendChild(poolRow);
  const chips = el('div', { class: 'picons', style: 'margin-top:8px' });
  for (const [n, cnt] of Object.entries(enc.pool)) if (cnt > 0) {
    const chip = el('span', { class: 'icn', style: 'cursor:pointer' }, `${n} ×${cnt}`);
    chip.onclick = () => { enc.pool[n]--; renderPanels(); };
    chips.appendChild(chip);
  }
  poolSec.appendChild(chips);
  poolSec.appendChild(el('div', { class: 'ps', style: 'margin-top:10px' }, 'URSA SHOT AND CUTPURSE BOTH STEAL FROM THIS POOL — STOCKING IT SETS THE FIGHT\'S STEAL TABLE AND THE BANDIT\'S BONUS DROPS.'));
  right.appendChild(poolSec);

  const bar = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  const launch = el('button', { class: 'bigbtn' }, 'LAUNCH ENCOUNTER');
  launch.onclick = () => { gm('launch-encounter', { def: enc }); activeTab = null; renderPanels(); };
  const saveB = el('button', { class: 'bigbtn ghost' }, 'SAVE TO LIBRARY');
  saveB.onclick = () => gm('encounter-save', { name: enc.name, def: enc });
  const loadSel = el('select', {});
  loadSel.appendChild(el('option', { value: '' }, 'load saved…'));
  for (const n of view.encounters || []) loadSel.appendChild(el('option', { value: n }, n));
  loadSel.onchange = async () => {
    if (!loadSel.value) return;
    // encounters are in gm view only by name; ask server to launch by name or clone locally via notes — simplest: keep local copy keyed in localStorage
    const saved = JSON.parse(localStorage.getItem('off-encs') || '{}')[loadSel.value];
    if (saved) { enc = JSON.parse(JSON.stringify(saved)); renderPanels(); }
    else { gm('launch-encounter', { name: loadSel.value }); activeTab = null; renderPanels(); }
  };
  const dup = el('button', { class: 'bigbtn ghost' }, 'CLONE');
  dup.onclick = () => { enc = JSON.parse(JSON.stringify(enc)); enc.name += ' (copy)'; renderPanels(); };
  bar.append(launch, saveB, loadSel, dup);
  right.appendChild(bar);
  right.appendChild(noteBox(`enc:${enc.name}`, view));
  grid.appendChild(right);
  p.appendChild(grid);
  // remember saved encounters locally too (for re-editing)
  const encs = JSON.parse(localStorage.getItem('off-encs') || '{}');
  encs[enc.name] = enc;
  localStorage.setItem('off-encs', JSON.stringify(encs));
}

function dropLabel(d) {
  if (!d || d.type === 'none') return 'DROP: nothing';
  if (d.type === 'item') return `DROP: ${d.name}`;
  return `DROP: ${d.amount} credits`;
}

// One enemy in the encounter queue: a compact row of selects, expanding into
// stat / drop / carried-item tables. Everything edits this instance only —
// the template is never touched. Open state survives re-renders.
const encOpen = new WeakSet();
const ENC_SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const ELEMENTS = ['Plastic', 'Metal', 'Smoke', 'Meat', 'Sugar'];

function encRow(q, w) {
  const tmpl = App.staticData.bestiary.find(b => b.name === q.template) || {};
  const modified = !!((q.overrides && Object.keys(q.overrides).length) ||
    (q.items && Object.keys(q.items).length) || (q.drop && q.drop.type !== 'none'));
  const row = el('div', { class: 'qrow' });
  row.appendChild(el('span', { class: 'qn' }, q.name || q.template));

  const slotSel = el('select', { title: 'field position (auto = next open spot)' });
  slotSel.appendChild(el('option', { value: '' }, 'SLOT auto'));
  for (let s = 1; s <= 8; s++) slotSel.appendChild(el('option', { value: String(s), selected: q.slot === s ? '' : undefined }, `SLOT ${s}`));
  slotSel.onchange = () => q.slot = slotSel.value ? +slotSel.value : null;
  row.appendChild(slotSel);

  const sizeSel = el('select', { title: 'on-screen size' });
  for (const s of ENC_SIZES) sizeSel.appendChild(el('option', { value: String(s), selected: (q.size ?? 1) === s ? '' : undefined }, `SIZE ×${s}`));
  sizeSel.onchange = () => q.size = +sizeSel.value;
  row.appendChild(sizeSel);

  const ctlB = el('button', { class: 'qbtn' + (q.control === 'gm' ? ' gmctl' : ''), title: 'AI acts on its own · GM waits for your clicks' }, q.control.toUpperCase());
  ctlB.onclick = () => { q.control = q.control === 'ai' ? 'gm' : 'ai'; renderPanels(); };
  row.appendChild(ctlB);

  const open = encOpen.has(q);
  const det = el('button', { class: 'qbtn' + (modified && !open ? ' mod' : '') },
    (open ? '▾ ' : '▸ ') + (modified ? 'EDITED' : 'STATS · DROP · ITEMS'));
  det.onclick = () => { open ? encOpen.delete(q) : encOpen.add(q); renderPanels(); };
  row.appendChild(det);

  const x = el('button', { class: 'qx' }, '×');
  x.onclick = () => { w.queue = w.queue.filter(z => z !== q); renderPanels(); };
  row.appendChild(x);

  if (open) row.appendChild(encDetail(q, tmpl));
  return row;
}

function encDetail(q, tmpl) {
  const d = el('div', { class: 'qdetail' });

  // -- stat table: blank field = template value (shown as the placeholder)
  const stats = el('div', {});
  stats.appendChild(el('div', { class: 'qdh' }, 'STATS — BLANK USES TEMPLATE'));
  const FIELDS = [['hp', 'HP'], ['def', 'DEF'], ['res', 'RES'], ['lck', 'LUCK'], ['gauge_s', 'GAUGE (SEC)'], ['dmg_per_action', 'DMG / ACTION'], ['cp', 'CP']];
  for (const [k, lbl] of FIELDS) {
    const i = el('input', {
      type: 'number', step: 'any',
      placeholder: tmpl[k] != null ? String(tmpl[k]) : '—',
      value: q.overrides && q.overrides[k] != null ? String(q.overrides[k]) : '',
    });
    i.onchange = () => {
      q.overrides = q.overrides || {};
      if (i.value === '') delete q.overrides[k]; else q.overrides[k] = +i.value;
      if (!Object.keys(q.overrides).length) delete q.overrides;
    };
    stats.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, lbl), i));
  }
  const eSel = el('select', {});
  eSel.appendChild(el('option', { value: '' }, `template (${tmpl.element || 'none'})`));
  for (const elm of ELEMENTS) eSel.appendChild(el('option', { value: elm, selected: q.overrides && q.overrides.element === elm ? '' : undefined }, elm));
  eSel.onchange = () => {
    q.overrides = q.overrides || {};
    if (!eSel.value) delete q.overrides.element; else q.overrides.element = eSel.value;
    if (!Object.keys(q.overrides).length) delete q.overrides;
  };
  stats.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, 'ELEMENT'), eSel));
  d.appendChild(stats);

  // -- drop on death
  const drop = el('div', {});
  drop.appendChild(el('div', { class: 'qdh' }, 'DROP ON DEATH'));
  const kindSel = el('select', {});
  const kind = (q.drop && q.drop.type) || 'none';
  for (const [v, lbl] of [['none', 'nothing'], ['item', 'an item'], ['credits', 'credits']])
    kindSel.appendChild(el('option', { value: v, selected: kind === v ? '' : undefined }, lbl));
  kindSel.onchange = () => {
    q.drop = kindSel.value === 'item' ? { type: 'item', name: q.drop && q.drop.name || 'Luck Ticket' }
      : kindSel.value === 'credits' ? { type: 'credits', amount: q.drop && q.drop.amount || 40 }
      : { type: 'none' };
    renderPanels();
  };
  drop.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, 'DROPS'), kindSel));
  if (kind === 'item') {
    const itSel = el('select', {});
    for (const it of App.staticData.items.catalog)
      itSel.appendChild(el('option', { value: it.name, selected: q.drop.name === it.name ? '' : undefined }, it.name));
    itSel.onchange = () => q.drop.name = itSel.value;
    drop.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, 'ITEM'), itSel));
  }
  if (kind === 'credits') {
    const amt = el('input', { type: 'number', min: '0', value: String(q.drop.amount || 0) });
    amt.onchange = () => q.drop.amount = Math.max(0, +amt.value || 0);
    drop.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, 'AMOUNT'), amt));
  }
  d.appendChild(drop);

  // -- carried items (feed the shared enemy pool)
  const carry = el('div', {});
  carry.appendChild(el('div', { class: 'qdh' }, 'CARRIES — FEEDS THE ENEMY POOL'));
  for (const [name, cnt] of Object.entries(q.items || {})) {
    const cr = el('div', { class: 'carryrow' });
    const sel = el('select', {});
    for (const it of App.staticData.items.catalog)
      sel.appendChild(el('option', { value: it.name, selected: it.name === name ? '' : undefined }, it.name));
    sel.onchange = () => { delete q.items[name]; q.items[sel.value] = (q.items[sel.value] || 0) + cnt; renderPanels(); };
    const num = el('input', { type: 'number', min: '1', value: String(cnt) });
    num.onchange = () => q.items[name] = Math.max(1, +num.value || 1);
    const rm = el('button', { class: 'qx' }, '×');
    rm.onclick = () => { delete q.items[name]; if (!Object.keys(q.items).length) delete q.items; renderPanels(); };
    cr.append(sel, num, rm);
    carry.appendChild(cr);
  }
  const add = el('button', { class: 'qbtn' }, '+ CARRY ITEM');
  add.onclick = () => {
    q.items = q.items || {};
    const first = App.staticData.items.catalog.find(it => !(it.name in q.items));
    if (first) q.items[first.name] = 1;
    renderPanels();
  };
  carry.appendChild(add);
  carry.appendChild(el('div', { style: 'font-size:11px;color:#666;margin-top:6px;max-width:230px' }, 'Carried objects enter the shared pool any creature can spend a turn on — Ursa Shot and Cutpurse steal from it.'));
  d.appendChild(carry);

  return d;
}

function labeledRow(host, lbl, node) { host.appendChild(el('div', { class: 'statrow' }, el('span', { class: 'sl' }, lbl), node)); }

// ---- Items
function renderItems(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'ITEMS'));
  p.appendChild(el('div', { class: 'ps' }, 'GRANTS GO STRAIGHT TO THE SHARED PARTY INVENTORY · DEDUCT AND SET LIVE HERE TOO'));
  const undoRow = el('div', { style: 'display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap' });
  const credStep = stepper(20, 20, () => {});
  const grantC = el('button', { class: 'bigbtn', style: 'font-size:17px;padding:4px 16px' }, 'GRANT CREDITS');
  grantC.onclick = () => gm('grant-credits', { n: parseFloat(credStep.querySelector('.v').textContent) });
  const dedC = el('button', { class: 'bigbtn ghost', style: 'font-size:17px' }, 'DEDUCT');
  dedC.onclick = () => gm('grant-credits', { n: -parseFloat(credStep.querySelector('.v').textContent) });
  const setC = el('button', { class: 'bigbtn ghost', style: 'font-size:17px' }, 'SET…');
  setC.onclick = () => { const n = prompt('Set credits to:', view.credits); if (n != null) gm('set-credits', { n: +n }); };
  undoRow.append(el('span', { class: 'dfont', style: 'font-size:22px;color:var(--amber)' }, `CREDITS ${view.credits}`), credStep, grantC, dedC, setC);
  const halve = el('button', { class: 'bigbtn red', style: 'font-size:17px' }, 'HALVE CREDITS & CONSUMABLES (WIPE TOLL)');
  halve.onclick = () => gm('halve');
  undoRow.appendChild(halve);
  if (view.undo) {
    const u = el('button', { class: 'bigbtn ghost', style: 'font-size:15px' }, `UNDO: ${view.undo}`);
    u.onclick = () => gm('undo');
    undoRow.appendChild(u);
  }
  p.appendChild(undoRow);

  const grid = el('div', { class: 'igrid' });
  for (const it of App.staticData.items.catalog) {
    const n = view.inventory[it.name] || 0;
    const card = el('div', { class: 'icard' },
      el('div', { class: 'in' }, `${it.name} ×${n}`),
      el('div', { class: 'idsc' }, it.desc));
    const g = el('div', { class: 'grant' });
    for (const [lbl, d] of [['+1', 1], ['+5', 5], ['−1', -1]]) {
      const b = el('button', {}, lbl);
      b.onclick = () => gm('grant-item', { name: it.name, n: d });
      g.appendChild(b);
    }
    const setB = el('button', {}, 'SET');
    setB.onclick = () => { const v = prompt(`${it.name} count:`, n); if (v != null) gm('set-item', { name: it.name, n: +v }); };
    g.appendChild(setB);
    card.appendChild(g);
    grid.appendChild(card);
  }
  p.appendChild(grid);

  p.appendChild(el('div', { class: 'dsec', style: 'margin-top:16px' }, 'EQUIPMENT GRANTS'));
  const ggrid = el('div', { class: 'igrid' });
  for (const [cat, def] of Object.entries(App.staticData.gear.categories)) {
    const card = el('div', { class: 'icard' }, el('div', { class: 'in' }, cat), el('div', { class: 'idsc' }, `${def.slot} · ${Array.isArray(def.wearers) ? def.wearers.join('/') : 'all'}`));
    const g = el('div', { class: 'grant', style: 'flex-direction:column' });
    for (const item of def.items || []) {
      const owned = view.gearOwned[item.name];
      const b = el('button', { style: owned ? 'color:var(--amber)' : '' }, `${owned ? '✓ ' : '+ '}${item.name} (${item.tier})`);
      b.onclick = () => gm('grant-gear', { name: item.name });
      g.appendChild(b);
    }
    card.appendChild(g);
    ggrid.appendChild(card);
  }
  p.appendChild(ggrid);
}

// ---- Players
function renderPlayers(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'PLAYERS'));
  p.appendChild(el('div', { class: 'ps' }, 'DIRECT EDITS — THE UNIVERSAL OVERRIDE. CLICK A STATUS TO STRIP IT. USE GENTLY, THEY WILL NOTICE'));
  if (view.undo) {
    const u = el('button', { class: 'bigbtn ghost', style: 'font-size:15px;margin-bottom:12px' }, `UNDO: ${view.undo}`);
    u.onclick = () => gm('undo');
    p.appendChild(u);
  }
  const cards = el('div', { class: 'pcards' });
  for (const m of view.party) {
    const card = el('div', { class: 'pcard' });
    card.appendChild(el('div', { class: 'pn' }, m.name));
    card.appendChild(el('div', { class: 'pl' }, `${m.id} · LV ${m.level} · ${(m.klass || '').toUpperCase()} · ${m.element.toUpperCase()}${m.down ? ' · DOWN' : ''}`));
    const icons = el('div', { class: 'picons', style: 'margin-bottom:6px' });
    for (const s of m.statuses) {
      const chip = statusChip(s);
      chip.style.cursor = 'pointer';
      chip.title += ' — click to strip';
      chip.onclick = () => gm('player-strip-status', { seat: m.id, status: s.name });
      icons.appendChild(chip);
    }
    for (const sc of m.statChanges) {
      const chip = statChangeChip(sc);
      chip.style.cursor = 'pointer';
      chip.onclick = () => gm('player-strip-statchange', { seat: m.id, stat: sc.stat, dir: sc.dir });
      icons.appendChild(chip);
    }
    card.appendChild(icons);
    card.appendChild(labeledPair('HP', m.hp, 10, v => gm('player-edit', { seat: m.id, patch: { hp: v } })));
    card.appendChild(labeledPair('CP', m.cp, 5, v => gm('player-edit', { seat: m.id, patch: { cp: v } })));
    card.appendChild(labeledPair('LEVEL', m.level, 1, v => gm('player-edit', { seat: m.id, patch: { level: v } })));
    const addRow = el('div', { class: 'statrow' });
    const stSel = el('select', {});
    for (const s of STATUSES) stSel.appendChild(el('option', { value: s }, s));
    const addB = el('button', { class: 'qbtn' }, '+STATUS');
    addB.onclick = () => gm('player-add-status', { seat: m.id, status: stSel.value });
    addRow.append(stSel, addB);
    const scSel = el('select', {});
    for (const s of ['ATK up', 'ATK down', 'DEF up', 'DEF down', 'AGI up', 'AGI down']) scSel.appendChild(el('option', { value: s }, s));
    const addSc = el('button', { class: 'qbtn' }, '+CHANGE');
    addSc.onclick = () => {
      const [stat, dir] = scSel.value.split(' ');
      const amount = +(prompt(`${stat} ${dir} amount (${stat === 'DEF' ? 'flat points' : '%'}):`, stat === 'DEF' ? 15 : 15) || 0);
      const turns = +(prompt('Turns:', 2) || 2);
      if (amount) gm('player-add-statchange', { seat: m.id, stat, dir, amount, turns });
    };
    addRow.append(scSel, addSc);
    card.appendChild(addRow);
    const elRow = el('div', { class: 'statrow' });
    const elSel = el('select', {});
    elSel.appendChild(el('option', { value: '' }, `element: native (${m.nativeElement})`));
    for (const elName of ['Plastic', 'Metal', 'Smoke', 'Meat']) {
      const o = el('option', { value: elName }, `element: ${elName}`);
      if (m.elementSet === elName) o.selected = true;
      elSel.appendChild(o);
    }
    elSel.onchange = () => gm('player-set-element', { seat: m.id, element: elSel.value || null });
    elRow.appendChild(elSel);
    const downB = el('button', { class: 'qbtn' }, m.down ? 'REVIVE' : 'DOWN');
    downB.onclick = () => gm('player-edit', { seat: m.id, patch: m.down ? { down: false, hp: Math.max(1, Math.round(m.maxHp * .35)) } : { down: true } });
    elRow.appendChild(downB);
    const benchB = el('button', { class: 'qbtn' + (m.benched ? ' gmctl' : '') }, m.benched ? 'REJOIN' : 'SIT OUT');
    benchB.onclick = () => gm('player-bench', { seat: m.id, benched: !m.benched });
    elRow.appendChild(benchB);
    // Absent characters don't launch into fights — this sends one in mid-battle (you pilot them).
    if (view.battle && !view.battle.over && !m.benched && !(view.battle.partySlots || []).includes(m.id)) {
      const joinB = el('button', { class: 'qbtn mod' }, 'SEND INTO BATTLE');
      joinB.onclick = () => gm('player-bench', { seat: m.id, benched: false });
      elRow.appendChild(joinB);
    }
    const renameB = el('button', { class: 'qbtn' }, 'RENAME');
    renameB.onclick = () => { const n = prompt('Name:', m.name); if (n) gm('player-edit', { seat: m.id, patch: { name: n } }); };
    elRow.appendChild(renameB);
    const classB = el('button', { class: 'qbtn' }, 'CLASS');
    classB.onclick = () => { const k = prompt('Class (Purifier/Alpha/Omega/Epsilon/Bandit/Burnt):', m.klass); if (k) gm('player-edit', { seat: m.id, patch: { klass: k } }); };
    elRow.appendChild(classB);
    card.appendChild(elRow);
    cards.appendChild(card);
  }
  p.appendChild(cards);
  const rest = el('button', { class: 'bigbtn', style: 'margin-top:14px' }, '✚ REST ZONE — FULL RESTORE, ALL STATUSES CURED');
  rest.onclick = () => gm('rest');
  p.appendChild(rest);
}

function labeledPair(lbl, val, step, onSet) {
  const row = el('div', { class: 'statrow' }, el('span', { class: 'sl' }, lbl));
  const st = stepper(val, step, v => onSet(v));
  row.appendChild(st);
  return row;
}

// ---- Shop gate
function renderShopGate(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'SHOP — ZACHARIE'));
  p.appendChild(el('div', { class: 'ps' }, 'THE STOCK GATE: TOGGLE, PRICE, THEN OPEN. PLAYERS SEE ONLY WHAT\'S ON. SELLING IS UNAFFECTED — ZACHARIE BUYS ANYTHING.'));
  if (!view.shop) {
    const open = el('button', { class: 'bigbtn' }, 'PREPARE SHOP (STOCK GATE)');
    open.onclick = () => gm('shop-open');
    p.appendChild(open);
    return;
  }
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px;max-width:640px' });
  for (const s of view.shop.stock) {
    const row = el('div', { style: `display:flex;align-items:center;gap:14px;background:var(--panel);border:1px solid #262626;padding:6px 14px;${s.on ? '' : 'opacity:.55'}` });
    const tog = el('button', { class: 'qbtn' + (s.on ? ' gmctl' : '') }, s.on ? 'ON' : 'OFF');
    tog.onclick = () => gm('shop-stock', { name: s.name, on: !s.on });
    row.appendChild(tog);
    row.appendChild(el('span', { style: 'font-family:var(--disp);text-transform:uppercase;font-size:20px;flex:1' }, s.name));
    row.appendChild(el('span', { style: 'font-size:13px;color:#888' }, s.desc || ''));
    const price = el('input', { type: 'number', value: s.price, style: 'width:80px' });
    price.onchange = () => gm('shop-stock', { name: s.name, price: +price.value });
    row.appendChild(price);
    list.appendChild(row);
  }
  p.appendChild(list);
  const bar = el('div', { style: 'display:flex;gap:10px;margin-top:14px' });
  const open = el('button', { class: 'bigbtn' }, view.shop.open ? 'SHOP IS OPEN' : 'OPEN SHOP');
  open.onclick = () => gm('shop-open-doors');
  const close = el('button', { class: 'bigbtn ghost' }, 'CLOSE SHOP');
  close.onclick = () => gm('shop-close');
  bar.append(open, close);
  p.appendChild(bar);
}

// ---- Jukebox / Stingers
function renderJukebox(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'JUKEBOX'));
  p.appendChild(el('div', { class: 'ps' }, 'ONE LIBRARY. FOLDERS ARE LAYOUT — RE-SHELVE ANY TRACK INTO A ZONE HEADING WITH ITS ZONE BUTTON. ASSIGNMENTS AUTOPLAY AND LOOP; A QUEUE PLAYS THROUGH, THEN THE LAST TRACK LOOPS.'));

  // now playing + queue
  const now = el('div', { class: 'edsec' }, el('h4', {}, 'NOW PLAYING'));
  now.appendChild(el('div', { style: 'font-family:var(--disp);text-transform:uppercase;font-size:24px;margin-bottom:6px' },
    view.jukebox.track ? `${view.jukebox.playing ? '▶ ' : '❚❚ '}${trackName(view.jukebox.track)}` : 'SILENCE'));
  const bar = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
  const stop = el('button', { class: 'qbtn' }, 'STOP');
  stop.onclick = () => gm('jukebox-stop');
  const skip = el('button', { class: 'qbtn' }, 'SKIP → NEXT IN QUEUE');
  skip.onclick = () => gm('jukebox-skip');
  bar.append(stop, skip, volumeSlider());
  const rescan = el('button', { class: 'qbtn' }, 'RESCAN ASSET FOLDERS');
  rescan.onclick = async () => { await rescanAssets(); announce('Hot folders re-scanned — new tracks and art are in.'); renderPanels(); };
  bar.appendChild(rescan);
  now.appendChild(bar);
  const q = view.jukebox.queue || [];
  now.appendChild(el('h4', { style: 'margin-top:12px' }, `QUEUE${q.length ? ` — ${q.length}` : ''}`));
  if (!q.length) now.appendChild(el('div', { style: 'font-size:13px;color:#777' }, 'empty — the current track loops'));
  q.forEach((f, i) => {
    const row = el('div', { class: 'trackrow' }, el('span', { class: 'tn2' }, `${i + 1}. ${trackName(f)}`));
    const x = el('button', { class: 'qx' }, '×');
    x.onclick = () => gm('jukebox-queue-remove', { index: i });
    row.appendChild(x);
    now.appendChild(row);
  });
  if (q.length) {
    const clear = el('button', { class: 'qbtn', style: 'margin-top:6px' }, 'CLEAR QUEUE');
    clear.onclick = () => gm('jukebox-queue-clear');
    now.appendChild(clear);
  }
  p.appendChild(now);

  // the library, shelved by zone headings
  const { byHeading, order } = musicLibrary();
  for (const heading of order) {
    p.appendChild(el('div', { class: 'dsec' }, heading.toUpperCase()));
    for (const f of byHeading[heading]) {
      const row = el('div', { class: 'trackrow' + (view.jukebox.track === f ? '' : '') });
      row.appendChild(el('span', { class: 'tn2', style: view.jukebox.track === f ? 'color:var(--amber)' : '' }, trackName(f)));
      const play = el('button', { class: 'qbtn' }, 'PLAY');
      play.onclick = () => gm('jukebox-play', { file: f });
      const queueB = el('button', { class: 'qbtn' }, 'QUEUE');
      queueB.onclick = () => gm('jukebox-queue-add', { file: f });
      const cur = (view.musicZones || {})[f] || null;
      const zoneB = el('button', { class: 'qbtn' + (cur ? ' mod' : '') }, cur ? `ZONE: ${cur}` : 'SHELVE → ZONE');
      zoneB.onclick = () => {
        const cycle = [null, ...MUSIC_ZONES];
        const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
        gm('music-zone', { file: f, zone: next });
      };
      row.append(play, queueB, zoneB);
      p.appendChild(row);
    }
  }
  if (!order.length) p.appendChild(el('div', { class: 'ps' }, 'DROP TRACKS INTO assets/music/<folder>/ — THEY APPEAR HERE ON RESCAN.'));
}

function renderStingers(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'STINGERS'));
  p.appendChild(el('div', { class: 'ps' }, 'THE ONE-SHOT SOUND BOARD — FIRES ON EVERY CLIENT.'));
  const grid = el('div', { class: 'cards' });
  for (const f of (App.art ? App.art.tree.stingers : [])) {
    const c = el('div', { class: 'card' }, el('div', { class: 'cn' }, f.split('/').pop()));
    c.onclick = () => gm('stinger', { file: f });
    grid.appendChild(c);
  }
  if (!grid.childNodes.length) grid.appendChild(el('div', { class: 'ps' }, 'DROP SOUNDS INTO assets/stingers/'));
  p.appendChild(grid);
}

// ---- Cutscene
function renderCutscene(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'CUTSCENE'));
  p.appendChild(el('div', { class: 'ps' }, 'A LIBRARY OF PRE-AUTHORED SCENES, TRIGGERED BY NAME. EFFECTS ARE COMPONENTS OF SCENES, NEVER STANDALONE BUTTONS.'));
  if (view.scene && !view.scene.done) return renderConductor(p, view);
  const cards = el('div', { class: 'cards' });
  for (const id of view.scenes || ['intro']) {
    const c = el('div', { class: 'card' }, el('div', { class: 'cn' }, id === 'intro' ? 'The Birthday (Intro)' : id), el('div', { class: 'cs' }, id === 'intro' ? 'interactive · choice gates · the sparkle protocol' : 'authored scene'));
    c.onclick = () => gm('scene-start', { id });
    const musicRow = el('div', { class: 'statrow', style: 'margin-top:8px' }, el('span', { class: 'sl', style: 'width:auto' }, 'MUSIC'));
    const sel = musicSelect((view.sceneMusic || {})[id] || null, v => gm('scene-music', { id, file: v || null }));
    sel.style.cssText = 'flex:1 1 140px;min-width:0;max-width:100%';
    sel.onclick = ev => ev.stopPropagation();
    musicRow.onclick = ev => ev.stopPropagation();
    musicRow.appendChild(sel);
    c.appendChild(musicRow);
    cards.appendChild(c);
  }
  p.appendChild(cards);
  p.appendChild(el('div', { class: 'ps', style: 'margin-top:10px' }, 'A SCENE\'S TRACK STARTS LOOPING THE MOMENT THE SCENE STARTS — SAME GRAMMAR AS ENCOUNTER AND ROOM MUSIC.'));
  p.appendChild(el('div', { class: 'ps', style: 'margin-top:14px' }, 'AUTHOR NEW SCENES AS JSON IN src/server/data/ (SEE intro-scene.json FOR THE BEAT VOCABULARY).'));
}

function renderConductor(p, view) {
  const sc = view.scene;
  p.appendChild(el('div', { class: 'ph' }, `CONDUCTOR — ${sc.name || sc.sceneId}`));
  const bar = el('div', { style: 'display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap' });
  const cont = el('button', { class: 'bigbtn' }, 'CONTINUE ▸');
  cont.onclick = () => gm('scene-continue');
  const end = el('button', { class: 'bigbtn ghost' }, 'END SCENE');
  end.onclick = () => gm('scene-end');
  bar.append(cont, end);
  p.appendChild(bar);

  // The script, as performed: the current beat's full content.
  const b = sc.currentBeat;
  if (b) {
    const box = el('div', { class: 'edsec', style: 'border-left:4px solid var(--amber)' }, el('h4', {}, 'ON SCREEN NOW — YOUR SCRIPT'));
    const line = (t, style = '') => box.appendChild(el('div', { style: 'font-size:17px;line-height:1.7;color:#e8e5dd;' + style }, t));
    if (b.type === 'text') line(`“${b.text}”`);
    else if (b.type === 'input' || b.type === 'choice') {
      line(`“${b.title}”`);
      if (b.options) line(`Menu: ${b.options.join(' · ')}`, 'color:#9a978f;font-size:14px');
      if (b.hoverLines) {
        line('Hover whispers (private, per player):', 'color:#9a978f;font-size:14px;margin-top:6px');
        for (const [opt, hl] of Object.entries(b.hoverLines)) line(`${opt}: “${hl}”`, 'font-size:14px;color:#c9c5bb');
      }
      if (b.reactions) {
        line('Your reaction to each answer:', 'color:#9a978f;font-size:14px;margin-top:6px');
        for (const [opt, r] of Object.entries(b.reactions)) line(`${opt}: “${r}”`, 'font-size:14px;color:#c9c5bb');
      }
    } else if (b.type === 'ceremony-stats') {
      line('Each Continue fills one stat as you voice its line:', 'color:#9a978f;font-size:14px');
      (b.lines || []).forEach((l, i) => {
        const isCurrent = i === sc.subIndex;
        const done = i < sc.subIndex;
        line(`${isCurrent ? '▸ ' : done ? '✓ ' : '· '}“${l.line}”`,
          isCurrent ? 'color:var(--amber);font-size:19px' : done ? 'opacity:.5' : 'opacity:.8');
      });
    } else if (b.type === 'ceremony-competences') {
      line('Their starter competences appear on every screen. (“Next, I shall grant you Power” was the cue.)', 'color:#c9c5bb');
    } else if (b.type === 'scene') {
      line(`[STAGING] ${b.caption || b.scene}`, 'color:#c9c5bb;font-style:italic');
    } else if (b.type === 'branch-text') {
      line(`If ${b.on} = ${b.equals}:`, 'color:#9a978f;font-size:14px');
      for (const t of b.textIf || []) line(`“${t}”`);
      line('Everyone else sees:', 'color:#9a978f;font-size:14px;margin-top:6px');
      for (const t of b.textElse || []) line(`“${t}”`);
    }
    p.appendChild(box);
  }
  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px' });
  const beats = el('div', { class: 'edsec', style: 'max-height:46vh;overflow-y:auto' }, el('h4', {}, 'BEATS'));
  (sc.beats || []).forEach(b => {
    const row = el('div', { class: 'beatrow' + (b.index === sc.beatIndex ? ' cur' : '') },
      el('span', { class: 'bt2' }, `${b.index} · ${b.type}`), el('span', {}, (b.label || '').slice(0, 70)));
    row.style.cursor = 'pointer';
    row.onclick = () => gm('scene-jump', { index: b.index });
    beats.appendChild(row);
  });
  grid.appendChild(beats);
  const right = el('div', { class: 'edsec' }, el('h4', {}, 'CHOICE MATRIX — CLICK A CELL TO OVERRIDE'));
  const keys = ['class', 'gender', 'name', 'desire', 'fear', 'virtue', 'finalFeeling'];
  const table = el('table', { class: 'matrix' });
  const head = el('tr', {}, el('th', {}, 'seat'));
  for (const k of keys) head.appendChild(el('th', {}, k));
  table.appendChild(head);
  for (const m of view.party) {
    const tr = el('tr', {}, el('td', {}, `${m.id} ${m.name}`));
    const my = (sc.matrix || {})[m.id] || {};
    for (const k of keys) {
      const td = el('td', { style: 'cursor:pointer' }, my[k] || '·');
      td.onclick = () => {
        const v = prompt(`${m.id} ${k}:`, my[k] || '');
        if (v != null && v !== '') gm('scene-set-choice', { seat: m.id, key: k, value: v });
      };
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  right.appendChild(table);
  const pend = (sc.pending || []).filter(x => x.waiting.length);
  right.appendChild(el('div', { style: 'font-size:10px;color:#888;margin-top:10px' },
    pend.length ? 'pending: ' + pend.map(x => `${x.key} (${x.waiting.join(',')})`).join(' · ') : 'no gates pending'));
  right.appendChild(el('div', { style: 'font-size:10px;color:#666;margin-top:6px' }, 'Continue is never locked — a pending gate stays open in parallel.'));
  grid.appendChild(right);
  p.appendChild(grid);
}

// ---- System
function renderSystem(p, view) {
  p.appendChild(el('div', { class: 'ph' }, 'SYSTEM'));
  p.appendChild(el('div', { class: 'ps' }, 'SNAPSHOTS · LOGS · DATA RELOAD · THE LOBBY'));
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, 'SEATS'),
    el('div', { style: 'font-size:12px' }, `connected: ${(view.connected || []).join(', ') || 'nobody'}`),
    (() => {
      const b = el('button', { class: 'qbtn', style: 'margin-top:6px' }, 'SEND EVERYONE TO THE LOBBY');
      b.onclick = () => gm('set-mode', { mode: 'lobby' });
      return b;
    })(),
    (() => {
      const b = el('button', { class: 'qbtn', style: 'margin-left:6px' }, 'BACK TO THE OVERWORLD');
      b.onclick = () => gm('set-mode', { mode: 'overworld' });
      return b;
    })()));
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, 'SESSION SNAPSHOTS'),
    (() => {
      const bar = el('div', { style: 'display:flex;gap:8px;margin-bottom:10px' });
      const name = el('input', { type: 'text', placeholder: 'snapshot name…' });
      const save = el('button', { class: 'bigbtn', style: 'font-size:16px;padding:3px 14px' }, 'SNAPSHOT NOW');
      save.onclick = () => gm('snapshot', { name: name.value || 'manual' });
      bar.append(name, save);
      return bar;
    })(),
    ...(view.snapshots || []).map(s => {
      const row = el('div', { class: 'trackrow' }, el('span', { class: 'tn2' }, s.name), el('span', { style: 'font-size:9px;color:#777' }, s.at));
      const r = el('button', { class: 'qbtn' }, 'RESTORE');
      r.onclick = () => { if (confirm(`Restore "${s.name}"? Current state is replaced.`)) gm('restore', { file: s.file }); };
      row.appendChild(r);
      return row;
    })));
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, 'COMBAT LOGS'),
    ...(view.logs || []).map(l =>
      el('div', { class: 'trackrow' },
        el('span', { class: 'tn2' }, `${l.name} · ${l.entries} events`),
        el('a', { href: `/api/log/${l.id}.json`, style: 'color:var(--amber);font-size:10px', target: '_blank' }, 'JSON'),
        el('a', { href: `/api/log/${l.id}.txt`, style: 'color:var(--amber);font-size:10px', target: '_blank' }, 'TXT')))));
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, 'DATA RELOAD (WITH DIFF)'),
    (() => {
      const b = el('button', { class: 'bigbtn ghost' }, 'CHECK DATA FILES FOR CHANGES');
      b.onclick = () => gm('reload-diff');
      return b;
    })(),
    el('div', { id: 'diffbox', style: 'font-size:10px;color:#aaa;margin-top:8px;white-space:pre-wrap;max-height:30vh;overflow-y:auto' })));
  p.appendChild(el('div', { class: 'edsec' },
    el('h4', {}, 'DANGER'),
    (() => {
      const b = el('button', { class: 'bigbtn red' }, 'NEW CAMPAIGN (WIPES EVERYTHING)');
      b.onclick = () => { if (confirm('Really start over? Snapshot first if in doubt.')) gm('new-campaign'); };
      return b;
    })()));
}

function showReloadDiff(diff, total) {
  activeTab = 'System';
  renderPanels();
  const box = $('diffbox');
  if (!box) return;
  if (!diff.length) { box.textContent = 'No changes on disk.'; return; }
  box.textContent = diff.join('\n') + (total > diff.length ? `\n… and ${total - diff.length} more` : '');
  const bar = el('div', { style: 'margin-top:8px;display:flex;gap:8px' });
  const apply = el('button', { class: 'bigbtn', style: 'font-size:15px' }, 'APPLY');
  apply.onclick = () => { gm('reload-apply'); box.textContent = ''; };
  const cancel = el('button', { class: 'bigbtn ghost', style: 'font-size:15px' }, 'DISCARD');
  cancel.onclick = () => { gm('reload-cancel'); box.textContent = ''; };
  bar.append(apply, cancel);
  box.appendChild(bar);
}
