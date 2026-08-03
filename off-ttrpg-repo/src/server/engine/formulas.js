// Pure combat math, verbatim from the System Document Part 1.
//   raw   = (BaseValue + ATK×Atk% + ESP×Esp%) × MovePower × (1 ± Var)
//   final = raw × element × (1 − DEF/100) × crit
// DEF is clamped to [−25, +75] at resolution time; all DEF modifiers are flat points.

import { elementMult, DEF_MIN, DEF_MAX, DEFEND_BONUS, TIER_BASE } from '../../shared/constants.js';

// One instance per stat per direction means at most one up and one down can never
// coexist (they cancel on contact), so summing the list is safe.
export function statChangeAmount(combatant, stat) {
  let net = 0;
  for (const sc of combatant.statChanges) {
    if (sc.stat !== stat) continue;
    net += sc.dir === 'up' ? sc.amount : -sc.amount;
  }
  return net;
}

// ATK/AGI changes are percentages of the raw number.
export function pctMult(combatant, stat) {
  return 1 + statChangeAmount(combatant, stat) / 100;
}

export function effectiveDef(target) {
  let def = (target.kind === 'player' ? target.base.def : target.def) + statChangeAmount(target, 'DEF');
  if (target.defending) def += DEFEND_BONUS;
  return Math.min(DEF_MAX, Math.max(DEF_MIN, def));
}

export function currentElement(c) {
  return c.elementSet ? c.elementSet.element : c.element;
}

export function hasStatus(c, name) {
  return c.statuses.some(s => s.name === name);
}

// Player attacker numbers after ATK/AGI-style percentage changes.
export function playerAtk(p) { return p.base.atk * pctMult(p, 'ATK'); }
export function playerEsp(p) { return p.base.esp; } // no ESP stat changes exist in the system

// variancePct: e.g. 10 → uniform in [0.90, 1.10]. Deterministic when 0/null.
export function rollVariance(variancePct, rng) {
  if (!variancePct) return 1;
  return 1 + (rng() * 2 - 1) * (variancePct / 100);
}

export function playerRaw(p, { baseValue = 0, atkPct = 0, espPct = 0, movePower = 1, variance = 0 }, rng) {
  const power = baseValue + playerAtk(p) * (atkPct / 100) + playerEsp(p) * (espPct / 100);
  return power * (movePower ?? 1) * rollVariance(variance, rng);
}

// Enemy damage rides dmg_per_action × MovePower (enemy ATK/ESP were deleted with
// enemy AGI; the bestiary's dpa is the calibrated output). ATK stat changes apply
// as percentages of that output.
export function enemyRaw(e, movePower) {
  return e.dpa * (movePower ?? 1) * pctMult(e, 'ATK');
}

export function finalDamage(raw, attackEl, target, { crit = false, ignoresElement = false } = {}) {
  const mult = ignoresElement ? 1 : elementMult(attackEl, currentElement(target));
  const def = effectiveDef(target);
  let dmg = raw * mult * (1 - def / 100);
  if (crit) dmg *= 2;
  return Math.max(0, Math.round(dmg));
}

// Accuracy: per-competence rows already carry final class-modified values.
// Blinded is −20 points on the user. Roll per target; null = cannot miss.
export function accuracyRoll(acc, user, rng) {
  if (acc == null) return true;
  const eff = acc - (hasStatus(user, 'Blinded') ? 20 : 0);
  return rng() * 100 < eff;
}

// Status landing: tier base − target RES, floor 5%, strong immunity absolute.
// alphaMods: { expertise: +10 to landing, corrosion: light→neutral } per the passives.
export function statusLandingChance(tier, targetRes, alphaMods = {}) {
  let t = tier;
  if (alphaMods.corrosion && t === 'light_immune') t = 'neutral';
  const base = TIER_BASE[t];
  if (base == null) return null; // strong immunity: never lands
  let chance = base - targetRes + (alphaMods.expertise ? 10 : 0);
  return Math.max(5, chance);
}

// Cure check at the start of each of the target's turns:
// RES% + 5 per turn already afflicted; the 8th turn afflicted clears with no roll.
// Chain Mastery (Alpha passive): targets afflicted by an Alpha status check at RES − 5.
export function cureChance(res, turnsAfflicted, chainMastery = false) {
  return (chainMastery ? res - 5 : res) + 5 * turnsAfflicted;
}
