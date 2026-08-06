// Player client. Renders server state; every rule lives server-side.
// The UI filters to legality: dead targets grey out and refuse the click,
// the slot picker shows only legal gear, Muted disables Competence.

import { App, connect, send, loadStaticData, applyZone, applyPalette, el, statusChip, statChangeChip, floatOver, partyArt, enemyArt, roomArt, canonRoom, drawCanonCond, artEl, syncJukebox, volumeSlider, playCombatFx } from '/common.js';
import { drawRoomKit } from '/roomkit.js';

const seat = new URLSearchParams(location.search).get('seat') || localStorage.getItem('off-seat') || 'P1';
if (!/^P[1-6]$/.test(seat)) location.href = '/';

let armed = null;         // {kind:'attack'|'comp'|'item', comp?, item?, element?, targetSpec}
let kselIdx = 0;          // keyboard target cursor within the current legal target list
const MENU_BTNS = ['btnAttack', 'btnComp', 'btnDefend', 'btnObj'];
let menuIdx = 0;          // action-menu cursor — every turn starts on ATTACK
let subCursor = 0;        // competence / element submenu cursor
let itemCursor = 0;       // Objects column cursor
let itemRows = [];        // usable items, in rendered order
let wasMyTurn = false;
let lastStateAt = 0;
let sheetOpen = false;
const $ = id => document.getElementById(id);

await loadStaticData();
connect(seat);
document.querySelector('.topbtns').prepend(volumeSlider());
$('sceneVol').appendChild(volumeSlider());   // scenes cover the top bar; players keep a slider in-scene

let fxLockUntil = 0;
App.onEvent = e => {
  if (e.kind === 'combat-fx') { fxLockUntil = performance.now() + playCombatFx(e, '#field'); return; }
  if (e.kind === 'announce') announce(e.text);
  if (e.kind === 'float') showFloat(e.targetId, e.text, e.style);
  if (e.kind === 'victory') announce(e.got && e.got.length ? `You got: ${e.got.join(', ')}` : 'Victory.');
  if (e.kind === 'defeat') announce('THE PARTY HAS FALLEN.');
  if (e.kind === 'your-turn' && e.playerId === seat) { /* stack appears via state render */ }
  if (e.kind === 'private' && e.hover) { const h = $('hoverline'); if (h) h.textContent = e.hover; }
  if (e.kind === 'sparkle-pulse') pulseSparkle();
};

App.onState = view => {
  lastStateAt = performance.now();
  document.body.classList.toggle('paused', !!view.paused);
  render(view);
};

function announce(t) { $('announce').textContent = t; }

function me() { return App.view ? App.view.party.find(m => m.id === seat) : null; }

// Small-group play: a member renders only when actually present — you always see
// yourself; others must be un-benched AND either connected or already fighting
// in the current battle (a mid-battle disconnect keeps them on the field for
// the GM to pilot). Absent members don't appear anywhere.
function isPresent(m, view) {
  if (m.id === seat) return true;
  if (m.benched) return false;
  if (view.battle && (view.battle.partySlots || []).includes(m.id)) return true;
  return (view.connected || []).includes(m.id);
}

// ---------------------------------------------------------------- render root
function render(view) {
  const z = applyZone(view.location.zone);
  $('zname').textContent = z.title;
  $('zsub').textContent = view.location.name === 'lobby' ? '' : view.location.name;
  $('credits').textContent = `${view.credits} CREDITS`;
  renderInventory(view);
  renderStrip(view);

  const inScene = !!view.scene || view.mode === 'lobby' || view.mode === 'scene';
  $('sceneWrap').style.display = inScene ? 'block' : 'none';
  if (inScene) renderScene(view.scene);

  const inBattle = !!view.battle && view.mode === 'battle';
  $('rail').style.display = inBattle ? 'flex' : 'none';
  $('stack').style.display = inBattle ? 'flex' : 'none';
  $('enemies').style.display = inBattle ? 'flex' : 'none';
  $('allies').style.display = inBattle ? 'block' : 'none';
  $('owWrap').style.display = (!inBattle && !inScene && view.mode === 'overworld') ? 'flex' : 'none';
  $('shopWrap').style.display = view.mode === 'shop' && view.shop ? 'block' : 'none';

  if (inBattle) renderBattle(view);
  else { $('field').classList.remove('backdrop'); $('field').style.backgroundImage = ''; }
  if (view.mode === 'shop' && view.shop) renderShop(view);
  if (sheetOpen) renderSheet();
  syncJukebox(view.jukebox);
}

// ---------------------------------------------------------------- inventory
function renderInventory(view) {
  const list = $('ilist');
  list.innerHTML = '';
  const cat = App.staticData.items.catalog;
  const bySection = {};
  for (const it of cat) {
    const n = view.inventory[it.name] || 0;
    (bySection[it.section] = bySection[it.section] || []).push({ ...it, n });
  }
  for (const name of Object.keys(view.inventory)) {
    if (!cat.find(c => c.name === name) && view.inventory[name] > 0) {
      (bySection['OTHER'] = bySection['OTHER'] || []).push({ name, desc: '', n: view.inventory[name] });
    }
  }
  itemRows = [];
  const picking = armed && armed.kind === 'item-pick';
  for (const [sec, items] of Object.entries(bySection)) {
    if (!items.some(i => i.n > 0) && sec !== 'RESTORATIVE') continue;
    list.appendChild(el('div', { class: 'isec' }, sec));
    for (const it of items) {
      const row = el('div', { class: 'item' + (it.n <= 0 ? ' zero' : '') },
        el('span', { class: 'in' }, it.name),
        el('span', { class: 'ic' }, `×${it.n}`),
        el('span', { class: 'id' }, it.desc || ''));
      row.onclick = () => itemClicked(it.name, it.n);
      if (it.n > 0) itemRows.push({ name: it.name, n: it.n, row });
      list.appendChild(row);
    }
  }
  if (picking && itemRows.length) {
    const cur = ((itemCursor % itemRows.length) + itemRows.length) % itemRows.length;
    itemRows[cur].row.classList.add('ksel');
    itemRows[cur].row.scrollIntoView({ block: 'nearest' });
  }
  const inBattle = App.view.battle && App.view.mode === 'battle';
  $('inv').classList.toggle('armed', (armed && armed.kind === 'item-pick') || !inBattle);
}

function itemClicked(name, n) {
  if (n <= 0) return;
  const view = App.view;
  const item = App.staticData.items.catalog.find(c => c.name === name);
  if (!item) return;
  const inBattle = view.battle && view.mode === 'battle';
  if (inBattle) {
    if (!armed || armed.kind !== 'item-pick') return;   // must arm via Objects first
    const tgt = item.effect.target === 'one enemy' ? 'enemy' : 'ally';
    armed = { kind: 'item', item: name, targetSpec: tgt };
    kselIdx = 0;
    rerender();
    announce(`${name} — choose a ${tgt === 'enemy' ? 'target' : 'party member'}. Arrows cycle, Enter confirms.`);
  } else {
    // Out of combat, anything in the shared inventory can be used freely by anyone.
    armed = { kind: 'ooc-item', item: name, targetSpec: 'ally' };
    kselIdx = 0;
    rerender();
    announce(`${name} — choose a party member.`);
  }
}

