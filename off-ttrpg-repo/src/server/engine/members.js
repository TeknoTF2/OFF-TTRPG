// Party member construction and effective stats.
// Level tables are the true base stats; GEAR IS ADDITIVE on top (GM ruling).

import { CLASSES } from '../../shared/constants.js';

export function makeMember(data, klass, level = 1) {
  const base = statsAt(data, klass, level);
  return {
    kind: 'player', id: klass, klass, level,
    name: klass,                       // display name, set by the intro's Name gate
    flavor: {},                        // desire / fear / virtue / finalFeeling — mechanically inert
    gender: null,
    element: data.classKits.classes[klass].element,
    elementSet: null,
    hp: base.hp, cp: base.cp,
    statuses: [], statChanges: [],
    gauge: 0, holding: false, critCharged: false, defending: false,
    down: false, sacredUsed: false, turnCount: 0, hastySecond: false,
    equipment: { offensive: null, defensive1: null, defensive2: null, defensive3: null, special: null },
  };
}

export function statsAt(data, klass, level) {
  const row = data.levelTables.classes[klass][String(level)];
  return { hp: row.hp, atk: row.atk, esp: row.esp, def: row.def, agi: row.agi, cp: row.cp, lck: row.lck, res: row.res };
}

// Base stats + permanent orb bonuses + additive gear values.
export function memberBase(data, member) {
  const s = { ...statsAt(data, member.klass, member.level) };
  for (const [stat, amt] of Object.entries(member.orbs || {})) s[stat] = (s[stat] ?? 0) + amt;
  for (const piece of equippedPieces(data, member)) {
    if (piece.stat && typeof piece.value === 'number') s[piece.stat] = (s[piece.stat] ?? 0) + piece.value;
    const fx = piece.effects || {};
    for (const [k, v] of Object.entries(fx)) {
      // flat stat riders inside effects (e.g. Thursday/Friday +2 ATK / +2 ESP)
      if (['hp', 'atk', 'esp', 'def', 'agi', 'cp', 'lck', 'res'].includes(k) && typeof v === 'number') s[k] += v;
    }
  }
  return s;
}

export function equippedPieces(data, member) {
  const out = [];
  for (const slot of Object.keys(member.equipment)) {
    const name = member.equipment[slot];
    if (!name) continue;
    const item = findGearItem(data, name);
    if (item) out.push(item.item);
  }
  return out;
}

export function findGearItem(data, name) {
  for (const [cat, def] of Object.entries(data.gear.categories)) {
    for (const item of def.items || []) {
      if (item.name === name) return { category: cat, def, item };
    }
  }
  return null;
}

// Aggregate active gear effects for a member.
export function gearEffects(data, member) {
  const agg = { crit_immune: false, status_immune: [], res_vs: {}, cp_cost_mult: 1, overworld_tick_immune: false, attack_element: null, hits: 1, accuracy: undefined };
  for (const piece of equippedPieces(data, member)) {
    const fx = piece.effects || {};
    if (fx.crit_immune) agg.crit_immune = true;
    if (fx.status_immune) agg.status_immune.push(...fx.status_immune);
    if (fx.res_vs) for (const [st, n] of Object.entries(fx.res_vs)) agg.res_vs[st] = (agg.res_vs[st] || 0) + n;
    if (typeof fx.cp_cost_mult === 'number') agg.cp_cost_mult *= fx.cp_cost_mult;
    if (fx.attack_element) { agg.attack_element = fx.attack_element; agg.element_rule = fx.element_rule; }
    if (typeof fx.hits === 'number') agg.hits = fx.hits;
    if ('accuracy' in fx) agg.accuracy = fx.accuracy;   // Ashley Bat: null = basic attack cannot miss
  }
  return agg;
}

// Server-authoritative slot validation — the silent backstop behind the slot-first UI.
export function validateEquip(data, member, slot, itemName) {
  if (itemName == null) return { ok: true };
  const found = findGearItem(data, itemName);
  if (!found) return { ok: false, why: 'unknown item' };
  if (found.def.slot !== slot) return { ok: false, why: 'wrong slot' };
  const wearers = found.def.wearers;
  if (Array.isArray(wearers) && !wearers.includes(member.klass)) return { ok: false, why: 'class-locked' };
  return { ok: true };
}

export { CLASSES };
