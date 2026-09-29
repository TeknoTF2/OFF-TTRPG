// Regression locks from the engine review — each test names the rule it holds.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAll } from '../server/dataload.js';
import { newCampaign } from '../server/state.js';
import { Battle } from '../server/engine/battle.js';
import { currentElement } from '../server/engine/formulas.js';

const data = loadAll();
const alwaysLow = () => 0.0;
const alwaysHigh = () => 0.999;
const mid = () => 0.5;
function seqRng(...vals) {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : 0.5);
}

function makeBattle({ enemies = [{ template: 'Common Spectre' }], rng = alwaysHigh, waves, campaign = newCampaign(data) } = {}) {
  const enc = { name: 'test', waves: waves || [{ trigger: 'launch', queue: enemies }], pool: {} };
  const events = [];
  const logs = [];
  const b = new Battle(data, campaign, enc, { rng, emit: e => events.push(e), log: l => logs.push(l) });
  return { b, campaign, events, logs };
}
const seatOf = (c, k) => c.party.find(m => m.klass === k);
const announced = (events, re) => events.filter(e => e.kind === 'announce' && re.test(e.text)).length;

// ---------- Madness: the gauge never holds for a Mad character ----------
test('Madness landing on a holder resolves at the next tick, without a second fill', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.gauge = 1; b.onGaugeFill(p);                          // holding, waiting for input
  b.tryApplyStatus(p, 'Madness', null, { force: true });
  assert.equal(b.playerAction(p, { kind: 'defend' }).refuse, true);   // still no input accepted
  b.tick(0.01);
  assert.equal(p.holding, false, 'the Madness attack resolved');
  assert.equal(p.turnCount, 1);
  assert.equal(p.statuses.find(s => s.name === 'Madness').turnsAfflicted, 0, 'no second cure check for the same fill');
});

test("a Mad Hasty character's second action is a Madness attack too — players and AI alike", () => {
  const { b, campaign, logs } = makeBattle({ rng: mid });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Madness', turnsAfflicted: 0, permanent: true }, { name: 'Hasty', turnsAfflicted: 0, permanent: true });
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.holding, false, 'no second-action prompt left waiting');
  assert.equal(p.turnCount, 1);
  assert.equal(logs.filter(l => l.ev === 'attack' && l.who === p.id && l.madness).length, 2);

  const { b: b2, logs: logs2 } = makeBattle({ enemies: [{ template: 'Dedan', control: 'ai' }], rng: mid });
  const d = b2.enemies[0];
  d.statuses.push({ name: 'Madness', turnsAfflicted: 0, permanent: true }, { name: 'Hasty', turnsAfflicted: 0, permanent: true });
  d.gauge = 1; b2.onGaugeFill(d);
  assert.equal(logs2.filter(l => l.ev === 'attack' && l.who === d.id && l.madness).length, 2);
  assert.equal(logs2.filter(l => l.ev === 'enemy-move').length, 0, 'the AI does not take a normal move while Mad');
});

// ---------- client strings ----------
test('item names never reach Object.prototype: constructor/toString/__proto__ refuse', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Common Spectre', control: 'gm' }] });
  const p = seatOf(campaign, 'Purifier');
  const e = b.enemies[0];
  for (const item of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    p.holding = true;
    assert.equal(b.playerAction(p, { kind: 'item', item, targetId: p.id }).refuse, true);
    e.holding = true;
    assert.equal(b.gmEnemyAction(e, { kind: 'pool-item', item, targetId: p.id }).refuse, true);
  }
  assert.equal(p.holding, true, 'nothing spent');
});