// ---------------------------------------------------------------- battle
function renderBattle(view) {
  const b = view.battle;
  const field = $('field');
  // A combat animation is mid-flight: hold the field rebuild so the moving
  // sprite isn't replaced under it. State catches up on the next push.
  if (performance.now() < fxLockUntil && $('enemies').children.length) { renderStack(view); return; }
  if (b.backdrop) {
    field.classList.add('backdrop');
    field.style.backgroundImage = `url('/assets/backdrops/${b.backdrop}')`;
    if (b.palette) applyPalette(b.palette);
  }
  // enemies — sprite, name, visible effect icons; stats/HP only when revealed
  const wrap = $('enemies');
  wrap.innerHTML = '';
  const m = me();
  const myTurn = m && m.holding && !m.down;
  const cursor = armed ? kselTarget() : null;
  for (const e of [...b.enemies].sort((a, x) => (a.slot || 0) - (x.slot || 0))) {
    const targetable = myTurn && !e.dead && armed && ['attack', 'comp-target-enemy', 'item-enemy'].includes(armedMode());
    const onCursor = targetable && cursor && cursor.id === e.id;
    const div = el('div', { class: 'enemy' + (e.dead ? ' dead' : '') + (targetable ? ' targetable' : '') + (onCursor ? ' ksel' : ''), 'data-id': e.id });
    const art = enemyArt(e.template);
    const artNode = artEl(art, e.name, Math.round(150 * (e.size || 1)));
    artNode.classList && artNode.classList.add('eart');
    const artBox = el('div', { class: 'eart' }); artBox.appendChild(artNode);
    div.appendChild(artBox);
    div.appendChild(el('div', { class: 'ename outline' }, e.name));
    if (e.revealed && e.maxHp) {
      div.appendChild(el('div', { class: 'ehpbar' }, el('i', { style: `width:${Math.round(e.hp / e.maxHp * 100)}%` })));
    }
    const icons = el('div', { class: 'eicons' });
    if (e.revealed) icons.appendChild(el('span', { class: 'icn elem', title: `Element: ${e.element || 'none'} — revealed` }, e.element ? e.element.slice(0, 3).toUpperCase() : 'Ø'));
    if (e.elementSet && !e.revealed) icons.appendChild(el('span', { class: 'icn elem', title: `Element set to ${e.elementSet}` }, e.elementSet.slice(0, 3).toUpperCase()));
    for (const s of e.statuses) icons.appendChild(statusChip(s));
    for (const sc of e.statChanges) icons.appendChild(statChangeChip(sc));
    div.appendChild(icons);
    div.onclick = () => { if (!e.dead) targetClicked({ kind: 'enemy', id: e.id }); };
    if (e.revealed) { div.oncontextmenu = ev => { ev.preventDefault(); showRevealCard(e); }; div.title = 'right-click: reveal card'; }
    wrap.appendChild(div);
  }
  // allies in the Batter-and-rings arrangement (randomized per encounter)
  const allies = $('allies');
  allies.innerHTML = '';
  // Batter-and-rings, sized to own the right side: one forward anchor, the rest orbiting.
  const anchors = [
    { right: '9vw', bottom: '80px', h: 175 },
    { right: '21vw', bottom: '170px', h: 145 },
    { right: '3vw', bottom: '205px', h: 145 },
    { right: '17vw', bottom: '305px', h: 140 },
    { right: '2vw', bottom: '345px', h: 140 },
    { right: '10vw', bottom: '415px', h: 135 },
  ];
  (b.partySlots || []).forEach((pid, i) => {
    const pm = view.party.find(x => x.id === pid);
    if (!pm) return;
    const a = anchors[i] || anchors[0];
    const onCursorA = armed && allyTargetable(pm) && (() => { const c = kselTarget(); return c && c.id === pm.id; })();
    const div = el('div', {
      class: 'ally' + (pm.id === seat ? ' me' : '') + (pm.down ? ' downed' : '') + (allyTargetable(pm) ? ' targetable' : '') + (onCursorA ? ' ksel' : ''),
      style: `right:${a.right};bottom:${a.bottom}`, 'data-id': pm.id,
    });
    div.appendChild(artEl(partyArt(pm.klass), pm.name, a.h));
    div.appendChild(el('div', { class: 'aname outline' }, pm.name));
    div.onclick = () => targetClicked({ kind: 'ally', id: pm.id });
    allies.appendChild(div);
  });
  renderStack(view);
}

function armedMode() {
  if (!armed) return null;
  if (armed.kind === 'attack') return 'attack';
  if (armed.kind === 'comp' && armed.targetSpec === 'one enemy') return 'comp-target-enemy';
  if (armed.kind === 'comp' && armed.targetSpec === 'one ally') return 'comp-target-ally';
  if (armed.kind === 'item') return armed.targetSpec === 'enemy' ? 'item-enemy' : 'item-ally';
  if (armed.kind === 'ooc-item') return 'ooc-ally';
  return armed.kind;
}

// The legal target list for whatever is armed — what the arrow keys cycle over.
function targetList() {
  const view = App.view;
  if (!view || !armed) return [];
  const mode = armedMode();
  const inBattle = view.battle && view.mode === 'battle';
  if (mode === 'attack' || mode === 'comp-target-enemy' || mode === 'item-enemy') {
    if (!inBattle) return [];
    return [...view.battle.enemies].filter(e => !e.dead).sort((a, b) => (a.slot || 0) - (b.slot || 0))
      .map(e => ({ kind: 'enemy', id: e.id }));
  }
  if (mode === 'comp-target-ally' || mode === 'item-ally' || mode === 'ooc-ally') {
    const me2 = me();
    const comp = armed.kind === 'comp' && me2 ? me2.competences.find(c => c.name === armed.comp) : null;
    const item = armed.kind === 'item' || armed.kind === 'ooc-item'
      ? App.staticData.items.catalog.find(c => c.name === armed.item) : null;
    const wantsDown = (comp && comp.kind === 'revive') || (item && item.effect.type === 'revive');
    return view.party.filter(pm => isPresent(pm, view) && !pm.benched && (wantsDown ? pm.down : !pm.down)).map(pm => ({ kind: 'ally', id: pm.id }));
  }
  return [];
}

function kselTarget() {
  const list = targetList();
  if (!list.length) return null;
  kselIdx = ((kselIdx % list.length) + list.length) % list.length;
  return list[kselIdx];
}

function allyTargetable(pm) {
  const mode = armedMode();
  if (mode === 'comp-target-ally' || mode === 'item-ally' || mode === 'ooc-ally') return true;
  return false;
}

function renderStack(view) {
  const m = me();
  const stack = $('stack');
  const myTurn = m && m.holding && !m.down && !view.battle.over;
  stack.classList.toggle('crit', !!(m && m.critCharged));
  const furious = m && m.statuses.some(s => s.name === 'Furious');
  const mad = m && m.statuses.some(s => s.name === 'Madness');
  const muted = m && m.statuses.some(s => ['Muted', 'Vilified', 'Corrupted'].includes(s.name));
  const itemLocked = m && m.statuses.some(s => s.name === 'Corrupted');
  $('btnAttack').disabled = !myTurn || mad;
  $('btnComp').disabled = !myTurn || mad || muted || furious;
  $('btnDefend').disabled = !myTurn || mad || furious;
  $('btnObj').disabled = !myTurn || mad || furious || itemLocked;
  if (furious && myTurn) announce(`${m.name} is FURIOUS — pick a target.`);
  if (furious && myTurn && !armed) armed = { kind: 'attack' };   // any click = the Furious act
  if (!myTurn) { armed = null; $('subs').classList.remove('open'); $('inv').classList.remove('armed'); setSel(''); }
  // Turn start: the menu pops with the cursor on ATTACK — Enter attacks.
  if (myTurn && !wasMyTurn) { menuIdx = 0; itemCursor = 0; }
  if (myTurn && !armed && !$('subs').classList.contains('open')) {
    const usable = MENU_BTNS.filter(b => !$(b).disabled);
    setSel(usable[Math.min(menuIdx, Math.max(0, usable.length - 1))] || '');
  }
  wasMyTurn = !!myTurn;
}

