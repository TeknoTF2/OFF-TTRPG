// Engine rule tests — each test names the doc sentence it locks in.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAll } from '../server/dataload.js';
import { newCampaign } from '../server/state.js';
import { Battle } from '../server/engine/battle.js';
import { elementMult } from '../shared/constants.js';
import { effectiveDef, statusLandingChance, cureChance } from '../server/engine/formulas.js';
import { memberBase } from '../server/engine/members.js';

const data = loadAll();

// rng that returns a fixed sequence (fractions of 1), then falls back to 0.5
function seqRng(...vals) {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : 0.5);
}
const alwaysLow = () => 0.0;    // always "succeeds" rolls (roll < chance)
const alwaysHigh = () => 0.999; // always fails rolls / no crit

function makeBattle({ enemies = [{ template: 'Common Spectre' }], rng = alwaysHigh, party } = {}) {
  const campaign = newCampaign(data);
  if (party) for (const [i, lvl] of party.entries()) campaign.party[i].level = lvl;
  const enc = { name: 'test', waves: [{ trigger: 'launch', queue: enemies }], pool: {} };
  const events = [];
  const logs = [];
  const b = new Battle(data, campaign, enc, { rng, emit: e => events.push(e), log: l => logs.push(l) });
  return { b, campaign, events, logs };
}

function seatOf(campaign, klass) { return campaign.party.find(m => m.klass === klass); }

// ---------- elements ----------
test('element ring: Plastic→Metal→Smoke→Meat→Plastic, 2× next / 0.5× previous', () => {
  assert.equal(elementMult('Plastic', 'Metal'), 2.0);
  assert.equal(elementMult('Metal', 'Smoke'), 2.0);
  assert.equal(elementMult('Smoke', 'Meat'), 2.0);
  assert.equal(elementMult('Meat', 'Plastic'), 2.0);
  assert.equal(elementMult('Metal', 'Plastic'), 0.5);
  assert.equal(elementMult('Plastic', 'Meat'), 0.5);
  assert.equal(elementMult('Plastic', 'Plastic'), 1.0);   // mirror match is neutral
  assert.equal(elementMult('Sugar', 'Meat'), 1.0);        // Sugar neutral both ways
  assert.equal(elementMult('Meat', 'Sugar'), 1.0);
  assert.equal(elementMult(null, 'Meat'), 1.0);           // elementless
});

// ---------- DEF ----------
test('DEF clamps to [−25, 75] and Defend adds +25 flat', () => {
  const t = { kind: 'enemy', def: 70, statChanges: [], defending: true, statuses: [] };
  assert.equal(effectiveDef(t), 75);
  const t2 = { kind: 'enemy', def: -20, statChanges: [{ stat: 'DEF', dir: 'down', amount: 20 }], defending: false, statuses: [] };
  assert.equal(effectiveDef(t2), -25);
});

test('negative DEF amplifies damage', () => {
  const { b } = makeBattle();
  const e = b.enemies[0];
  e.def = -20;
  // finalDamage via a basic attack: Purifier ATK 21, Metal vs Smoke = 2×, DEF −20 → ×1.2
  const p = seatOf(b.campaign, 'Purifier');
  p.holding = true; p.critCharged = false;
  b.rng = seqRng(0, 0.5); // acc roll passes, variance mid (=1.0)
  b.resolveBasicAttack(p, e);
  // 21 × 2.0 × 1.2 = 50.4 → 50; e.hp was 20 → dead with damage recorded
  assert.ok(e.dead);
});

// ---------- statuses ----------
test('status landing: tier base − RES, floor 5, strong immunity absolute', () => {
  assert.equal(statusLandingChance('neutral', 8), 72);
  assert.equal(statusLandingChance('vulnerable', 5), 95);
  assert.equal(statusLandingChance('light_immune', 44), 5);      // floor
  assert.equal(statusLandingChance('strong_immune', 0), null);   // never
  assert.equal(statusLandingChance('light_immune', 20, { corrosion: true }), 60); // light→neutral
  assert.equal(statusLandingChance('neutral', 20, { expertise: true }), 70);      // +10
});