// ---------- the tick after the end ----------
test('party wipe freezes the tick: nobody acts after the defeat in the same tick', () => {
  const { b, campaign, events } = makeBattle({ enemies: [{ template: 'Common Spectre', control: 'ai' }, { template: 'Common Spectre', control: 'ai' }], rng: mid });
  for (const m of campaign.party) if (m.klass !== 'Purifier') { m.down = true; m.hp = 0; }
  const p = seatOf(campaign, 'Purifier'); p.hp = 1;
  const [e1, e2] = b.enemies;
  e1.gauge = 0.999; e2.gauge = 0.999; p.gauge = 0;
  b.tick(1);
  const i = events.findIndex(e => e.kind === 'defeat');
  assert.ok(i >= 0);
  assert.equal(events.slice(i + 1).filter(e => e.kind === 'combat-fx').length, 0);
});

test('the dead take no gauge and roll no cure checks, even when felled earlier in the same tick', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Common Spectre', control: 'ai' }, { template: 'Common Spectre', control: 'ai' }] });
  const [e1, e2] = b.enemies;
  e1.statuses.push({ name: 'Madness', turnsAfflicted: 0 });
  e1.critCharged = false;
  e2.statuses.push({ name: 'Poisoned', turnsAfflicted: 0 });
  e2.hp = 1;
  e1.gauge = 0.999; e2.gauge = 0.999;
  // e1: cure check fails, Madness targets index 1 (e2), hits, mid variance
  b.rng = seqRng(0.999, 0.9, 0.0, 0.5);
  b.tick(0.1);
  assert.equal(e2.dead, true);
  assert.equal(e2.gauge, 0);
  assert.equal(e2.statuses[0].turnsAfflicted, 0, 'no cure check on a corpse');
});

// ---------- scripted triggers ----------
test('a turn-numbered trigger delayed by a consumed turn fires on the next one (Fortuna)', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Fortuna', control: 'ai' }], rng: alwaysHigh });
  const f = b.enemies[0];
  f.gauge = 1; b.onGaugeFill(f);                           // turn 1: idles
  f.statuses.push({ name: 'Palsied', turnsAfflicted: 0 });
  f.gauge = 1; b.onGaugeFill(f);                           // turn 2 consumed
  f.statuses = [];
  f.gauge = 1; b.onGaugeFill(f);                           // turn 3: the flee still comes
  assert.equal(f.fled, true);
});

test('a GM-fired trigger costs the creature nothing: gauge, turn, and hold untouched', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Dedan', control: 'gm' }], rng: alwaysHigh });
  const d = b.enemies[0];
  d.gauge = 0.8;
  assert.equal(b.gmEnemyAction(d, { kind: 'trigger', triggerId: 'half-past' }).ok, true);
  assert.ok(d.statuses.some(s => s.name === 'Hasty'));
  assert.equal(d.gauge, 0.8);
  assert.equal(d.holding, false, 'no Hasty second action handed out without a fill');
  assert.equal(d.turnCount, 0);
  d.gauge = 1; d.holding = true;
  b.gmEnemyAction(d, { kind: 'trigger', triggerId: 'summon-55' });
  assert.equal(d.holding, true, 'still holding: the GM picks its action next');
  assert.equal(d.turnCount, 0);
});

test('allyDied counts real allies only: Facade fakes and summons do not wake the survivor', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Psalmanazar', control: 'ai' }, { template: 'Herodotus', control: 'gm' }], rng: mid });
  const [ps, he] = b.enemies;
  he.holding = true;
  b.gmEnemyAction(he, { kind: 'move', move: 'Facade' });
  b.applyDamage(b.enemies.find(e => e.fake), 1, {});
  b.killEnemy(b.enemies.find(e => e.template === 'Gnosticus' && !e.fake), null);
  assert.ok(!b.pendingTriggers(ps).some(t => t.id === 'survivor'));
  b.killEnemy(he, null);
  assert.ok(b.pendingTriggers(ps).some(t => t.id === 'survivor'));
});