function markSubCursor() {
  const subs = [...$('subs').querySelectorAll('.sub')];
  subs.forEach((s, i) => s.classList.toggle('sel', i === subCursor));
  if (subs[subCursor]) subs[subCursor].scrollIntoView({ block: 'nearest' });
}

$('btnAttack').onclick = () => { setSel('btnAttack'); armed = { kind: 'attack' }; kselIdx = 0; $('subs').classList.remove('open'); $('inv').classList.remove('armed'); announce('Attack — choose an enemy.'); rerender(); };
$('btnDefend').onclick = () => { setSel('btnDefend'); armed = null; send({ t: 'action', action: { kind: 'defend' } }); };
$('btnObj').onclick = () => { setSel('btnObj'); armed = { kind: 'item-pick' }; $('subs').classList.remove('open'); rerender(); announce('Objects — pick one from the column.'); };
$('btnComp').onclick = () => { setSel('btnComp'); armed = null; openCompDrawer(); };

function setSel(id) {
  for (const b of ['btnAttack', 'btnComp', 'btnDefend', 'btnObj']) $(b).classList.toggle('sel', b === id);
}

function openCompDrawer() {
  const m = me();
  if (!m) return;
  const subs = $('subs');
  subs.innerHTML = '';
  for (const c of m.competences.filter(c => c.unlocked)) {
    const afford = m.cp >= c.cp;
    const row = el('button', { class: 'sub' + (afford ? '' : ' broke') },
      el('div', { class: 'sn' }, `${c.name} — ${c.cp}`),
      el('div', { class: 'sd' }, afford ? describeComp(c) : `need ${c.cp} CP`));
    row.onclick = () => { if (afford) pickComp(c); };
    subs.appendChild(row);
  }
  subs.classList.add('open');
  $('inv').classList.remove('armed');
  subCursor = 0;
  markSubCursor();
}

function describeComp(c) {
  const bits = [c.target];
  if (c.element) bits.push(c.element);
  if (c.accuracy != null) bits.push(`acc ${c.accuracy}`);
  bits.push(c.effect);
  return bits.join(' · ');
}

function pickComp(c) {
  if (c.choosesElement) {
    const subs = $('subs');
    subs.innerHTML = '';
    for (const elName of ['Plastic', 'Metal', 'Smoke', 'Meat']) {
      const row = el('button', { class: 'sub' }, el('div', { class: 'sn' }, elName));
      row.onclick = () => armComp(c, elName);
      subs.appendChild(row);
    }
    subCursor = 0;
    markSubCursor();
    return;
  }
  armComp(c, null);
}

function armComp(c, element) {
  kselIdx = 0;
  $('subs').classList.remove('open');
  if (c.target === 'one enemy') {
    armed = { kind: 'comp', comp: c.name, element, targetSpec: 'one enemy' };
    announce(`${c.name} — choose an enemy.`);
  } else if (c.target === 'one ally') {
    armed = { kind: 'comp', comp: c.name, element, targetSpec: 'one ally' };
    announce(`${c.name} — choose a party member.`);
  } else {
    send({ t: 'action', action: { kind: 'competence', competence: c.name, element } });
    armed = null;
  }
  rerender();
}

function targetClicked(t) {
  const view = App.view;
  const m = me();
  const inBattle = view.battle && view.mode === 'battle';
  if (!armed) return;
  if (armed.kind === 'ooc-item') {
    if (t.kind !== 'ally') return;
    send({ t: 'ooc-item', item: armed.item, target: t.id });
    armed = null;
    return;
  }
  if (!inBattle || !m || !m.holding) return;
  const furious = m.statuses.some(s => s.name === 'Furious');
  if (furious) { send({ t: 'action', action: { kind: 'attack', targetId: t.id } }); armed = null; return; }
  if (armed.kind === 'attack' && t.kind === 'enemy') {
    send({ t: 'action', action: { kind: 'attack', targetId: t.id } });
    armed = null;
  } else if (armed.kind === 'comp') {
    if ((armed.targetSpec === 'one enemy' && t.kind === 'enemy') || (armed.targetSpec === 'one ally' && t.kind === 'ally')) {
      send({ t: 'action', action: { kind: 'competence', competence: armed.comp, targetId: t.id, element: armed.element } });
      armed = null;
    }
  } else if (armed.kind === 'item') {
    if ((armed.targetSpec === 'enemy' && t.kind === 'enemy') || (armed.targetSpec === 'ally' && t.kind === 'ally')) {
      send({ t: 'action', action: { kind: 'item', item: armed.item, targetId: t.id } });
      armed = null;
    }
  }
}

function showRevealCard(e) {
  const tiers = e.tiers || {};
  announce(`${e.name}: Element ${e.element || 'none'} · HP ${e.hp}/${e.maxHp} · DEF ${e.def} · RES ${e.res} · LCK ${e.lck} · acts every ${e.gaugeS}s · ` +
    Object.entries(tiers).map(([k, v]) => `${k.slice(0, 3)}:${{ vulnerable: 'V', neutral: 'N', light_immune: 'L', strong_immune: 'S' }[v] || v}`).join(' '));
}

function showFloat(targetId, text, style) {
  const host = document.querySelector(`[data-id="${targetId}"]`);
  if (host) floatOver(host, text, style);
}

// ---------------------------------------------------------------- party strip
function renderStrip(view) {
  const strip = $('strip');
  strip.innerHTML = '';
  const present = view.party.filter(pm => isPresent(pm, view));
  strip.style.gridTemplateColumns = `repeat(${Math.max(1, present.length)}, 1fr)`;
  for (const pm of present) {
    const targetable = !pm.benched && (allyTargetable(pm) && !pm.down || (armedMode() === 'ooc-ally'));
    const onCursorP = armed && targetable && (() => { const c = kselTarget(); return c && c.id === pm.id; })();
    const pc = el('div', { class: 'pc' + (pm.id === seat ? ' me' : '') + (pm.down ? ' deadpc' : '') + (targetable ? ' targetable' : '') + (onCursorP ? ' ksel' : ''), style: pm.benched ? 'opacity:.35' : '', 'data-id': pm.id });
    pc.appendChild(el('div', { class: 'r1' }, el('span', { class: 'pname' }, pm.name), el('span', { class: 'plvl' }, pm.benched ? 'OUT' : `LV${pm.level}`)));
    pc.appendChild(el('div', { class: 'nums' },
      el('div', { class: 'num', style: pm.hp / pm.maxHp <= .2 && !pm.down ? 'color:var(--red)' : '' }, `${pm.hp}`, el('em', {}, 'hp'), el('i', { style: `width:${Math.round(pm.hp / pm.maxHp * 100)}%${pm.hp / pm.maxHp <= .2 ? ';background:var(--red)' : ''}` })),
      el('div', { class: 'num cp' }, `${pm.cp}`, el('em', {}, 'cp'), el('i', { style: `width:${Math.round(pm.cp / pm.maxCp * 100)}%` }))));
    const g = el('div', { class: 'gauge pg' + (pm.critCharged ? ' critcharge' : '') + (pm.holding ? ' held' : ''), 'data-gid': pm.id },
      el('i', { style: `width:${Math.round(pm.gauge * 100)}%` }));
    pc.appendChild(g);
    const icons = el('div', { class: 'picons' });
    if (pm.defending) icons.appendChild(el('span', { class: 'icn up', title: 'Defending — +25 DEF until next gauge fill' }, '▲DEF·25'));
    if (pm.elementSet) icons.appendChild(el('span', { class: 'icn elem', title: `Element set to ${pm.elementSet}`, style: 'border-color:#555;color:#ddd;background:#000' }, pm.elementSet.slice(0, 3).toUpperCase()));
    for (const s of pm.statuses) icons.appendChild(statusChip(s));
    for (const sc of pm.statChanges) icons.appendChild(statChangeChip(sc));
    pc.appendChild(icons);
    pc.onclick = () => targetClicked({ kind: 'ally', id: pm.id });
    strip.appendChild(pc);
  }
}