test('one instance only: reapplying a status does nothing', () => {
  const { b } = makeBattle({ rng: alwaysLow });
  const e = b.enemies[0];
  assert.equal(b.tryApplyStatus(e, 'Poisoned', null), true);
  assert.equal(b.tryApplyStatus(e, 'Poisoned', null), false);
  assert.equal(e.statuses.length, 1);
});

test('Madness and Taunted are mutually exclusive', () => {
  const { b } = makeBattle({ rng: alwaysLow });
  const e = b.enemies[0];
  assert.equal(b.tryApplyStatus(e, 'Madness', null), true);
  assert.equal(b.tryApplyStatus(e, 'Taunted', null), false);
});

test('cure chance escalates +5 per turn afflicted; Chain Mastery is RES − 5', () => {
  assert.equal(cureChance(10, 0), 10);
  assert.equal(cureChance(10, 3), 25);
  assert.equal(cureChance(10, 0, true), 5);
});

test('status auto-clears at the start of the 8th turn afflicted', () => {
  const { b } = makeBattle({ rng: alwaysHigh });
  const e = b.enemies[0];
  e.statuses.push({ name: 'Poisoned', applierId: null, applierClass: null, turnsAfflicted: 7 });
  b.runCureChecks(e);
  assert.equal(e.statuses.length, 0);
});

test('stat changes: Up and Down of the same stat cancel on contact; first application holds', () => {
  const { b } = makeBattle();
  const e = b.enemies[0];
  assert.equal(b.applyStatChange(e, { stat: 'ATK', dir: 'up', amount: 15, turns: 2 }), 'applied');
  assert.equal(b.applyStatChange(e, { stat: 'ATK', dir: 'up', amount: 30, turns: 3 }), 'blocked');
  assert.equal(b.applyStatChange(e, { stat: 'ATK', dir: 'down', amount: 20, turns: 2 }), 'cancelled');
  assert.equal(e.statChanges.length, 0);
});

test('element change: one instance, native element cancels, Sugar never legal', () => {
  const { b } = makeBattle();
  const e = b.enemies[0];           // Common Spectre, Smoke
  assert.equal(b.applyElementSet(e, 'Sugar', null), false);
  assert.equal(b.applyElementSet(e, 'Metal', null), true);
  assert.equal(b.applyElementSet(e, 'Plastic', null), false);   // cannot rewrite while running
  assert.equal(b.applyElementSet(e, 'Smoke', null), true);      // native cancels
  assert.equal(e.elementSet, null);
});

test("Sweet Madness: the Burnt's own element can never be changed", () => {
  const { b, campaign } = makeBattle({ party: [2, 2, 2, 2, 2, 2] });
  const burnt = seatOf(campaign, 'Burnt');
  assert.equal(b.applyElementSet(burnt, 'Metal', null), false);
});

test('Taunted ends when the applier dies', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Common Spectre' }, { template: 'Common Spectre' }], rng: alwaysLow });
  const e = b.enemies[0];
  const p = seatOf(campaign, 'Purifier');
  b.tryApplyStatus(p, 'Taunted', e, { force: true });
  assert.ok(p.statuses.some(s => s.name === 'Taunted'));
  b.killEnemy(e, null);
  assert.ok(!p.statuses.some(s => s.name === 'Taunted'));
});

// ---------- turn pipeline ----------
test('Palsied consumes the turn and durations tick', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Palsied', turnsAfflicted: 0 });
  p.statChanges.push({ stat: 'ATK', dir: 'up', amount: 15, turnsLeft: 2, fresh: false });
  p.gauge = 1;
  b.onGaugeFill(p);
  assert.equal(p.holding, false);
  assert.equal(p.gauge, 0);
  assert.equal(p.turnCount, 1);
  assert.equal(p.statChanges[0].turnsLeft, 1);
});

test('Asleep: every second gauge fill resolves as Palsied', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Asleep', turnsAfflicted: 0 });
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.holding, true);    // first fill: acts normally
  p.holding = false; p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.holding, false);   // second fill: consumed
});

test('Madness resolves automatically at fill as a normal Attack on a random party member', () => {
  const alwaysMid = () => 0.5;   // hits accuracy, never crits
  const { b, campaign } = makeBattle({ rng: alwaysMid });
  const p = seatOf(campaign, 'Purifier');
  const before = campaign.party.map(m => m.hp);
  p.statuses.push({ name: 'Madness', turnsAfflicted: 0 });
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.holding, false);   // no input accepted, turn resolved
  const after = campaign.party.map(m => m.hp);
  assert.notDeepEqual(before, after);  // someone in the party got hit
});

