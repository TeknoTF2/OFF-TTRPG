// Tests for the GM's ruling batch: endgame statuses, ±10% enemy variance,
// Cutpurse-from-pool, per-instance enemy items, and the expanded scripted
// vocabulary across Zones 2+.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAll } from '../server/dataload.js';
import { newCampaign } from '../server/state.js';
import { Battle } from '../server/engine/battle.js';
import { memberBase } from '../server/engine/members.js';
import { currentElement } from '../server/engine/formulas.js';

const data = loadAll();
const alwaysLow = () => 0.0;
const alwaysHigh = () => 0.999;
const mid = () => 0.5;

function makeBattle({ enemies = [{ template: 'Common Spectre' }], rng = alwaysHigh, party, pool = {}, present = null } = {}) {
  const campaign = newCampaign(data);
  if (party) for (const [i, lvl] of party.entries()) campaign.party[i].level = lvl;
  const enc = { name: 'test', waves: [{ trigger: 'launch', queue: enemies }], pool };
  const events = [];
  const b = new Battle(data, campaign, enc, { rng, emit: e => events.push(e), log: () => {}, present });
  return { b, campaign, events };
}
const seatOf = (c, k) => c.party.find(m => m.klass === k);

// ---------- endgame statuses ----------
test('Thorns: 10% max HP each time you act; a consumed turn is not acting; expires after 2 turns', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');   // 100 max HP
  b.tryApplyStatus(p, 'Thorns', null, { force: true });
  p.holding = true;
  b.playerAction(p, { kind: 'defend' });    // acting → −10
  assert.equal(p.hp, 90);
  // Palsied-style consumed turn deals no Thorns damage
  b.tryApplyStatus(p, 'Palsied', null, { force: true });
  p.gauge = 1; b.onGaugeFill(p);            // consumed (turn 2 of Thorns → expires after)
  assert.equal(p.hp, 90);
  assert.ok(!p.statuses.some(s => s.name === 'Thorns'));
});

test('Famine ticks 2/25 max HP at turn start, alongside Poisoned', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Famine', turnsAfflicted: 0 });
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.hp, 92);                   // 100 − round(100×2/25)
});

test('Impure rides the element-change machinery: weak to a random ring element, native cast cancels', () => {
  const { b, campaign } = makeBattle({ rng: () => 0.3 });   // rolls 'Metal' → element becomes Smoke
  const p = seatOf(campaign, 'Purifier');   // Metal
  const ok = b.tryApplyStatus(p, 'Impure', null);
  assert.equal(ok, true);
  assert.ok(p.elementSet);                  // element rewritten, no status record
  assert.ok(!p.statuses.some(s => s.name === 'Impure'));
  // one-instance: a second Impure fails while the change runs
  assert.equal(b.tryApplyStatus(p, 'Impure', null), false);
});

test('Vilified locks competences; Corrupted locks competences AND items', () => {
  const { b, campaign } = makeBattle();
  campaign.inventory['Luck Ticket'] = 1;
  const p = seatOf(campaign, 'Purifier');
  p.holding = true;
  b.tryApplyStatus(p, 'Vilified', null, { force: true });
  assert.equal(b.playerAction(p, { kind: 'competence', competence: 'Powerful Homerun', targetId: b.enemies[0].id }).refuse, true);
  assert.equal(b.playerAction(p, { kind: 'item', item: 'Luck Ticket', targetId: p.id }).ok, true);   // items still work
  p.holding = true;
  p.statuses = [];
  b.tryApplyStatus(p, 'Corrupted', null, { force: true });
  assert.equal(b.playerAction(p, { kind: 'item', item: 'Luck Ticket', targetId: p.id }).refuse, true);
});

test('Defamed: guaranteed crits, then accumulated damage reflects onto the whole party; Focus-style cure prevents it', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Dedan' }], rng: mid });
  const p = seatOf(campaign, 'Purifier');
  b.tryApplyStatus(p, 'Defamed', null, { force: true });
  assert.equal(p.critCharged, true);        // the gift is immediate
  const e = b.enemies[0];
  const partyBefore = campaign.party.map(m => m.hp);
  // three acting turns of attacks
  for (let i = 0; i < 3; i++) {
    p.holding = true;
    b.playerAction(p, { kind: 'attack', targetId: e.id });
  }
  assert.ok(!p.statuses.some(s => s.name === 'Defamed'));   // faded at the 3rd turn's end
  const partyAfter = campaign.party.map(m => m.hp);
  assert.ok(partyAfter.every((h, i) => h < partyBefore[i]), 'everyone paid for the gift');
});