// local gauge animation between state pushes
setInterval(() => {
  const view = App.view;
  if (!view || view.paused) return;
  const dt = (performance.now() - lastStateAt) / 1000;
  for (const pm of view.party) {
    const g = document.querySelector(`[data-gid="${pm.id}"] i`);
    if (!g) continue;
    const frozen = view.battle && (view.battle.frozen || view.battle.over);
    const w = pm.holding || pm.down || frozen || !view.battle ? pm.gauge : Math.min(1, pm.gauge + dt / pm.gaugeSeconds);
    g.style.width = `${Math.round(w * 100)}%`;
  }
}, 120);

function rerender() { if (App.view) render(App.view); }

// ---------------------------------------------------------------- scene player
let sparkles = [], sceneAnim = null;
function ensureSceneCanvas() {
  const c = $('sceneCanvas');
  c.width = innerWidth; c.height = innerHeight;
  if (!sparkles.length) for (let i = 0; i < 46; i++) sparkles.push({ x: Math.random(), y: Math.random(), p: Math.random() * 6.28, s: .4 + Math.random() * .9, pulse: 0 });
  if (!sceneAnim) sceneAnim = requestAnimationFrame(drawScene);
}

function pulseSparkle() {
  const s = sparkles[Math.floor(Math.random() * sparkles.length)];
  if (s) s.pulse = 1;
}

let sceneBackdrop = null;
function drawScene() {
  sceneAnim = requestAnimationFrame(drawScene);
  const c = $('sceneCanvas');
  if ($('sceneWrap').style.display === 'none') return;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  if (sceneBackdrop === 'queen-silhouette') {
    x.fillStyle = '#0a0a14'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#05050a';
    const cx = c.width / 2, base = c.height * .82;
    x.fillRect(cx - 160, base - 300, 320, 300);
    x.beginPath(); x.moveTo(cx - 220, base); x.lineTo(cx - 160, base - 340); x.lineTo(cx - 100, base); x.fill();
    x.beginPath(); x.moveTo(cx + 220, base); x.lineTo(cx + 160, base - 340); x.lineTo(cx + 100, base); x.fill();
    x.beginPath(); x.moveTo(cx - 60, base - 300); x.lineTo(cx, base - 430); x.lineTo(cx + 60, base - 300); x.fill();
    x.fillStyle = '#000'; x.fillRect(0, base, c.width, c.height - base);
  } else if (sceneBackdrop === 'workers-loop') {
    x.fillStyle = '#0d0d0d'; x.fillRect(0, 0, c.width, c.height);
    const t = Math.floor(performance.now() / 400) % 2;
    x.fillStyle = '#2a2a2a';
    for (let i = 0; i < 7; i++) {
      const wx = c.width * .12 + i * c.width * .11, wy = c.height * .72 + (t && i % 2 ? 3 : 0);
      x.fillRect(wx, wy, 14, 26);
      x.fillRect(wx + 3, wy - 8, 8, 8);
    }
    x.fillStyle = '#161616';
    x.fillRect(c.width * .78, c.height * .18, c.width * .16, c.height * .54);   // something large, motionless, never mentioned
  }
  for (const s of sparkles) {
    s.p += 0.013;
    if (s.pulse > 0) s.pulse -= 0.02;
    const a = Math.max((Math.sin(s.p) + 1) / 2 * .7, s.pulse);
    x.fillStyle = `rgba(244,242,236,${a})`;
    const size = 2 * s.s + (s.pulse > .5 ? 3 : 0);
    x.fillRect(s.x * c.width, s.y * c.height, size, size);
  }
}

function renderScene(scene) {
  ensureSceneCanvas();
  const box = $('sceneText');
  box.innerHTML = '';
  if (!scene) { sceneBackdrop = null; return; }   // pure lobby: the dark, your sparkle among others
  const beat = scene.beat;
  const gate = scene.gate;
  if (beat && beat.type === 'scene') sceneBackdrop = beat.scene;
  if (beat && beat.type !== 'scene' && beat.type !== 'text' && beat.type !== 'branch-text') sceneBackdrop = null;

  if (gate) { renderGate(gate); return; }
  if (!beat) return;
  if (beat.type === 'text') {
    box.appendChild(el('div', { class: 'sceneLine' }, beat.text));
  } else if (beat.type === 'branch-text') {
    for (const line of beat.lines || []) box.appendChild(el('div', { class: 'sceneLine' }, line));
  } else if (beat.type === 'ceremony-stats') {
    box.appendChild(el('div', { class: 'sceneLine' }, beat.lines[scene.subIndex] ? beat.lines[scene.subIndex].line : ''));
    const grid = el('div', { class: 'statsCer' });
    const order = ['hp', 'atk', 'cp', 'esp', 'def', 'agi', 'res', 'lck'];
    for (const st of order) {
      const on = (beat.revealed || []).includes(st);
      grid.appendChild(el('div', { class: on ? '' : 'off' }, `${st.toUpperCase()} ${on && beat.values ? beat.values[st] : ''}`));
    }
    box.appendChild(grid);
  } else if (beat.type === 'ceremony-competences') {
    box.appendChild(el('div', { class: 'sceneLine' }, ''));
    const list = el('div', { class: 'compCer' });
    for (const cmp of beat.competences || []) list.appendChild(el('div', {}, `${cmp.name} — ${cmp.cp} CP`));
    box.appendChild(list);
  } else if (beat.type === 'choice' && beat.reaction) {
    box.appendChild(el('div', { class: 'sceneLine' }, beat.reaction));
  } else if (beat.type === 'scene') {
    // backdrop carries it; caption is for the GM's screen
  }
}