test('a repeating telegraphed trigger telegraphs before every firing (the Batter)', () => {
  const { b, campaign, events } = makeBattle({ enemies: [{ template: 'The Batter', control: 'ai' }], rng: alwaysHigh });
  for (const m of campaign.party) m.hp = 99999;
  const bt = b.enemies[0];
  const fill = () => { bt.gauge = 1; bt.holding = false; b.onGaugeFill(bt); };
  b.elapsed = 40;
  fill();                                                  // telegraph
  fill();                                                  // fire
  b.elapsed = 80;
  fill();                                                  // telegraph again
  fill();                                                  // fire again
  assert.equal(announced(events, /winds up/), 2);
  assert.equal(bt.timers['ultimate-cycle'], 120);
});

test('scripts follow scriptKey: a GM copy keeps its source scripts; Pastel-burnt Body runs Pastel-burnt\'s', () => {
  const campaign = newCampaign(data);
  campaign.templates['Clock Man'] = { ...data.enemiesByName['Dedan'], name: 'Clock Man', scriptKey: 'Dedan' };
  const { b } = makeBattle({ campaign, enemies: [{ template: 'Clock Man' }, { template: 'Pastel-burnt Body' }, { template: 'Psalmanazar' }] });
  const [clock, body, psal] = b.enemies;
  assert.equal(b.allTriggers(clock).length, data.scripts.triggers['Dedan'].length);
  assert.deepEqual(b.moveFx(body, body.moves.find(m => m.n === 'Inhuman Decadence')).statuses, ['Furious', 'Poisoned']);
  assert.ok(b.allTriggers(psal).some(t => t.id === 'survivor'), 'a unit with its own entry keeps it');
});

// ---------- negative space ----------
test('Negative Space blocks Blinded enemies\' crits only once the Omega has it (level 10)', () => {
  const { b, campaign } = makeBattle();
  const omega = seatOf(campaign, 'Omega');
  omega.level = 5;
  const e = b.enemies[0];
  e.lck = 100;
  b.tryApplyStatus(e, 'Blinded', omega, { force: true });
  b.rng = alwaysLow;
  b.rollCrit(e);
  assert.equal(e.critCharged, true);
  assert.equal(b.critBlocked(e, seatOf(campaign, 'Purifier')), false);
  omega.level = 10;
  b.rollCrit(e);
  assert.equal(e.critCharged, false);
});

// ---------- durations ----------
test("an element change from someone else lasts until the end of the changed character's second turn", () => {
  const { b } = makeBattle({ enemies: [{ template: 'Common Spectre', control: 'gm' }] });
  const e = b.enemies[0];
  b.applyElementSet(e, 'Plastic', null);
  let n = 0;
  while (e.elementSet && n < 10) { e.holding = true; b.gmEnemyAction(e, { kind: 'defend' }); n++; }
  assert.equal(n, 2);
});

test("stat changes count the holder's own turns: from outside, the next N; self-applied, the N after the casting turn", () => {
  const { b, campaign } = makeBattle();
  const alpha = seatOf(campaign, 'Alpha');
  b.applyStatChange(alpha, { stat: 'ATK', dir: 'down', amount: 25, turns: 2 });   // an enemy's debuff between turns
  let n = 0;
  while (alpha.statChanges.length && n < 10) { alpha.holding = true; b.playerAction(alpha, { kind: 'defend' }); n++; }
  assert.equal(n, 2);

  // Comic Drama (3 turns with Artistic Mastery) on all allies: the caster's own
  // copy skips the casting turn's countdown; an ally's counts from its next turn.
  const eps = seatOf(campaign, 'Epsilon');
  const pur = seatOf(campaign, 'Purifier');
  eps.level = 3;
  eps.holding = true;
  assert.equal(b.playerAction(eps, { kind: 'competence', competence: 'Comic Drama' }).ok, true);
  const turnsHeld = m => { let k = 0; while (m.statChanges.some(sc => sc.tag === 'drama') && k < 10) { m.holding = true; b.playerAction(m, { kind: 'defend' }); k++; } return k; };
  assert.equal(turnsHeld(eps), 3);
  assert.equal(turnsHeld(pur), 3);
});

