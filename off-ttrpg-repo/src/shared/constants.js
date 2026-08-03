// Fixed vocabulary from the System Document. Nothing here is tunable data —
// tunable numbers live in the data JSONs.

// Plastic → Metal → Smoke → Meat → Plastic. 2× to the next, 0.5× to the previous.
// Sugar is neutral both ways; so is elementless (null).
export const RING = ['Plastic', 'Metal', 'Smoke', 'Meat'];

export function elementMult(attackEl, targetEl) {
  if (!attackEl || !targetEl || attackEl === 'Sugar' || targetEl === 'Sugar') return 1.0;
  const a = RING.indexOf(attackEl), t = RING.indexOf(targetEl);
  if (a < 0 || t < 0) return 1.0;
  if ((a + 1) % 4 === t) return 2.0;   // attack beats target
  if ((t + 1) % 4 === a) return 0.5;   // target's element beats the attack's
  return 1.0;                          // neutral, including mirror match
}

export const STATUSES = [
  'Poisoned', 'Blinded', 'Muted', 'Palsied', 'Asleep',
  'Furious', 'Madness', 'Hasty', 'Taunted',
  // Endgame additions (build spec §2), riding the existing status machinery.
  // Thorns/Impure/Defamed carry fixed own-turn durations instead of cure checks;
  // Vilified = Muted; Corrupted (Cob's variant) also locks items.
  'Thorns', 'Famine', 'Impure', 'Vilified', 'Corrupted', 'Defamed',
];

export const FIXED_TURN_STATUSES = { Thorns: 2, Impure: 2, Defamed: 3, Corrupted: 2 };
export const THORNS_FRAC = 0.10;          // of max HP, each time the holder acts
export const FAMINE_FRAC = 2 / 25;        // Poisoned at double tick

export function ringNext(el) { return RING[(RING.indexOf(el) + 1) % 4]; }
export function ringPrev(el) { return RING[(RING.indexOf(el) + 3) % 4]; }

// tier base − target RES, floor 5%; strong immunity is absolute.
export const TIER_BASE = { vulnerable: 100, neutral: 80, light_immune: 45, strong_immune: null };

export const DEF_MIN = -25;
export const DEF_MAX = 75;
export const DEFEND_BONUS = 25;     // flat DEF until the defender's next gauge fill
export const POISON_COMBAT_FRAC = 1 / 25;    // of max HP, per own turn
export const POISON_TRAVEL_FRAC = 1 / 10;    // of max HP, per GM location transition
export const CURE_ESCALATION = 5;   // +5% per turn already afflicted
export const CURE_AUTO_TURN = 8;    // clears automatically at the start of the 8th turn afflicted
export const REVIVE_GAUGE = 0.5;    // revived characters return at 50% gauge
export const CLASSES = ['Purifier', 'Alpha', 'Omega', 'Epsilon', 'Bandit', 'Burnt'];
export const PARTY_SLOTS = 6;
export const ENEMY_SLOTS = 8;