function renderGate(gate) {
  const box = $('sceneText');
  const b = gate.beat;
  box.appendChild(el('div', { class: 'sceneLine' }, b.title));
  box.appendChild(el('div', { class: 'hoverline', id: 'hoverline' }, ''));
  if (b.type === 'input') {
    const input = el('input', { class: 'sceneInput', maxlength: '40', placeholder: '…' });
    const ok = el('button', { class: 'sopt', style: 'margin-top:14px' }, 'SO BE IT');
    ok.onclick = () => { if (input.value.trim()) send({ t: 'scene-choose', key: b.key, value: input.value.trim() }); };
    box.appendChild(input); box.appendChild(ok);
    input.focus();
    return;
  }
  const menu = el('div', { class: 'sceneMenu' + (b.portraits ? ' wide' : '') });
  for (const opt of b.options) {
    const button = el('button', { class: 'sopt' });
    if (b.portraits) {
      button.appendChild(artEl(partyArt(opt), opt, 96));
    }
    button.appendChild(el('span', {}, opt));
    button.onmouseenter = () => send({ t: 'scene-hover', beatIndex: gate.index, option: opt });
    button.onclick = () => send({ t: 'scene-choose', key: b.key, value: opt });
    menu.appendChild(button);
  }
  box.appendChild(menu);
}

// ---------------------------------------------------------------- overworld
const OW = { keys: {}, moving: false, pos: null, seq: [0, 1, 2, 1], seqi: 1, animDist: 0, imgs: {}, lastSent: null, sentAt: 0 };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const view = App.view;
  // The combat loop, fully keyboard-driven: gauge fills → the menu pops with
  // ATTACK under the cursor → arrows + Enter pick the action → arrows + Enter
  // pick the target. Escape steps back one level. Clicking works throughout.
  if (view && view.mode === 'battle') {
    const m = me();
    const myTurn = m && m.holding && !m.down && !view.battle.over;
    const subsOpen = $('subs').classList.contains('open');
    const confirm = ['Enter', ' ', 'z', 'Z'].includes(e.key);
    if (armed && armedMode() !== 'item-pick') {
      // target selection
      const list = targetList();
      if (list.length && ['ArrowLeft', 'ArrowUp'].includes(e.key)) { kselIdx--; e.preventDefault(); rerender(); return; }
      if (list.length && ['ArrowRight', 'ArrowDown'].includes(e.key)) { kselIdx++; e.preventDefault(); rerender(); return; }
      if (list.length && confirm) {
        e.preventDefault();
        const t = kselTarget();
        if (t) targetClicked(t);
        rerender();
        return;
      }
      if (e.key === 'Escape') { armed = null; $('subs').classList.remove('open'); rerender(); return; }
      return;
    }
    if (subsOpen && myTurn) {
      // competence / element submenu
      const subs = [...$('subs').querySelectorAll('.sub')];
      if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { subCursor = (subCursor - 1 + subs.length) % subs.length; e.preventDefault(); markSubCursor(); return; }
      if (['ArrowDown', 'ArrowRight'].includes(e.key)) { subCursor = (subCursor + 1) % subs.length; e.preventDefault(); markSubCursor(); return; }
      if (confirm && subs[subCursor]) { e.preventDefault(); subs[subCursor].click(); return; }
      if (e.key === 'Escape') { $('subs').classList.remove('open'); rerender(); return; }
      return;
    }
    if (armed && armedMode() === 'item-pick' && myTurn) {
      // Objects: arrows walk the usable items in the column
      if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { itemCursor--; e.preventDefault(); rerender(); return; }
      if (['ArrowDown', 'ArrowRight'].includes(e.key)) { itemCursor++; e.preventDefault(); rerender(); return; }
      if (confirm && itemRows.length) {
        e.preventDefault();
        const it = itemRows[((itemCursor % itemRows.length) + itemRows.length) % itemRows.length];
        itemClicked(it.name, it.n);
        return;
      }
      if (e.key === 'Escape') { armed = null; rerender(); return; }
      return;
    }
    if (myTurn) {
      // the action menu — cursor starts on ATTACK every turn
      const usable = MENU_BTNS.filter(b => !$(b).disabled);
      if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { menuIdx = (menuIdx - 1 + usable.length) % usable.length; e.preventDefault(); setSel(usable[menuIdx]); return; }
      if (['ArrowDown', 'ArrowRight'].includes(e.key)) { menuIdx = (menuIdx + 1) % usable.length; e.preventDefault(); setSel(usable[menuIdx]); return; }
      if (confirm && usable.length) { e.preventDefault(); $(usable[Math.min(menuIdx, usable.length - 1)]).click(); return; }
      return;
    }
  }
  if (e.key.startsWith('Arrow') || 'wasd'.includes(e.key)) { OW.keys[e.key] = true; e.preventDefault(); }
  if ((e.key === 'e' || e.key === 'E' || e.key === ' ') && view && view.mode === 'overworld') tryExamine();
});
addEventListener('keyup', e => { OW.keys[e.key] = false; });

function owImage(path) {
  if (!path) return null;
  if (!OW.imgs[path]) { const i = new Image(); i.src = `/assets/${path}`; OW.imgs[path] = i; }
  return OW.imgs[path];
}

const UNWALKABLE = { water: 1, void: 1, inkwall0: 1 };
const SOLID = { crate: 1, barrel: 1, cabinet: 1, bottles: 1, counter: 1, plant: 1, stack: 1, lamp: 1, sign: 1, bed: 1, shelf: 1, vat: 1, rock: 1, greyblock: 1 };

function walkableAt(room, x, y) {
  if (!room) return true;
  const w = room.w || 384, h = room.h || 288;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (room.imported && room.grid) {
    if (room.grid[Math.floor(y / 16)]?.[Math.floor(x / 16)] !== '1') return false;
    for (const p of room.props || []) if (SOLID[p.t] && x >= p.x && x < p.x + (p.w || 24) && y >= p.y && y < p.y + 24) return false;
    for (const s of room.structs || []) if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return false;
    return true;
  }
  let ok = false;
  for (const f of room.floors || []) if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) ok = !UNWALKABLE[f.p];
  for (const s of room.structs || []) if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) ok = false;
  for (const p of room.props || []) if (SOLID[p.t] && x >= p.x && x < p.x + (p.w || 24) && y >= p.y && y < p.y + 24) ok = false;
  return ok;
}

function tryExamine() {
  const view = App.view, room = view.room;
  if (!room) return;
  const pos = OW.pos || view.positions[seat];
  if (!pos) return;
  for (const p of room.pieces || []) {
    if (Math.abs(p.x - pos.x) < 26 && Math.abs(p.y - pos.y) < 26) {
      if (p.kind === 'keypad') {
        const code = prompt('The keypad waits.');
        if (code != null) send({ t: 'keypad', pieceId: p.id, code });
      } else send({ t: 'examine', pieceId: p.id });
      return;
    }
  }
}