test('Defend expires the moment the gauge next fills', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.holding = true;
  b.playerAction(p, { kind: 'defend' });
  assert.equal(p.defending, true);
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.defending, false);
});

test('Poisoned ticks 1/25 max HP at the start of the turn', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');   // 100 max HP at level 1
  p.statuses.push({ name: 'Poisoned', turnsAfflicted: 0 });
  p.gauge = 1; b.onGaugeFill(p);
  assert.equal(p.hp, 96);
});

// ---------- actions ----------
test('dead target refuses input — nothing spent, gauge untouched', () => {
  const { b, campaign } = makeBattle();
  const p = seatOf(campaign, 'Purifier');
  const e = b.enemies[0];
  e.dead = true;
  p.holding = true;
  const res = b.playerAction(p, { kind: 'attack', targetId: e.id });
  assert.equal(res.refuse, true);
  assert.equal(p.holding, true);
});

test('a miss consumes CP and resets the gauge; the rider does not land', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'One-eyed Spectre' }], rng: alwaysHigh });
  const alpha = seatOf(campaign, 'Alpha');
  alpha.level = 5;
  const e = b.enemies[0];
  alpha.holding = true;
  const cpBefore = alpha.cp;
  // Saturated String acc 91; alwaysHigh (99.9) misses.
  const res = b.playerAction(alpha, { kind: 'competence', competence: 'Saturated String', targetId: e.id });
  assert.equal(res.ok, true);
  assert.equal(alpha.cp, cpBefore - 14);
  assert.equal(alpha.holding, false);
  assert.equal(e.hp, e.maxHp);
});

test('pure status competences cannot miss and roll the tier instead', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Common Spectre' }], rng: alwaysLow });
  const alpha = seatOf(campaign, 'Alpha');
  alpha.level = 3;
  const e = b.enemies[0];
  alpha.holding = true;
  const res = b.playerAction(alpha, { kind: 'competence', competence: 'Open Bracket', targetId: e.id });
  assert.equal(res.ok, true);
  assert.ok(e.statuses.some(s => s.name === 'Poisoned'));
});

test('Wide Angle reveals the instance party-wide', () => {
  const { b, campaign } = makeBattle();
  const p = seatOf(campaign, 'Purifier');
  const e = b.enemies[0];
  p.holding = true;
  const res = b.playerAction(p, { kind: 'competence', competence: 'Wide Angle', targetId: e.id });
  assert.equal(res.ok, true);
  assert.ok(b.revealed.has(e.id));
  assert.equal(p.cp, 35 - 2);
});

test('heals cannot crit and cap at max HP', () => {
  const { b, campaign } = makeBattle({ party: [3, 3, 3, 3, 3, 3], rng: seqRng(0.5, 0.5, 0.5) });
  const p = seatOf(campaign, 'Purifier');
  p.critCharged = true;
  const omega = seatOf(campaign, 'Omega');
  omega.hp = 50;
  p.holding = true;
  const res = b.playerAction(p, { kind: 'competence', competence: 'Save First Base', targetId: omega.id });
  assert.equal(res.ok, true);
  // level 3 Purifier ESP 26 × 1.9 = 49.4 → 49 (variance mid = 1.0)
  assert.equal(omega.hp, 99);
});

test('item use costs a full turn and Joker revives at 35% HP, 50% gauge', () => {
  const { b, campaign } = makeBattle();
  campaign.inventory['Joker'] = 1;
  const p = seatOf(campaign, 'Purifier');
  const omega = seatOf(campaign, 'Omega');
  omega.down = true; omega.hp = 0;
  p.holding = true;
  const res = b.playerAction(p, { kind: 'item', item: 'Joker', targetId: omega.id });
  assert.equal(res.ok, true);
  assert.equal(campaign.inventory['Joker'], 0);
  assert.equal(omega.down, false);
  assert.equal(omega.hp, Math.round(memberBase(data, omega).hp * 0.35));
  assert.equal(omega.gauge, 0.5);
  assert.equal(p.holding, false);   // the turn is spent
});