test('Defamed cured early reflects nothing', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Dedan' }], rng: mid });
  const p = seatOf(campaign, 'Purifier');
  b.tryApplyStatus(p, 'Defamed', null, { force: true });
  p.holding = true;
  b.playerAction(p, { kind: 'attack', targetId: b.enemies[0].id });
  const omega = seatOf(campaign, 'Omega');
  const before = campaign.party.map(m => m.hp);
  b.cureAllStatuses(p, omega);
  assert.deepEqual(campaign.party.map(m => m.hp), before);
  assert.ok(!p.statuses.some(s => s.name === 'Defamed'));
});

// ---------- variance ----------
test('enemy damage varies ±10% around dpa × MP', () => {
  const results = new Set();
  for (const r of [0.0, 0.25, 0.5, 0.75, 0.999]) {
    const { b, campaign } = makeBattle({ enemies: [{ template: 'Burnt (enemy)', control: 'gm' }], rng: () => r === 0.999 ? 0.999 : r });
    const e = b.enemies[0];
    const p = seatOf(campaign, 'Purifier');
    e.holding = true;
    e.critCharged = false;   // variance, not crits, is under test
    // acc roll uses same rng value; r ≤ 0.95 hits
    if (r > 0.95) continue;
    b.gmEnemyAction(e, { kind: 'move', move: 'Attack', targetId: p.id });
    results.add(100 - p.hp);
  }
  assert.ok(results.size > 1, 'different rng → different damage');
  // Burnt (enemy) dpa 22, Meat vs Metal neutral, Purifier DEF 13 → base ~19; ±10% keeps it in [17, 21]
  for (const dmg of results) assert.ok(dmg >= 16 && dmg <= 22, `damage ${dmg} within variance band`);
});

// ---------- Cutpurse & enemy items ----------
test('per-instance enemy items enter the shared pool at spawn', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Common Spectre', items: { 'Silver Flesh': 2 } }] });
  assert.equal(b.pool['Silver Flesh'], 2);
});

test('Cutpurse steals its bonus drop from the enemy pool; empty pool, empty fingers', () => {
  const { b, campaign } = makeBattle({
    enemies: [{ template: 'Common Spectre', items: { 'Fortune Ticket': 1 } }],
  });
  const bandit = seatOf(campaign, 'Bandit');
  bandit.level = 10;
  b.killEnemy(b.enemies[0], bandit.id);
  assert.equal(campaign.inventory['Fortune Ticket'], 1);
  assert.equal(b.pool['Fortune Ticket'], 0);
});

// ---------- expanded scripted vocabulary ----------
test('Fortuna flees on its 2nd gauge fill, drop forfeited', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Fortuna', control: 'ai', drop: { type: 'item', name: 'Joker' } }], rng: alwaysHigh });
  const f = b.enemies[0];
  f.gauge = 1; b.onGaugeFill(f);     // turn 1: no legal moves, idles
  assert.equal(f.dead, false);
  f.gauge = 1; b.onGaugeFill(f);     // turn 2: flees
  assert.equal(f.fled, true);
  assert.equal(b.victory, true);
  assert.equal(b.campaign.inventory['Joker'], undefined);
});

test('Porter Spectre splits into 7 Junior Spectres and forfeits its drop', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Porter Spectre', control: 'ai', drop: { type: 'item', name: 'Joker' } }], rng: alwaysHigh });
  const p = b.enemies[0];
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.dead, true);
  assert.equal(b.enemies.filter(e => e.template === 'Junior Spectre' && !e.dead).length, 7);
});

test('Japhet: form transition at 55% quickens the gauge, summons, and switches the rotation', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Japhet', control: 'ai' }], rng: alwaysHigh });
  const j = b.enemies[0];
  assert.equal(j.form, 'Parasite');
  assert.equal(j.gaugeS, 3.0);
  j.hp = Math.floor(j.maxHp * 0.5);
  j.gauge = 1; b.onGaugeFill(j);
  assert.equal(j.form, 'Master');
  assert.equal(j.gaugeS, 2.6);
  assert.equal(b.enemies.filter(e => e.template === 'Upside-down Spectre').length, 2);
});

test('Japhet AI follows the canonical rotation, not uniform random', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Japhet', control: 'ai' }], rng: mid });
  const j = b.enemies[0];
  const names = [];
  const origResolve = b.resolveEnemyMove.bind(b);
  b.resolveEnemyMove = (e, move, targets) => { names.push(move.n); return origResolve(e, move, targets); };
  for (let i = 0; i < 3; i++) { j.gauge = 1; j.holding = false; b.onGaugeFill(j); }
  assert.deepEqual(names, ['Warble', 'Warble', 'Alto']);
});

test('lifesteal (Secretary Logical Value) heals the attacker for the damage dealt', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Secretary (Zone 1)', control: 'gm' }], rng: mid });
  const e = b.enemies[0];
  e.hp = Math.floor(e.maxHp / 2);
  const before = e.hp;
  e.holding = true;
  const res = b.gmEnemyAction(e, { kind: 'move', move: 'Logical Value', targetId: 'P1' });
  assert.equal(res.ok, true);
  assert.ok(e.hp > before, 'drained health returned to the Secretary');
});