// Walking is client-predicted: the local sprite moves every animation frame and
// never waits for the server. Positions sync to the server on a throttle; the
// server echo is ignored for our own sprite unless it disagrees hard (a GM
// teleport or room change), so the ~180ms state broadcast can't rubber-band us.
let owPrevT = 0;
function owLoop(t) {
  requestAnimationFrame(owLoop);
  const view = App.view;
  const dt = Math.min(0.05, Math.max(0, (t - owPrevT) / 1000));
  owPrevT = t;
  if (!view || view.mode !== 'overworld' || view.paused || view.scene) return;
  const room = view.room;
  const sp = view.positions[seat];
  if (!sp) return;
  const roomKey = (room && room.id) || view.location.name;
  if (!OW.pos || OW.roomKey !== roomKey || Math.abs(sp.x - OW.pos.x) + Math.abs(sp.y - OW.pos.y) > 48) OW.pos = { ...sp };
  OW.roomKey = roomKey;
  let { x, y, facing } = OW.pos;
  const spd = 88 * dt;
  let dx = 0, dy = 0;
  if (OW.keys.ArrowUp || OW.keys.w) { dy = -spd; facing = 3; }
  else if (OW.keys.ArrowDown || OW.keys.s) { dy = spd; facing = 0; }
  else if (OW.keys.ArrowLeft || OW.keys.a) { dx = -spd; facing = 1; }
  else if (OW.keys.ArrowRight || OW.keys.d) { dx = spd; facing = 2; }
  const moved = dx !== 0 || dy !== 0;
  OW.moving = moved;
  if (moved) {
    const nx = x + dx, ny = y + dy;
    if (walkableAt(room, nx + 4, ny + 12) && walkableAt(room, nx + 12, ny + 12)) { x = nx; y = ny; }
    OW.animDist += Math.abs(dx) + Math.abs(dy);
    OW.seqi = Math.floor(OW.animDist / 11) % 4;
  } else OW.seqi = 1;
  OW.pos = { x, y, facing };
  const rp = { x: Math.round(x), y: Math.round(y), facing };
  const ls = OW.lastSent;
  if ((!ls || ls.x !== rp.x || ls.y !== rp.y || ls.facing !== rp.facing) && t - OW.sentAt >= 90) {
    send({ t: 'move', ...rp });
    OW.lastSent = rp;
    OW.sentAt = t;
  }
  drawOverworld();
}
requestAnimationFrame(owLoop);

let owPhase = 0;
setInterval(() => { owPhase = !owPhase; }, 380);

function drawOverworld() {
  const view = App.view;
  const c = $('owCanvas');
  const room = view.room || { w: 384, h: 288, floors: [{ p: 'plain', x: 0, y: 0, w: 384, h: 288 }], structs: [], props: [], pieces: [] };
  const holder = $('owWrap');
  const scale = Math.max(1, Math.floor(Math.min(holder.clientWidth / 384, holder.clientHeight / 288)));
  c.width = 384; c.height = 288;
  c.style.width = `${384 * scale}px`; c.style.height = `${288 * scale}px`;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  const pals = App.staticData.palettes;
  const pal = paletteFor(room, pals);
  const pos = OW.pos || view.positions[seat] || { x: 48, y: 48 };
  const camX = Math.round(Math.max(0, Math.min((room.w || 384) - 384, pos.x - 192)));
  const camY = Math.round(Math.max(0, Math.min((room.h || 288) - 288, pos.y - 144)));
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = '#000'; x.fillRect(0, 0, 384, 288);
  x.translate(-camX, -camY);
  // Canon rooms blit their composed tilemap; the above-hero overlay draws
  // after the sprites, at the end of this function.
  let canonOverlay = null, canonCr = null;
  if (room.imported) {
    const cr = canonRoom(room.imported, room.chipset || room.nativeChipset || 'yellow.png');
    if (cr.ready) {
      x.drawImage(cr.ground, 0, 0);
      drawCanonCond(x, cr, room.condOn, 'ground');   // GM-toggled scenery (hidden doors)
      canonOverlay = cr.overlay; canonCr = cr;
    }
  } else {
    // A hot-folder room image (assets/rooms/<room name>.png) IS the room's look,
    // stretched to the room's size; the shapes underneath become invisible
    // collision. No image → the kit draws the shapes as before.
    const bgPath = (room.backdrop === 'image' && room.image) || roomArt(view.location.name);
    if (bgPath) {
      const img = owImage(bgPath);
      if (img && img.complete && img.width) x.drawImage(img, 0, 0, room.w || 384, room.h || 288);
    } else {
      drawRoomKit(x, room, pal, owPhase);
    }
  }
  // staged pieces (visible only — the server already filtered hidden ones)
  for (const p of room.pieces || []) {
    if (p.sprite) {
      const img = owImage(p.sprite);
      if (img && img.complete) {
        const cw = Math.floor(img.width / 3), ch = Math.floor(img.height / 4);
        x.drawImage(img, cw, ch * 2, cw, ch, p.x, p.y - ch + 16, cw, ch);   // row 2 = down-facing
        continue;
      }
    }
    x.fillStyle = '#f4f2ec';
    x.font = '16px "OFF Display"';
    x.fillText(p.g || '◇', p.x, p.y + 12);
  }
  // party tokens, each client cameras on its own sprite
  for (const [pid, sp] of Object.entries(view.positions || {})) {
    if (pid === 'GM') {
      // The GM's avatar, walking among the party.
      if (!view.gmAvatar) continue;
      const gimg = view.gmAvatar.sprite ? owImage(view.gmAvatar.sprite) : null;
      const gx2 = Math.round(sp.x), gy2 = Math.round(sp.y);
      if (gimg && gimg.complete && gimg.width) {
        const cw = Math.floor(gimg.width / 3), ch = Math.floor(gimg.height / 4);
        const rowMapG = [2, 3, 1, 0];
        x.drawImage(gimg, cw, rowMapG[sp.facing || 0] * ch, cw, ch, gx2 - 4, gy2 - ch + 16, cw, ch);
      } else {
        x.fillStyle = '#000'; x.fillRect(gx2 - 1, gy2 - 1, 18, 18);
        x.fillStyle = '#f4f2ec'; x.fillRect(gx2, gy2, 16, 16);
      }
      x.font = '10px "OFF Display"';
      x.fillStyle = '#f4f2ec';
      x.fillText((view.gmAvatar.name || 'GM').slice(0, 12).toUpperCase(), gx2 - 6, gy2 + 26);
      continue;
    }
    const pm = view.party.find(z => z.id === pid);
    if (!pm) continue;
    // Only members actually present walk the map — no idle sprites for empty seats.
    if (pid !== seat && (pm.benched || !(view.connected || []).includes(pid))) continue;
    const pp = pid === seat && OW.pos ? OW.pos : sp;   // our own sprite draws predicted, never the echo
    const px = Math.round(pp.x), py = Math.round(pp.y);
    const art = partyArt(pm.klass);
    const img = art.sprite ? owImage(art.sprite) : null;
    if (img && img.complete) {
      const cw = Math.floor(img.width / 3), ch = Math.floor(img.height / 4);
      const rowMap = [2, 3, 1, 0];   // facing 0=down,1=left,2=right,3=up → sheet rows top-to-bottom: up, right, down, left
      const col = pid === seat ? OW.seq[OW.seqi] : 1;
      x.drawImage(img, col * cw, rowMap[pp.facing || 0] * ch, cw, ch, px - 4, py - ch + 16, cw, ch);
    } else {
      x.fillStyle = '#000'; x.fillRect(px - 1, py - 1, 18, 18);
      x.fillStyle = pid === seat ? '#f2a71b' : '#f4f2ec'; x.fillRect(px, py, 16, 16);
    }
    x.font = '10px "OFF Display"';
    x.fillStyle = pid === seat ? '#f2a71b' : '#f4f2ec';
    x.fillText(pm.name.slice(0, 10).toUpperCase(), px - 6, py + 26);
  }
  if (canonOverlay) x.drawImage(canonOverlay, 0, 0);   // above-hero tiles cover sprites
  if (canonCr) drawCanonCond(x, canonCr, room.condOn, 'above');
}