test('Ursa Shot steals from the enemy pool into the party inventory', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'One-eyed Spectre' }], rng: alwaysLow });
  b.pool = { 'Silver Flesh': 1 };
  const bandit = seatOf(campaign, 'Bandit');
  bandit.level = 3;
  bandit.holding = true;
  const res = b.playerAction(bandit, { kind: 'competence', competence: 'Ursa Shot', targetId: b.enemies[0].id });
  assert.equal(res.ok, true);
  assert.equal(b.pool['Silver Flesh'], 0);
  assert.equal(campaign.inventory['Silver Flesh'], 1);
});

// ---------- scripted behaviors ----------
test('Dedan: Half Past auto-fires for AI at ≤40% — Hasty until death, no cure check', () => {
  const { b } = makeBattle({ enemies: [{ template: 'Dedan', control: 'ai' }], rng: alwaysHigh });
  const dedan = b.enemies[0];
  dedan.hp = Math.floor(dedan.maxHp * 0.5);
  dedan.gauge = 1; b.onGaugeFill(dedan);
  assert.ok(dedan.firedTriggers.includes('summon-55'));
  dedan.hp = Math.floor(dedan.maxHp * 0.44);
  dedan.gauge = 1; b.onGaugeFill(dedan);
  assert.ok(dedan.firedTriggers.includes('summon-45'));
  assert.equal(b.enemies.filter(e => e.template === '笑').length, 4);
  dedan.hp = Math.floor(dedan.maxHp * 0.39);
  dedan.gauge = 1; b.onGaugeFill(dedan);
  assert.ok(dedan.firedTriggers.includes('half-past'));
  const hasty = dedan.statuses.find(s => s.name === 'Hasty');
  assert.ok(hasty && hasty.permanent);
});

test('GM-piloted instances get prompts, never auto-fire', () => {
  const { b, events } = makeBattle({ enemies: [{ template: 'Dedan', control: 'gm' }], rng: alwaysHigh });
  const dedan = b.enemies[0];
  dedan.hp = Math.floor(dedan.maxHp * 0.39);
  dedan.gauge = 1; b.onGaugeFill(dedan);
  assert.equal(dedan.holding, true);
  assert.equal(dedan.firedTriggers.length, 0);
  const prompt = events.find(e => e.kind === 'gm-turn');
  assert.ok(prompt && prompt.prompts.length >= 1);
});

test('Rupture-burnt Clock Out: blast hits the party and it dies', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Rupture-burnt', control: 'ai' }], rng: alwaysHigh });
  const e = b.enemies[0];
  e.hp = Math.floor(e.maxHp * 0.2);
  const hpBefore = campaign.party.map(m => m.hp);
  e.gauge = 1; b.onGaugeFill(e);
  assert.ok(e.dead);
  const hpAfter = campaign.party.map(m => m.hp);
  assert.ok(hpAfter.every((h, i) => h < hpBefore[i]));
});

// ---------- flow ----------
test('victory grants assigned drops and credits with a toast', () => {
  const { b, campaign, events } = makeBattle({
    enemies: [{ template: 'Common Spectre', drop: { type: 'item', name: 'Luck Ticket' } }],
  });
  b.killEnemy(b.enemies[0], null);
  assert.equal(b.victory, true);
  assert.equal(campaign.inventory['Luck Ticket'], 1);
  assert.ok(events.some(e => e.kind === 'victory'));
});

test('party wipe: detect, freeze, announce — and then nothing', () => {
  const { b, campaign, events } = makeBattle();
  for (const m of campaign.party) { m.hp = 0; m.down = true; }
  b.checkEnd();
  assert.equal(b.frozen, true);
  assert.equal(b.victory, false);
  assert.ok(events.some(e => e.kind === 'defeat'));
  // enemies remain; inventory untouched — the toll is the GM's to administer
  assert.equal(b.enemies[0].dead, false);
});

test('waves spawn on previous wave death', () => {
  const campaign = newCampaign(data);
  const enc = {
    name: 'w', waves: [
      { trigger: 'launch', queue: [{ template: 'Common Spectre' }] },
      { trigger: 'prev-death', queue: [{ template: 'Common Spectre' }] },
    ], pool: {},
  };
  const b = new Battle(data, campaign, enc, { rng: alwaysHigh, emit: () => {}, log: () => {} });
  assert.equal(b.enemies.length, 1);
  b.killEnemy(b.enemies[0], null);
  assert.equal(b.over, false);
  assert.equal(b.enemies.length, 2);
});