// ---------- waves ----------
test('every launch wave spawns at launch', () => {
  const { b } = makeBattle({ waves: [
    { trigger: 'launch', queue: [{ template: 'Common Spectre' }] },
    { trigger: 'launch', queue: [{ template: 'Magnolia' }] }] });
  assert.equal(b.encounter.waves[1].spawned, true);
  assert.equal(b.livingEnemies().length, 2);
});

test('waves come in order: a manual wave holds back the prev-death waves behind it', () => {
  const { b } = makeBattle({ waves: [
    { trigger: 'launch', queue: [{ template: 'Common Spectre' }] },
    { trigger: 'manual', queue: [{ template: 'Magnolia' }] },
    { trigger: 'prev-death', queue: [{ template: 'January' }] }] });
  b.killEnemy(b.enemies[0], null);
  assert.equal(b.encounter.waves[2].spawned, undefined);
  assert.equal(b.over, false);
  b.spawnWave(1, 'manual');                                 // the GM's call
  b.killEnemy(b.enemies.find(e => e.template === 'Magnolia'), null);
  assert.equal(b.encounter.waves[2].spawned, true);
});

test('an encounter where nothing ever spawned is not a victory; the GM is told once', () => {
  const { b, campaign, events } = makeBattle({ enemies: [{ template: 'Nope' }] });
  const p = seatOf(campaign, 'Purifier');
  for (let i = 0; i < 2; i++) { p.holding = true; b.playerAction(p, { kind: 'defend' }); }
  assert.equal(b.victory, false);
  assert.equal(b.over, false);
  assert.equal(events.filter(e => e.kind === 'gm-note').length, 1);
});

// ---------- summons ----------
test('summons stop at the eight enemy slots, real ones first, and the GM is told', () => {
  const queue = [{ template: 'Dedan', control: 'gm' }];
  for (let i = 0; i < 7; i++) queue.push({ template: 'Common Spectre' });
  const { b, events } = makeBattle({ enemies: queue });
  const d = b.enemies[0];
  b.gmEnemyAction(d, { kind: 'trigger', triggerId: 'summon-55' });
  assert.equal(b.livingEnemies().length, 8);
  assert.equal(events.filter(e => e.kind === 'gm-note').length, 1);
  b.killEnemy(b.enemies[1], null);
  b.gmEnemyAction(d, { kind: 'trigger', triggerId: 'summon-45' });
  assert.equal(b.livingEnemies().length, 8);
  const slots = b.livingEnemies().map(e => e.slot);
  assert.equal(new Set(slots).size, 8, 'no two living enemies share a slot');
});

// ---------- control hand-off ----------
test('an enemy handed from GM to AI while holding acts on the next tick without a second fill', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Common Spectre', control: 'gm' }], rng: alwaysHigh });
  const e = b.enemies[0];
  e.statuses.push({ name: 'Poisoned', turnsAfflicted: 0 });
  e.maxHp = e.hp = 250;
  b.tick(10);                                               // fill: cure check + poison, holds for the GM
  assert.equal(e.holding, true);
  const hp1 = e.hp;
  e.control = 'ai';                                         // what the server's toggle does now
  b.tick(0.01);
  assert.equal(e.holding, false, 'it took its held turn');
  assert.equal(e.turnCount, 1);
  assert.equal(e.hp, hp1, 'poison ticked once for the one fill');
  assert.equal(e.statuses[0].turnsAfflicted, 1, 'one cure check for the one fill');
});