function paletteFor(room, pals) {
  const p = pals[room.palette] || null;
  if (!p) {
    const z = App.view ? App.view.location.zone : 'Zone 1';
    const map = { 'Zone 1': ['#2e6d9e', '#1d4b70', '#7fa8c6', '#cfe3f2'], 'Zone 2': ['#c8871c', '#8a5c10', '#e0b56a', '#f4e2bb'], 'Zone 3': ['#2f9e44', '#1d6b2d', '#7fc68f', '#c9ecc9'], 'The Room': ['#d0231f', '#8f1512', '#e07f7c', '#f2c9c7'] };
    const [base, dark, lite, pale] = map[z] || map['Zone 1'];
    return { base, dark, lite, pale };
  }
  return { base: p.base, dark: shadeHex(p.base, .62), lite: p.pale, pale: p.tint };
}
function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const cl = v => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((cl(n >> 16) << 16) | (cl((n >> 8) & 255) << 8) | cl(n & 255)).toString(16).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- shop
let shopMode = null, shopSel = null;
const ZLINES = {
  buy: ['Take a look. Nothing here you don’t need.', 'Business is slow when the smoke is thick.'],
  sell: ['The characters are starting to pile up, aren’t they?', 'I pay half. Sentiment costs extra.'],
  bought: ['A fine choice.', 'It will not save you, but it will help.', 'Pleasure doing business.'],
  sold: ['Into the pile it goes.', 'One man’s trash, hm?'],
  poor: ['Come back when your pockets are heavier.'],
  leave: ['Off so soon? The road is long, friend.'],
  hello: ['Welcome, welcome. Everything has a price — even mercy.'],
};
const zline = k => ZLINES[k][Math.floor(Math.random() * ZLINES[k].length)];

function renderShop(view) {
  const wrap = $('shopWrap');
  if (!view.shop.open) {
    wrap.innerHTML = '<div style="position:absolute;inset:0;background:#1c1c1c;display:flex;align-items:center;justify-content:center;font-family:var(--disp);text-transform:uppercase;font-size:30px;color:#777">ZACHARIE IS ARRANGING HIS WARES…</div>';
    return;
  }
  wrap.innerHTML = `
  <div style="position:absolute;inset:0;background:#565656;display:flex;flex-direction:column;overflow:hidden;
       background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.14) 0 34px,transparent 34px 68px)">
    <div style="background:#1c1c1c;padding:8px 0 12px;text-align:center;border-bottom:6px solid rgba(0,0,0,.35)">
      <span style="font-family:var(--disp);text-transform:uppercase;font-size:48px;letter-spacing:4px;text-shadow:3px 3px 0 #000">SHOP</span>
    </div>
    <div style="flex:1;position:relative;display:flex;align-items:flex-start;justify-content:center;padding-top:6vh">
      <div id="shopMenu" style="display:flex;flex-direction:column;gap:14px;z-index:2"></div>
      <div id="shopTag" style="position:absolute;left:4%;top:8%;background:#f5d31c;color:#1c1c1c;font-family:var(--disp);text-transform:uppercase;font-size:26px;
        padding:2px 36px 4px 20px;clip-path:polygon(0 0,calc(100% - 20px) 0,100% 50%,calc(100% - 20px) 100%,0 100%);
        filter:drop-shadow(3px 3px 0 rgba(0,0,0,.45));display:none;cursor:pointer"></div>
      <div id="shopList" style="position:absolute;left:26%;top:8%;display:none;flex-direction:column;gap:2px;z-index:2;min-width:420px;max-height:70%;overflow-y:auto"></div>
      <div style="position:absolute;left:5%;bottom:4%;display:flex;align-items:flex-end;gap:8px">
        <div style="text-align:center"><div style="font-size:76px;color:#cfcfcf;text-shadow:3px 0 #0a0a0a,-3px 0 #0a0a0a,0 3px #0a0a0a,0 -3px #0a0a0a">♚</div>
        <div style="width:150px;height:26px;background:#9c9c9c;border:3px solid #0a0a0a;margin-top:-8px"></div></div>
        <div style="position:relative;background:#cfcfcf;color:#1c1c1c;border:3px solid #0a0a0a;padding:16px 22px;max-width:420px;font-size:15px;line-height:1.5;margin-bottom:60px;border-radius:18px">
          <span id="shopBubble">${zline('hello')}</span>
          <div id="shopPrice" style="position:absolute;left:30px;bottom:-46px;background:#f2f0ea;color:#1c1c1c;border:3px solid #0a0a0a;
            font-family:var(--disp);text-transform:uppercase;font-size:24px;padding:2px 20px;min-width:150px;display:none">$ <b id="shopPval" style="float:right;font-weight:400"></b></div>
        </div>
      </div>
      <div style="position:fixed;right:16px;bottom:14px;display:flex;align-items:center;gap:10px;z-index:3">
        <div style="background:#1c1c1c;border:3px solid #0a0a0a;font-family:var(--disp);text-transform:uppercase;font-size:26px;color:#f5d31c;padding:0 16px 2px">$${view.credits}</div>
      </div>
    </div>
  </div>`;
  const menu = wrap.querySelector('#shopMenu');
  const mkRibbon = (label, fn, sel) => {
    const r = el('button', {
      style: `position:relative;background:${sel ? '#0a0a0a' : '#f2f0ea'};color:${sel ? '#f5d31c' : '#1c1c1c'};font-family:var(--disp);text-transform:uppercase;font-size:30px;letter-spacing:2px;border:0;cursor:pointer;padding:2px 46px 4px 34px;text-align:center;min-width:230px;clip-path:polygon(0 0,calc(100% - 22px) 0,100% 50%,calc(100% - 22px) 100%,0 100%);filter:drop-shadow(3px 3px 0 rgba(0,0,0,.45))`,
    }, label);
    r.onclick = fn;
    return r;
  };
  menu.appendChild(mkRibbon('Buy', () => { shopMode = 'buy'; shopSel = null; say(zline('buy')); renderShopList(view); }));
  menu.appendChild(mkRibbon('Sell', () => { shopMode = 'sell'; shopSel = null; say(zline('sell')); renderShopList(view); }));
  menu.appendChild(mkRibbon('Leave', () => say(zline('leave'))));
  if (shopMode) renderShopList(view);

  function say(t) { const b = wrap.querySelector('#shopBubble'); if (b) b.textContent = t; }

  function renderShopList(v) {
    menu.style.display = 'none';
    const tag = wrap.querySelector('#shopTag');
    tag.style.display = 'block';
    tag.textContent = shopMode === 'buy' ? 'Buy' : 'Sell';
    tag.onclick = () => { shopMode = null; shopSel = null; menu.style.display = 'flex'; tag.style.display = 'none'; wrap.querySelector('#shopList').style.display = 'none'; say('Anything else?'); };
    const list = wrap.querySelector('#shopList');
    list.style.display = 'flex';
    list.innerHTML = '';
    let rows = [];
    if (shopMode === 'buy') {
      rows = v.shop.stock.map(s => ({ name: s.name, price: s.price, desc: s.desc, n: null }));
    } else {
      for (const [name, n] of Object.entries(v.inventory)) if (n > 0) rows.push({ name, n, price: sellGuess(v, name), desc: '' });
      for (const name of Object.keys(v.gearOwned || {})) rows.push({ name, n: 1, price: sellGuess(v, name), desc: v.wornBy[name] ? `worn by ${v.wornBy[name]}` : 'equipment' });
    }
    for (const r of rows) {
      const selRow = shopSel === r.name;
      const broke = shopMode === 'buy' && v.credits < r.price;
      const row = el('div', {
        style: `display:flex;align-items:center;gap:12px;padding:4px 16px;cursor:pointer;color:${selRow ? '#f5d31c' : '#9c9c9c'};background:${selRow ? '#0a0a0a' : 'transparent'};opacity:${broke ? .4 : 1}`,
      },
        selRow ? el('span', { style: 'font-size:24px;color:#f2f0ea;text-shadow:2px 2px 0 #000' }, '☞') : null,
        el('span', { style: 'font-family:var(--disp);text-transform:uppercase;font-size:26px;letter-spacing:1px;flex:1' }, r.name + (r.n != null ? ` ×${r.n}` : '')),
        el('span', { style: 'font-family:var(--disp);text-transform:uppercase;font-size:22px' }, `$${r.price}`));
      row.onclick = () => {
        if (shopSel === r.name) {
          if (shopMode === 'buy') { if (broke) { say(zline('poor')); return; } send({ t: 'shop-buy', name: r.name }); say(zline('bought')); }
          else { send({ t: 'shop-sell', name: r.name }); say(zline('sold')); }
          return;
        }
        shopSel = r.name;
        const item = App.staticData.items.catalog.find(c => c.name === r.name);
        say(item ? item.desc : r.desc || r.name);
        const pt = wrap.querySelector('#shopPrice');
        pt.style.display = 'block';
        wrap.querySelector('#shopPval').textContent = r.price;
        renderShopList(v);
      };
      list.appendChild(row);
    }
  }
}