test('gauge seconds: 40/AGI with 1.0s floor; AGI changes shift the rate', () => {
  const { b, campaign } = makeBattle();
  const eps = seatOf(campaign, 'Epsilon');   // AGI 5 → 8.0s
  assert.equal(b.gaugeSeconds(eps), 8);
  eps.statChanges.push({ stat: 'AGI', dir: 'up', amount: 15, turnsLeft: 2 });
  assert.ok(Math.abs(b.gaugeSeconds(eps) - 40 / (5 * 1.15)) < 1e-9);
});

test('Hasty acts twice per fill; the crit applies to the first action only', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Hasty', turnsAfflicted: 0, permanent: true });
  p.critCharged = true;
  p.holding = true;
  b.playerAction(p, { kind: 'defend' });
  assert.equal(p.holding, true);          // second action pending
  assert.equal(p.critCharged, false);     // the second never crits
  b.playerAction(p, { kind: 'defend' });
  assert.equal(p.holding, false);
  assert.equal(p.turnCount, 1);           // one turn, two actions
});

test('Furious substitutes a random affordable competence that can hit the selection', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'One-eyed Spectre' }], rng: seqRng(0.0, 0.0, 0.0, 0.5, 0.5) });
  const p = seatOf(campaign, 'Purifier');
  p.level = 5;
  p.statuses.push({ name: 'Furious', turnsAfflicted: 0 });
  p.holding = true;
  const cpBefore = p.cp;
  const res = b.playerAction(p, { kind: 'attack', targetId: b.enemies[0].id });
  assert.equal(res.ok, true);
  assert.ok(p.cp < cpBefore);   // a competence fired, CP spent normally
});

test('Muted blocks competences but not Attack', () => {
  const { b, campaign } = makeBattle({ rng: alwaysHigh });
  const p = seatOf(campaign, 'Purifier');
  p.statuses.push({ name: 'Muted', turnsAfflicted: 0 });
  p.holding = true;
  const res = b.playerAction(p, { kind: 'competence', competence: 'Powerful Homerun', targetId: b.enemies[0].id });
  assert.equal(res.refuse, true);
  const res2 = b.playerAction(p, { kind: 'attack', targetId: b.enemies[0].id });
  assert.equal(res2.ok, true);
});

test('Sacred Mission: once per battle, survive lethal damage at 1 HP', () => {
  const { b, campaign } = makeBattle({ party: [2, 2, 2, 2, 2, 2] });
  const p = seatOf(campaign, 'Purifier');
  b.applyDamage(p, 9999, {});
  assert.equal(p.hp, 1);
  assert.equal(p.down, false);
  b.applyDamage(p, 9999, {});
  assert.equal(p.down, true);
});

test('AoE rolls per living target and resolves against whoever is alive', () => {
  const { b, campaign } = makeBattle({
    enemies: [{ template: 'Common Spectre' }, { template: 'Common Spectre' }, { template: 'Common Spectre' }],
    rng: alwaysLow,
  });
  const eps = seatOf(campaign, 'Epsilon');
  b.enemies[2].dead = true;
  eps.holding = true;
  const res = b.playerAction(eps, { kind: 'competence', competence: 'Petite Tragedy', targetId: null });
  assert.equal(res.ok, true);
  assert.ok(b.enemies[0].hp < b.enemies[0].maxHp || b.enemies[0].dead);
  assert.ok(b.enemies[1].hp < b.enemies[1].maxHp || b.enemies[1].dead);
});

test('enemy CP drain (Tiburce Partie Quarrée) reduces player CP without damage', () => {
  const { b, campaign } = makeBattle({ enemies: [{ template: 'Tiburce', control: 'gm' }], rng: seqRng(0.0, 0.0) });
  const e = b.enemies[0];
  const p = seatOf(campaign, 'Purifier');
  const cpBefore = p.cp, hpBefore = p.hp;
  e.holding = true;
  const res = b.gmEnemyAction(e, { kind: 'move', move: 'Partie Quarree', targetId: p.id });
  assert.equal(res.ok, true);
  assert.ok(p.cp < cpBefore);
  assert.equal(p.hp, hpBefore);
});