// ---------- leaving the field ----------
test('fleeing and fake-vanishing clear the gauge and release the Taunts they applied', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Fortuna', control: 'ai' }, { template: 'Common Spectre' }], rng: alwaysHigh });
  const f = b.enemies[0];
  const p = seatOf(campaign, 'Purifier');
  b.tryApplyStatus(p, 'Taunted', f, { force: true });
  f.gauge = 1; b.onGaugeFill(f);
  f.gauge = 1; b.onGaugeFill(f);                            // flees
  assert.equal(f.fled, true);
  assert.equal(f.holding, false);
  assert.equal(f.gauge, 0);
  assert.ok(!p.statuses.some(s => s.name === 'Taunted'));

  const { b: b2 } = makeBattle({ enemies: [{ template: 'Herodotus', control: 'gm' }], rng: mid });
  const h = b2.enemies[0];
  h.holding = true;
  b2.gmEnemyAction(h, { kind: 'move', move: 'Facade' });
  const fake = b2.enemies.find(e => e.fake);
  fake.gauge = 0.6;
  b2.applyDamage(fake, 1, {});
  assert.equal(fake.dead, true);
  assert.equal(fake.gauge, 0);
});

// ---------- healing ----------
test('healing never lowers HP that sits above max', () => {
  const { b } = makeBattle();
  const e = b.enemies[0];
  e.hp = e.maxHp + 10;
  assert.equal(b.heal(e, 5), 0);
  assert.equal(e.hp, e.maxHp + 10);
});

// ---------- Maldicion ----------
test("Maldicion's reroll can land on any ring element except the one he has", () => {
  const seen = new Set();
  for (const r of [0.0, 0.3, 0.6, 0.9]) {
    const { b } = makeBattle({ enemies: [{ template: 'Maldicion', control: 'gm' }], rng: () => r });
    const e = b.enemies[0];
    const piety = e.moves.find(m => m.n === 'Entropic Piety');
    b.resolveEnemyMove(e, piety, [e]);
    const first = currentElement(e);
    seen.add(first);
    b.resolveEnemyMove(e, piety, [e]);
    assert.notEqual(currentElement(e), first, 'a reroll always changes the element');
  }
  assert.deepEqual([...seen].sort(), ['Meat', 'Metal', 'Plastic', 'Smoke']);
});

test('Clamor Claws before any reroll: no weakness yet, so a random ring element — not always Smoke', () => {
  const dmgAt = r => {
    const { b, campaign } = makeBattle({ enemies: [{ template: 'Maldicion', control: 'gm' }], rng: () => r });
    const e = b.enemies[0];
    const p = seatOf(campaign, 'Purifier');               // Metal
    p.hp = 99999; e.critCharged = false; e.holding = true;
    b.gmEnemyAction(e, { kind: 'move', move: 'Clamor Claws' });
    return 99999 - p.hp;
  };
  // r 0.1 → Plastic (2× vs Metal); r 0.6 → Smoke (0.5× vs Metal)
  assert.ok(dmgAt(0.1) > 2 * dmgAt(0.6));
});

// ---------- passives ----------
test('passives come from the member who has them: duplicates and the bench', () => {
  const { b, campaign } = makeBattle();
  const [p1, p2] = campaign.party;
  p1.klass = 'Purifier'; p2.klass = 'Purifier';
  p1.level = 12; p2.level = 12;
  p1.down = true; p1.hp = 0;
  assert.equal(b.passiveActive('Purifier', 'Purification'), true, 'the standing duplicate carries it');

  const c2 = newCampaign(data);
  const bandit = seatOf(c2, 'Bandit');
  bandit.level = 10; bandit.benched = true;
  c2.inventory['Luck Ticket'] = 1;
  const { b: b2 } = makeBattle({ campaign: c2, rng: alwaysLow });
  assert.equal(b2.passiveActive('Bandit', 'Light Fingers'), false);
  const p = seatOf(c2, 'Purifier');
  p.holding = true;
  b2.playerAction(p, { kind: 'item', item: 'Luck Ticket', targetId: p.id });
  assert.equal(c2.inventory['Luck Ticket'], 0, 'a benched Bandit saves nothing');
});