function sellGuess(view, name) {
  const it = App.staticData.items.catalog.find(c => c.name === name);
  const mult = { 'Zone 1': 1, 'Zone 2': 1, 'Zone 3': 1.5, 'The Room': 2, 'Purified': 2 }[view.location.zone] || 1;
  if (it && it.priceZ1 != null) return Math.floor(it.priceZ1 * mult / 2);
  for (const cat of Object.values(App.staticData.gear.categories)) {
    const g = (cat.items || []).find(i => i.name === name);
    if (g && g.price != null) return Math.floor(g.price / 2);
  }
  return 0;
}

// ---------------------------------------------------------------- character sheet
window.toggleSheet = () => { sheetOpen = !sheetOpen; $('sheet').classList.toggle('open', sheetOpen); if (sheetOpen) renderSheet(); };

function renderSheet() {
  const view = App.view;
  const m = view.party.find(p => p.id === seat);
  if (!m || !m.stats) return;
  const body = $('sheetBody');
  body.innerHTML = '';
  body.appendChild(el('h2', {}, `${m.name} — ${(m.klass || '').toUpperCase()} · LV ${m.level} · ${m.element.toUpperCase()}`));
  const s = m.stats;
  body.appendChild(el('h3', {}, 'STATS'));
  const grid = el('div', { class: 'sgrid' });
  for (const [k, v] of Object.entries({ HP: `${m.hp}/${s.hp}`, CP: `${m.cp}/${s.cp}`, ATK: s.atk, ESP: s.esp, DEF: s.def, AGI: `${s.agi} (${(40 / s.agi).toFixed(1)}s)`, LCK: `${s.lck}%`, RES: s.res })) {
    grid.appendChild(el('div', {}, `${k} ${v}`));
  }
  body.appendChild(grid);

  body.appendChild(el('h3', {}, 'EQUIPMENT — PICK A SLOT'));
  const inBattle = view.battle && view.mode === 'battle';
  const slotLabels = { offensive: 'OFFENSIVE', defensive1: 'DEFENSIVE 1', defensive2: 'DEFENSIVE 2', defensive3: 'DEFENSIVE 3', special: 'SPECIAL' };
  for (const [slot, label] of Object.entries(slotLabels)) {
    const worn = m.equipment[slot];
    const row = el('div', { class: 'slotrow' }, el('span', { class: 'sl' }, label), el('span', { class: 'sv' }, worn || '—'));
    row.onclick = () => { if (!inBattle) openSlotPicker(slot); };   // equipment swaps out of combat only
    body.appendChild(row);
    const pickerHost = el('div', { id: `picker-${slot}` });
    body.appendChild(pickerHost);
  }
  if (inBattle) body.appendChild(el('div', { style: 'font-size:11px;color:#886' }, 'Equipment swaps out of combat only.'));

  body.appendChild(el('h3', {}, 'COMPETENCES'));
  const table = el('table', { class: 'comps' });
  for (const c of m.competences) {
    const tr = el('tr', { class: c.unlocked ? '' : 'locked' },
      el('td', { class: 'cn' }, c.name), el('td', {}, `${c.cp} CP`), el('td', {}, `lv${c.level}`), el('td', {}, c.effect));
    table.appendChild(tr);
  }
  body.appendChild(table);
  body.appendChild(el('h3', {}, 'PASSIVES'));
  for (const p of m.passives) {
    body.appendChild(el('div', { style: `font-size:12px;margin-bottom:4px;${p.active ? '' : 'opacity:.4'}` },
      el('b', { style: 'font-family:var(--disp);text-transform:uppercase;font-size:17px' }, `${p.name} (${p.level}) `), p.effect));
  }
  if (Object.keys(m.flavor || {}).length || m.gender) {
    body.appendChild(el('h3', {}, 'SOUL'));
    const f = m.flavor || {};
    body.appendChild(el('div', { class: 'flavor' },
      `${m.gender ? m.gender + ' · ' : ''}${f.desire ? 'Desires: ' + f.desire + ' · ' : ''}${f.fear ? 'Fears: ' + f.fear + ' · ' : ''}${f.virtue ? 'Virtue: ' + f.virtue : ''}${f.finalFeeling ? ' · Felt: ' + f.finalFeeling : ''}`));
  }
}

function openSlotPicker(slot) {
  const view = App.view;
  const m = view.party.find(p => p.id === seat);
  const host = $(`picker-${slot}`);
  if (!host) return;
  if (host.childNodes.length) { host.innerHTML = ''; return; }
  const list = el('div', { class: 'pickerlist' });
  // The slot is the menu: only this slot's legal items, filtered to owned copies;
  // shared-pool items worn by someone else show greyed with the wearer's name.
  const unequip = el('div', { class: 'pk' }, el('span', { class: 'n' }, '— unequip —'));
  unequip.onclick = () => { send({ t: 'equip', slot, item: null }); host.innerHTML = ''; };
  list.appendChild(unequip);
  for (const [catName, cat] of Object.entries(App.staticData.gear.categories)) {
    if (cat.slot !== slot) continue;
    if (Array.isArray(cat.wearers) && !cat.wearers.includes(m.klass)) continue;
    for (const item of cat.items || []) {
      if (!view.gearOwned[item.name]) continue;
      const wearer = view.wornBy[item.name];
      const wornElsewhere = wearer && wearer !== m.name;
      const row = el('div', { class: 'pk' + (wornElsewhere ? ' worn' : '') },
        el('span', { class: 'n' }, item.name),
        el('span', { class: 'd' }, `${catName} · ${item.tier}${item.stat ? ` · +${item.value} ${item.stat.toUpperCase()}` : ''}${wornElsewhere ? ` · worn by ${wearer}` : ''}`));
      if (!wornElsewhere) row.onclick = () => { send({ t: 'equip', slot, item: item.name }); host.innerHTML = ''; };
      list.appendChild(row);
    }
  }
  host.appendChild(list);
}