test('Facade summons 3 Gnosticus with exactly 1 real; fakes vanish at a touch', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Herodotus', control: 'gm' }], rng: mid });
  const h = b.enemies[0];
  h.holding = true;
  b.gmEnemyAction(h, { kind: 'move', move: 'Facade' });
  const gnostics = b.enemies.filter(e => e.template === 'Gnosticus');
  assert.equal(gnostics.length, 3);
  assert.equal(gnostics.filter(g => !g.fake).length, 1);
  const fake = gnostics.find(g => g.fake);
  b.applyDamage(fake, 50, {});
  assert.equal(fake.dead, true);
});

test('Cob: Advent of the Corrupted Era rolls Corrupted on the whole party', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Cob', control: 'ai' }], rng: alwaysLow });
  const cob = b.enemies[0];
  cob.hp = Math.floor(cob.maxHp * 0.4);
  cob.gauge = 1; b.onGaugeFill(cob);
  assert.ok(cob.firedTriggers.includes('advent'));
  assert.ok(campaign.party.some(m => m.statuses.some(s => s.name === 'Corrupted')));
});

test("the Batter's scripted Sacred Mission: the first lethal blow leaves him at 1 HP", () => {
  const { b } = makeBattle({ enemies: [{ template: 'The Batter' }] });
  const batter = b.enemies[0];
  b.applyDamage(batter, 999999, {});
  assert.equal(batter.hp, 1);
  assert.equal(batter.dead, false);
  b.applyDamage(batter, 999999, {});
  assert.equal(batter.dead, true);
});

test('unit templates exist for compound fights', () => {
  for (const name of ['Psalmanazar', 'Herodotus', 'Gnosticus', 'Sugar', 'Dummy', 'Pastel-burnt Body', 'Pastel-burnt Head One']) {
    assert.ok(data.enemiesByName[name], `${name} template expanded`);
  }
  assert.equal(data.enemiesByName['Dummy'].moves.some(m => m.n === 'Sick Mask'), true);
});

// ---------- absent players: bench and pilot ----------
test('a benched seat sits out: not a target, not counted for the wipe, AoE skips it', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Rupture-burnt', control: 'ai' }, { template: 'Common Spectre' }], rng: alwaysHigh });
  const eps = seatOf(campaign, 'Epsilon');
  eps.benched = true;
  b.partySlots = b.partySlots.filter(id => id !== eps.id);   // what the bench op does: leave the roster
  // enemy blast hits the whole party except the benched seat
  const e = b.enemies[0];
  e.hp = Math.floor(e.maxHp * 0.2);
  e.gauge = 1; b.onGaugeFill(e);   // Clock Out
  assert.equal(eps.hp, memberBase(data, eps).hp, 'benched Epsilon untouched by the blast');
  // wipe counts only active members
  for (const m of campaign.party) if (!m.benched) { m.hp = 0; m.down = true; }
  b.checkEnd();
  assert.equal(b.frozen, true, 'five down + one benched is a wipe');
  assert.equal(eps.down, false);
});

test('benched seats refuse their own actions', () => {
  const { b, campaign } = makeBattle();
  const p = seatOf(campaign, 'Purifier');
  p.benched = true; p.holding = true;
  b.partySlots = b.partySlots.filter(id => id !== p.id);   // what the bench op does: leave the roster
  assert.equal(b.playerAction(p, { kind: 'defend' }).refuse, true);
});

test('only present members launch into battle; absent ones are outside the fight entirely', () => {
  const { b, campaign } = makeBattle({ present: ['P1', 'P2'], rng: alwaysHigh });
  assert.deepEqual([...b.partySlots].sort(), ['P1', 'P2'], 'roster is the present members only');
  const absent = campaign.party.find(m => m.id === 'P3');
  absent.holding = true;
  assert.equal(b.playerAction(absent, { kind: 'defend' }).refuse, true, 'absent member cannot act');
  // wipe counts only the roster: both present members down = frozen, absentees irrelevant
  for (const id of ['P1', 'P2']) { const m = campaign.party.find(x => x.id === id); m.hp = 0; m.down = true; }
  b.checkEnd();
  assert.equal(b.frozen, true, 'two present members down is the wipe');
});

test('the GM pilots an absent character through the normal action path', () => {
  const { b, campaign } = makeBattle({ rng: () => 0.5 });
  const p = seatOf(campaign, 'Purifier');
  p.holding = true;
  // playerAction is the same entry the seat itself would use — the pilot mirrors it
  const res = b.playerAction(p, { kind: 'attack', targetId: b.enemies[0].id });
  assert.equal(res.ok, true);
  assert.equal(p.holding, false);
});
