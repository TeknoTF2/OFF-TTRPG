// The combat state machine. Server-authoritative; implements the System Document,
// the build spec's engine addenda, and the bestiary — nothing else.
//
// Key rules encoded here (each traceable to a doc sentence):
// - Battles start with both sides at gauge zero; there is no fleeing.
// - The gauge holds at full; Madness is the sole exception.
// - Crits roll when the gauge starts filling and are held visibly.
// - Validate-target-before-initiate: a dead target refuses input, never resolve-then-undo.
// - A miss spends CP and resets the gauge. AoE rolls accuracy per living target.
// - Defend is +25 DEF until the defender's next gauge fill; restores nothing.
// - Item use is a turn, full stop.
// - Statuses: one instance, own-turn durations, RES escalation cure checks, 8th-turn auto-clear.
// - Stat changes: one instance per stat per direction; Up/Down cancel on contact.
// - Element changes: one instance; naming the native element cancels; damage before change.
// - Scripted behaviors auto-fire for AI instances only; GM instances get prompts.
// - AI is uniform random over currently legal moves. No weight system.
// - Party wipe: detect, freeze, announce — and then nothing.

import {
  elementMult, TIER_BASE, REVIVE_GAUGE, POISON_COMBAT_FRAC,
  CURE_AUTO_TURN, ENEMY_SLOTS, RING,
  FIXED_TURN_STATUSES, THORNS_FRAC, FAMINE_FRAC, ringNext, ringPrev,
} from '../../shared/constants.js';
import {
  statChangeAmount, pctMult, effectiveDef, currentElement, hasStatus,
  playerRaw, enemyRaw, finalDamage, accuracyRoll, statusLandingChance, cureChance,
  rollVariance, playerAtk, playerEsp,
} from './formulas.js';
import { memberBase, gearEffects } from './members.js';

let seq = 0;
const uid = p => `${p}${++seq}`;

export class Battle {
  constructor(data, campaign, encounter, { rng = Math.random, emit = () => {}, log = () => {} } = {}) {
    this.data = data;
    this.campaign = campaign;         // party, inventory, credits live here (shared)
    this.encounter = encounter;       // the launched encounter definition (already deep-copied)
    this.rng = rng;
    this.emit = emit;                 // emit(event) → broadcast to clients
    this.logFn = log;
    this.enemies = [];
    this.pool = { ...(encounter.pool || {}) };   // enemy shared object pool
    this.waveIndex = -1;
    this.over = false; this.frozen = false; this.victory = false;
    this.startedAt = Date.now();
    this.partySlots = this.randomizePartySlots();
    this.revealed = new Set();        // enemy instance ids revealed party-wide, lasts the encounter
    this.kills = {};                  // instanceId -> killerId (for Cutpurse)
    this.elapsed = 0;                 // battle seconds, for every-N-seconds scripted cycles
    // Battle begins with both sides at gauge zero; crits roll as gauges start filling.
    for (const m of this.party()) {
      m.gauge = 0; m.holding = false; m.defending = false; m.hastySecond = false;
      this.rollCrit(m);
    }
    this.spawnWave(0, 'launch');
  }

  // ---------- helpers ----------
  party() { return this.campaign.party; }
  livingParty() { return this.party().filter(p => !p.down && !p.benched); }
  activeParty() { return this.party().filter(p => !p.benched); }
  livingEnemies() { return this.enemies.filter(e => !e.dead); }
  memberByClass(k) { return this.party().find(p => p.klass === k); }
  find(id) { return this.party().find(p => p.id === id) || this.enemies.find(e => e.id === id); }

  log(entry) { this.logFn({ t: Date.now() - this.startedAt, ...entry }); }
  announce(text) { this.emit({ kind: 'announce', text }); this.log({ ev: 'announce', text }); }
  float(targetId, text, style) { this.emit({ kind: 'float', targetId, text, style }); }

  randomizePartySlots() {
    const order = this.party().filter(p => !p.benched).map(p => p.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order; // index = formation slot
  }

  // Wrap a combatant with its current base stats (level table + additive gear)
  // for the pure formula functions.
  withBase(c) {
    return c.kind === 'player' ? { ...c, base: memberBase(this.data, c) } : c;
  }

  effLck(c) {
    if (c.kind === 'player') return memberBase(this.data, c).lck;
    return c.lck;
  }

  effRes(c, statusName) {
    let res = c.kind === 'player' ? memberBase(this.data, c).res : c.res;
    if (c.kind === 'player' && statusName) {
      const fx = gearEffects(this.data, c);
      res += fx.res_vs[statusName] || 0;
    }
    return res;
  }

  gaugeSeconds(c) {
    if (c.kind === 'player') {
      const agi = memberBase(this.data, c).agi * pctMult(c, 'AGI');
      return Math.max(1.0, 40 / agi);
    }
    // Enemy AGI is deleted; gauge_s is direct. AGI changes alter how often it acts.
    return Math.max(0.2, c.gaugeS / pctMult(c, 'AGI'));
  }

  rollCrit(c) {
    // Defamed — the crit gift: guaranteed charged crits while it runs.
    if (hasStatus(c, 'Defamed')) { c.critCharged = true; return; }
    // Negative Space: enemies Blinded by Omega cannot roll crits.
    if (c.kind === 'enemy' && this.blindedByOmega(c)) { c.critCharged = false; return; }
    c.critCharged = this.rng() * 100 < this.effLck(c);
  }

  // Template-level scripted passives (Source's per-action self-heal, boss
  // Purification / Sacred Mission mirrors, Chain Mastery on Add-On Alpha).
  templatePassives(e) {
    return (this.data.scripts.passives || {})[e.template] || {};
  }

  // Defamed bookkeeping: everything the afflicted produces is recorded, and
  // reflects onto their whole party when the status fades uncured.
  trackDefamed(user, field, value) {
    const s = user && user.statuses && user.statuses.find(x => x.name === 'Defamed');
    if (!s) return;
    s.ledger = s.ledger || { dmg: 0, heal: 0, buffs: [] };
    if (field === 'buffs') s.ledger.buffs.push(value);
    else s.ledger[field] += value;
  }

  blindedByOmega(c) {
    return c.statuses.some(s => s.name === 'Blinded' && s.applierClass === 'Omega');
  }

  // ---------- waves & spawning ----------
  spawnWave(index, why) {
    const wave = this.encounter.waves[index];
    if (!wave || wave.spawned) return false;
    wave.spawned = true;
    this.waveIndex = index;
    for (const q of wave.queue) this.spawnInstance(q, index);
    this.announce(why === 'launch' ? 'BATTLE TIME.' : `Wave ${index + 1} arrives!`);
    this.log({ ev: 'wave', index, why });
    return true;
  }

  spawnInstance(q, waveIdx) {
    const tmplName = q.template;
    const tmpl = this.campaign.templates[tmplName] || this.data.enemiesByName[tmplName];
    if (!tmpl) { this.announce(`Unknown enemy template: ${tmplName}`); return null; }
    const o = q.overrides || {};
    const inst = {
      kind: 'enemy', id: uid('e'),
      template: tmplName,
      name: q.name || tmplName,
      element: o.element ?? tmpl.element,
      elementSet: null,
      maxHp: o.hp ?? tmpl.hp, hp: o.hp ?? tmpl.hp,
      def: o.def ?? tmpl.def ?? 0,
      res: o.res ?? tmpl.res ?? 0,
      lck: o.lck ?? tmpl.lck ?? 0,
      gaugeS: o.gauge_s ?? tmpl.gauge_s,
      dpa: o.dmg_per_action ?? tmpl.dmg_per_action ?? 0,
      cp: o.cp ?? null,             // null = unlimited (enemy CP is bookkeeping, not economy)
      moves: JSON.parse(JSON.stringify(o.moves ?? tmpl.moves ?? [])),
      statusTiers: (o.status_tiers ?? tmpl.status_tiers)?.tiers || {},
      control: q.control || 'ai',
      slot: q.slot ?? null,
      size: q.size ?? o.size ?? tmpl.size ?? 1,   // on-screen scale, the GM's per-enemy dial
      drop: q.drop || { type: 'none' },
      wave: waveIdx,
      statuses: [], statChanges: [],
      gauge: 0, holding: false, critCharged: false, defending: false,
      turnCount: 0, hastySecond: false, dead: false,
      firedTriggers: [], sprite: tmpl.sprite || null, portrait: tmpl.portrait || null,
    };
    if (inst.slot == null) inst.slot = this.freeEnemySlot();
    // Compound/phase fights: no top-level gauge_s means take the first phase's.
    if (inst.gaugeS == null && tmpl.gauge_phases) inst.gaugeS = Object.values(tmpl.gauge_phases)[0];
    if (inst.gaugeS == null) inst.gaugeS = 5.0;
    // Forms & rotations (Japhet): start in the first scripted form.
    const forms = (this.data.scripts.rotations || {})[tmplName];
    if (forms) { inst.form = Object.keys(forms)[0]; inst.rotIdx = 0; }
    if (q.fake) inst.fake = true;
    inst.usedMoves = [];
    inst.timers = {};
    // GM ruling: enemies can carry items — they enter the encounter's shared pool.
    for (const [n, cnt] of Object.entries(q.items || {})) {
      this.pool[n] = (this.pool[n] || 0) + cnt;
    }
    this.rollCrit(inst);
    this.enemies.push(inst);
    return inst;
  }

  freeEnemySlot() {
    const used = new Set(this.livingEnemies().map(e => e.slot));
    for (let i = 1; i <= ENEMY_SLOTS; i++) if (!used.has(i)) return i;
    return ((this.enemies.length) % ENEMY_SLOTS) + 1;
  }

  // ---------- the tick ----------
  tick(dt) {
    if (this.over || this.frozen || this.campaign.paused) return;
    this.elapsed += dt;
    for (const c of [...this.livingParty(), ...this.livingEnemies()]) {
      if (c.holding) continue;
      const secs = this.gaugeSeconds(c);
      c.gauge += dt / secs;
      if (c.gauge >= 1) { c.gauge = 1; this.onGaugeFill(c); }
    }
  }

  onGaugeFill(c) {
    // Defend expires the moment the gauge next fills, whether or not the character acts.
    c.defending = false;

    // Cure checks at the start of each of the target's turns; then Poison ticks.
    this.runCureChecks(c);
    if (this.dead(c)) return;
    this.poisonTick(c);
    if (this.dead(c)) return;

    // Status turn resolution.
    const palsied = hasStatus(c, 'Palsied');
    let asleepWasted = false;
    const asleep = c.statuses.find(s => s.name === 'Asleep');
    if (asleep && !palsied) {
      asleep.fills = (asleep.fills || 0) + 1;
      asleepWasted = asleep.fills % 2 === 0;   // every second gauge fill resolves as Palsied
    }
    if (palsied || asleepWasted) {
      this.announce(`${this.dispName(c)} ${palsied ? 'is Palsied — the turn is consumed.' : 'is Asleep — the turn is consumed.'}`);
      this.log({ ev: 'turn-consumed', who: c.id, cause: palsied ? 'Palsied' : 'Asleep' });
      this.spendTurn(c, { consumed: true });
      return;
    }

    if (hasStatus(c, 'Madness')) {
      // The one place the engine acts without input: a normal Attack on a random
      // member of its own party, including itself.
      const pool = c.kind === 'player' ? this.livingParty() : this.livingEnemies();
      const target = pool[Math.floor(this.rng() * pool.length)];
      this.announce(`${this.dispName(c)} flails in Madness!`);
      this.resolveBasicAttack(c, target, { madness: true });
      this.spendTurn(c);
      return;
    }

    // Otherwise the gauge holds at full and waits.
    c.holding = true;
    if (c.kind === 'enemy') {
      if (c.control === 'ai') this.aiAct(c);
      else this.emit({ kind: 'gm-turn', enemyId: c.id, prompts: this.pendingTriggers(c).map(t => t.label) });
    } else {
      this.emit({ kind: 'your-turn', playerId: c.id });
    }
  }

  dead(c) { return c.kind === 'player' ? c.down : c.dead; }
  dispName(c) { return c.kind === 'player' ? c.name : c.name; }

  runCureChecks(c) {
    for (const s of [...c.statuses]) {
      if (s.permanent) continue;
      if (s.fixedTurns != null) continue;   // fixed-duration endgame statuses don't roll
      s.turnsAfflicted = s.turnsAfflicted ?? 0;
      if (s.turnsAfflicted >= CURE_AUTO_TURN - 1) { this.cureStatus(c, s.name, 'wore off'); continue; }
      const chain = (s.applierClass === 'Alpha' && this.passiveActive('Alpha', 'Chain Mastery')) || s.chain;
      const chance = cureChance(this.effRes(c, s.name), s.turnsAfflicted, chain);
      if (this.rng() * 100 < chance) this.cureStatus(c, s.name, 'shaken off');
      else s.turnsAfflicted++;
    }
  }

  poisonTick(c) {
    const maxHp = c.kind === 'player' ? memberBase(this.data, c).hp : c.maxHp;
    if (hasStatus(c, 'Poisoned')) {
      this.applyDamage(c, Math.round(maxHp * POISON_COMBAT_FRAC), { style: 'dmg', source: 'Poisoned' });
    }
    // Famine: Poisoned at double tick, 2/25 max HP. A separate status on its own clock.
    if (!this.dead(c) && hasStatus(c, 'Famine')) {
      this.applyDamage(c, Math.round(maxHp * FAMINE_FRAC), { style: 'dmg', source: 'Famine' });
    }
  }

  // ---------- turn spending ----------
  spendTurn(c, { consumed = false } = {}) {
    // Hasty: acts twice per gauge fill; a charged crit applies to the first action only.
    if (hasStatus(c, 'Hasty') && !c.hastySecond && !consumed && !this.dead(c)) {
      c.hastySecond = true;
      c.critCharged = false;
      c.holding = true;
      if (c.kind === 'enemy' && c.control === 'ai') { this.aiAct(c); return; }
      this.emit(c.kind === 'enemy'
        ? { kind: 'gm-turn', enemyId: c.id, prompts: this.pendingTriggers(c).map(t => t.label), second: true }
        : { kind: 'your-turn', playerId: c.id, second: true });
      return;
    }
    c.hastySecond = false;
    c.turnCount++;
    // Thorns: lose 10% max HP each time you act (a consumed turn is not acting).
    if (!consumed && hasStatus(c, 'Thorns') && !this.dead(c)) {
      const maxHp = c.kind === 'player' ? memberBase(this.data, c).hp : c.maxHp;
      this.applyDamage(c, Math.round(maxHp * THORNS_FRAC), { style: 'dmg', source: 'Thorns' });
    }
    // Durations count the afflicted's own turns.
    for (const sc of [...c.statChanges]) {
      if (sc.fresh) { sc.fresh = false; continue; }
      sc.turnsLeft--;
      if (sc.turnsLeft <= 0) c.statChanges.splice(c.statChanges.indexOf(sc), 1);
    }
    // Fixed-duration statuses (Thorns, Defamed, Corrupted). They land from the
    // other side of the field — outside the holder's own turn — so every spend
    // counts, no freshness grace.
    for (const s of [...c.statuses]) {
      if (s.fixedTurns == null) continue;
      s.fixedTurns--;
      if (s.fixedTurns <= 0) {
        c.statuses.splice(c.statuses.indexOf(s), 1);
        if (s.name === 'Defamed') this.defamedFades(c, s);
        else this.announce(`${this.dispName(c)} is no longer ${s.name}.`);
      }
    }
    if (c.elementSet) {
      if (c.elementSet.fresh) c.elementSet.fresh = false;
      else if (--c.elementSet.turnsLeft <= 0) {
        this.announce(`${this.dispName(c)}'s element reverts to ${c.element}.`);
        c.elementSet = null;
      }
    }
    c.gauge = 0; c.holding = false;
    this.rollCrit(c);
    this.checkEnd();
  }

  // Defamed fades uncured: everything produced during the window reflects onto
  // the holder's whole party — damage as damage to each member, healing and
  // buffs as healing and buffs to everyone. Curing it early (Focus) prevents this.
  defamedFades(holder, s) {
    const ledger = s.ledger || { dmg: 0, heal: 0, buffs: [] };
    const party = holder.kind === 'player' ? this.livingParty() : this.livingEnemies();
    this.announce(`The Defamation fades — everything ${this.dispName(holder)} produced comes back.`);
    this.log({ ev: 'defamed-reflect', who: holder.id, ...{ dmg: ledger.dmg, heal: ledger.heal, buffs: ledger.buffs.length } });
    for (const m of [...party]) {
      if (ledger.dmg > 0) this.applyDamage(m, ledger.dmg, { style: 'crit', source: 'Defamed' });
      if (this.dead(m)) continue;
      if (ledger.heal > 0) this.heal(m, ledger.heal);
      for (const b of ledger.buffs) this.applyStatChange(m, { ...b });
    }
  }

  // ---------- applying damage / death ----------
  applyDamage(target, dmg, { style = 'dmg', source = '' } = {}) {
    if (this.dead(target)) return 0;
    if (target.kind === 'player') {
      // Sacred Mission: once per battle, survive lethal damage at 1 HP.
      if (target.hp - dmg <= 0 && target.klass === 'Purifier' && target.level >= 2 && !target.sacredUsed) {
        target.sacredUsed = true;
        target.hp = 1;
        this.float(target.id, `${dmg}`, style);
        this.announce(`${target.name} endures through Sacred Mission!`);
        this.log({ ev: 'sacred-mission', who: target.id });
        return dmg;
      }
      target.hp = Math.max(0, target.hp - dmg);
      this.float(target.id, `${dmg}`, style);
      if (target.hp === 0) this.downPlayer(target);
    } else {
      // A Facade fake vanishes at the first touch — the wasted action is the point.
      if (target.fake) {
        target.dead = true; target.drop = { type: 'none' };
        this.announce(`${target.name} scatters — it was a lie.`);
        this.log({ ev: 'fake-vanish', who: target.id });
        this.checkEnd();
        return 0;
      }
      // Scripted Sacred Mission mirror (the Batter): first lethal blow leaves 1 HP.
      if (this.templatePassives(target).sacredMission && !target.sacredUsed && target.hp - dmg <= 0) {
        target.sacredUsed = true;
        target.hp = 1;
        this.float(target.id, `${dmg}`, style);
        this.announce(`${target.name} refuses to fall.`);
        this.log({ ev: 'enemy-sacred-mission', who: target.id });
        return dmg;
      }
      target.hp = Math.max(0, target.hp - dmg);
      this.float(target.id, `${dmg}`, style);
      if (target.hp === 0) this.killEnemy(target, source);
    }
    return dmg;
  }

  downPlayer(p) {
    p.down = true; p.holding = false; p.gauge = 0; p.critCharged = false; p.defending = false;
    this.announce(`${p.name} falls!`);
    this.log({ ev: 'death', who: p.id });
    this.onApplierDeath(p.id);
    this.checkEnd();
  }

  killEnemy(e, killerId) {
    e.dead = true; e.holding = false; e.gauge = 0;
    this.kills[e.id] = killerId;
    this.announce(`${e.name} is defeated.`);
    this.log({ ev: 'death', who: e.id, by: killerId });
    this.onApplierDeath(e.id);
    this.checkEnd();
  }

  // Taunted ends immediately when the character who applied it dies.
  onApplierDeath(id) {
    for (const c of [...this.party(), ...this.enemies]) {
      const t = c.statuses.find(s => s.name === 'Taunted' && s.applierId === id);
      if (t) this.cureStatus(c, 'Taunted', 'released');
    }
  }

  checkEnd() {
    if (this.over) return;
    if (this.livingParty().length === 0) {
      // Detect, freeze, announce — and then nothing. Everything after is the GM's.
      this.frozen = true; this.over = true; this.victory = false;
      this.announce('THE PARTY HAS FALLEN.');
      this.log({ ev: 'defeat' });
      this.emit({ kind: 'defeat' });
      return;
    }
    if (this.livingEnemies().length === 0) {
      const next = this.encounter.waves.findIndex(w => !w.spawned && (w.trigger || 'prev-death') === 'prev-death');
      if (next >= 0) { this.spawnWave(next, 'prev-death'); return; }
      if (this.encounter.waves.some(w => !w.spawned)) return; // manual waves remain — GM's call
      this.win();
    }
  }

  win() {
    this.over = true; this.victory = true;
    // Drops and credits enter the shared inventory automatically; 3-second toast; no results screen.
    const got = [];
    let credits = 0;
    for (const e of this.enemies) {
      if (!e.dead) continue;
      const d = e.drop || { type: 'none' };
      if (d.type === 'item' && d.name) { this.grantItem(d.name, 1); got.push(d.name); }
      else if (d.type === 'credits' && d.amount) { credits += d.amount; }
      // Cutpurse: enemies defeated by the Bandit drop one additional item,
      // stolen from the encounter's enemy object pool (GM ruling). Empty pool,
      // empty fingers.
      const killer = this.find(this.kills[e.id]);
      if (killer && killer.kind === 'player' && killer.klass === 'Bandit' && killer.level >= 10) {
        const names = Object.keys(this.pool).filter(n => this.pool[n] > 0);
        if (names.length) {
          const bonus = names[Math.floor(this.rng() * names.length)];
          this.pool[bonus]--;
          this.grantItem(bonus, 1); got.push(`${bonus} (Cutpurse)`);
        }
      }
    }
    if (credits) { this.campaign.credits += credits; got.push(`${credits} credits`); }
    this.log({ ev: 'victory', got });
    this.emit({ kind: 'victory', got });
    this.announce(got.length ? `You got: ${got.join(', ')}` : 'Victory.');
  }

  grantItem(name, n) {
    this.campaign.inventory[name] = (this.campaign.inventory[name] || 0) + n;
  }

  // ---------- statuses / stat changes / element changes ----------
  passiveActive(klass, passiveName) {
    const m = this.memberByClass(klass);
    if (!m || m.down) return false;
    const p = this.data.classKits.classes[klass].passives.find(x => x.name === passiveName);
    return !!p && m.level >= p.level;
  }

  // Returns true if applied. tier: explicit tier or looked up on enemy targets.
  tryApplyStatus(target, statusName, applier, { tierOverride = null, permanent = false, force = false } = {}) {
    // One instance only: reapplication does nothing at all.
    if (hasStatus(target, statusName)) return false;
    // Madness and Taunted are mutually exclusive.
    if ((statusName === 'Madness' && hasStatus(target, 'Taunted')) ||
        (statusName === 'Taunted' && hasStatus(target, 'Madness'))) return false;
    if (target.kind === 'player') {
      const fx = gearEffects(this.data, target);
      if (fx.status_immune.includes(statusName)) {
        if (!force) { this.float(target.id, 'IMMUNE', 'miss'); return false; }
      }
    }
    if (!force) {
      let tier = tierOverride;
      if (tier == null) tier = target.kind === 'enemy' ? (target.statusTiers[statusName] || 'neutral') : 'neutral';
      const alphaMods = applier && applier.kind === 'player' && applier.klass === 'Alpha' ? {
        expertise: this.passiveActive('Alpha', 'Status Expertise'),
        corrosion: this.passiveActive('Alpha', 'Corrosion'),
      } : {};
      const chance = statusLandingChance(tier, this.effRes(target, statusName), alphaMods);
      if (chance == null) { this.float(target.id, 'IMMUNE', 'miss'); return false; }
      if (this.rng() * 100 >= chance) { this.float(target.id, 'RESISTED', 'miss'); return false; }
    }
    // Impure rides the element-change machinery: weak to a random ring element,
    // 2 turns; one-instance and native-cancellation rules apply. No status record.
    if (statusName === 'Impure') {
      const weakTo = RING[Math.floor(this.rng() * 4)];
      const newEl = ringNext(weakTo);
      if (newEl === currentElement(target)) return false;   // rolled the weakness it already has — one instance, nothing happens
      const ok = this.applyElementSet(target, newEl, null, { announceAs: 'Impure' });
      if (ok) this.announce(`${this.dispName(target)} is Impure — weak to ${weakTo}!`);
      return ok;
    }
    const rec = {
      name: statusName,
      applierId: applier ? applier.id : null,
      applierClass: applier && applier.kind === 'player' ? applier.klass : null,
      turnsAfflicted: 0, permanent,
      chain: applier && applier.kind === 'enemy' && this.templatePassives(applier).chainMastery ? true : undefined,
    };
    if (FIXED_TURN_STATUSES[statusName] != null) rec.fixedTurns = FIXED_TURN_STATUSES[statusName];
    target.statuses.push(rec);
    if (statusName === 'Defamed') { rec.ledger = { dmg: 0, heal: 0, buffs: [] }; target.critCharged = true; }
    // Negative Space: a charged crit held by an enemy is lost the moment Blinded lands.
    if (statusName === 'Blinded' && target.kind === 'enemy' &&
        rec.applierClass === 'Omega' && this.passiveActive('Omega', 'Negative Space')) {
      target.critCharged = false;
    }
    this.announce(`${this.dispName(target)} is ${statusName}!`);
    this.log({ ev: 'status', target: target.id, status: statusName, by: applier?.id });
    return true;
  }

  cureStatus(target, statusName, how = 'cured') {
    const i = target.statuses.findIndex(s => s.name === statusName);
    if (i < 0) return false;
    target.statuses.splice(i, 1);
    this.announce(`${this.dispName(target)} is no longer ${statusName} (${how}).`);
    this.log({ ev: 'cure', target: target.id, status: statusName, how });
    return true;
  }

  cureAllStatuses(target, curedBy = null) {
    const had = target.statuses.length > 0;
    for (const s of [...target.statuses]) this.cureStatus(target, s.name);
    // Fixer: whenever Omega cures statuses, it also strips one stat Down from the same target.
    if (curedBy && curedBy.kind === 'player' && curedBy.klass === 'Omega' && this.passiveActive('Omega', 'Fixer')) {
      const down = target.statChanges.find(sc => sc.dir === 'down');
      if (down) {
        target.statChanges.splice(target.statChanges.indexOf(down), 1);
        this.announce(`Fixer strips ${down.stat} Down from ${this.dispName(target)}.`);
      }
    }
    return had;
  }

  // Stat changes never roll to land. One instance per stat per direction;
  // Up and Down of the same stat cancel on contact.
  applyStatChange(target, { stat, dir, amount, turns }, source = null) {
    const opposite = target.statChanges.find(sc => sc.stat === stat && sc.dir !== dir);
    if (opposite) {
      target.statChanges.splice(target.statChanges.indexOf(opposite), 1);
      this.announce(`${this.dispName(target)}'s ${stat} ${opposite.dir === 'up' ? 'Up' : 'Down'} is cancelled.`);
      this.log({ ev: 'statchange-cancel', target: target.id, stat });
      return 'cancelled';
    }
    const existing = target.statChanges.find(sc => sc.stat === stat && sc.dir === dir);
    if (existing) return 'blocked';   // the first application holds until it expires
    let t = turns;
    // Artistic Mastery: Epsilon's Dramas last 1 additional turn.
    if (source && source.tag === 'drama' && this.passiveActive('Epsilon', 'Artistic Mastery')) t += 1;
    target.statChanges.push({ stat, dir, amount, turnsLeft: t, fresh: true, tag: source?.tag || null });
    this.announce(`${this.dispName(target)}: ${stat} ${dir === 'up' ? 'Up' : 'Down'} ${stat === 'DEF' ? (dir === 'up' ? '+' : '−') + amount : amount + '%'} (${t}t).`);
    this.log({ ev: 'statchange', target: target.id, stat, dir, amount, turns: t });
    return 'applied';
  }

  // One element change per target; a change to the native element cancels instead.
  applyElementSet(target, element, applier, { announceAs = null } = {}) {
    // Sweet Madness: the Burnt's own element can never be changed, including by itself.
    if (target.kind === 'player' && target.klass === 'Burnt' && this.passiveActive('Burnt', 'Sweet Madness')) {
      this.float(target.id, 'IMMUNE', 'miss');
      return false;
    }
    if (element === 'Sugar') return false;  // Sugar is never a legal target
    if (target.elementSet) {
      if (element === target.element) {
        target.elementSet = null;
        this.announce(`${this.dispName(target)}'s element is restored to ${target.element}.`);
        return true;
      }
      return false;   // cannot be rewritten while a change is already running
    }
    if (element === target.element) return false;  // setting native with no change running: nothing to cancel
    let turns = 2;
    if (applier && applier.kind === 'player' && applier.klass === 'Burnt' && this.passiveActive('Burnt', 'Scorched')) turns = 3;
    target.elementSet = { element, turnsLeft: turns, fresh: true };
    this.announce(`${this.dispName(target)}'s element becomes ${element}!`);
    this.log({ ev: 'element-set', target: target.id, element, turns });
    return true;
  }

  // ---------- player actions ----------
  // All entry points validate-before-initiate: illegal input returns {ok:false, refuse:true}
  // and nothing is spent — the click simply doesn't respond.

  canAct(p) {
    return !this.over && !this.frozen && !this.campaign.paused && !p.down && !p.benched && p.holding;
  }

  // Furious: the player still clicks — they pick a target; the engine substitutes a
  // random affordable competence that can legally target that selection.
  furiousSubstitute(p, target) {
    const kit = this.data.classKits.classes[p.klass];
    const fx = gearEffects(this.data, p);
    const candidates = kit.competences.filter(c => {
      if (c.level > p.level) return false;
      if (p.cp < Math.round(c.cp * fx.cp_cost_mult)) return false;
      const r = this.data.riders[p.klass][c.name];
      const tgt = r.targetOverride || c.target;
      if (target.kind === 'enemy') return tgt === 'one enemy' || tgt === 'all enemies';
      return tgt === 'one ally' || tgt === 'all allies';
    }).filter(c => this.data.riders[p.klass][c.name].kind !== 'revive'); // dead targets aren't selectable
    if (!candidates.length) {
      this.announce(`${p.name} rages, but nothing comes of it.`);
      this.spendTurn(p);
      return { ok: true };
    }
    const comp = candidates[Math.floor(this.rng() * candidates.length)];
    const element = ['Plastic', 'Metal', 'Smoke', 'Meat'][Math.floor(this.rng() * 4)];
    this.announce(`${p.name}, Furious, lashes out with ${comp.name}!`);
    return this.doCompetence(p, comp.name, target.id, element, { furious: true });
  }

  playerAction(p, action) {
    if (!this.canAct(p)) return { ok: false, refuse: true };
    if (hasStatus(p, 'Madness')) return { ok: false, refuse: true };  // no input accepted

    // Taunted: single-target actions may only target the applier.
    const taunt = p.statuses.find(s => s.name === 'Taunted');

    if (hasStatus(p, 'Furious')) {
      const target = this.find(action.targetId);
      if (!target || this.dead(target)) return { ok: false, refuse: true };
      return this.furiousSubstitute(p, target);
    }

    switch (action.kind) {
      case 'attack': {
        const target = this.find(action.targetId);
        if (!target || target.kind !== 'enemy' || target.dead) return { ok: false, refuse: true };
        if (taunt && target.id !== taunt.applierId) return { ok: false, refuse: true };
        this.resolveBasicAttack(p, target);
        this.spendTurn(p);
        return { ok: true };
      }
      case 'defend': {
        p.defending = true;
        this.announce(`${p.name} defends.`);
        this.log({ ev: 'defend', who: p.id });
        this.spendTurn(p);
        return { ok: true };
      }
      case 'competence':
        return this.doCompetence(p, action.competence, action.targetId, action.element, { taunt });
      case 'item':
        return this.doItem(p, action.item, action.targetId, { taunt });
      default:
        return { ok: false, refuse: true };
    }
  }

  resolveBasicAttack(user, target, { madness = false } = {}) {
    // A normal Attack: BaseValue 0, Atk% 100, Esp% 0, MovePower 1.0, Var 10%.
    const fx = user.kind === 'player' ? gearEffects(this.data, user) : null;
    const hits = fx?.hits || 1;
    const kit = user.kind === 'player' ? this.data.classKits.meta.class_accuracy[user.klass] : null;
    let acc = user.kind === 'player' ? kit : 95;
    if (user.kind === 'enemy') {
      const atkMove = user.moves.find(m => m.n === 'Attack');
      acc = atkMove ? atkMove.acc : 95;
    }
    if (fx && fx.accuracy === null) acc = null;   // Ashley Bat: cannot miss
    for (let h = 0; h < hits; h++) {
      if (this.dead(target)) break;
      if (!accuracyRoll(acc, user, this.rng)) {
        this.float(target.id, 'MISS', 'miss');
        this.announce(`${this.dispName(user)} misses!`);
        this.log({ ev: 'miss', who: user.id, target: target.id, action: 'Attack' });
        continue;
      }
      let raw, attackEl;
      if (user.kind === 'player') {
        // playerRaw applies ATK stat changes via playerAtk.
        raw = playerRaw({ ...user, base: memberBase(this.data, user) },
          { atkPct: 100, espPct: 0, movePower: 1.0, variance: 10 }, this.rng);
        attackEl = fx.attack_element || currentElement(user);
        if (Array.isArray(attackEl)) attackEl = this.bestElement(attackEl, target); // Perfect Symbol
      } else {
        raw = enemyRaw(user, 1.0, this.rng);
        attackEl = currentElement(user);
      }
      raw = this.offensiveModifiers(user, target, raw);
      const crit = h === 0 && user.critCharged && !this.critBlocked(user, target);
      const dmg = finalDamage(raw, attackEl, this.withBase(target), { crit });
      this.applyDamage(target, dmg, { style: crit ? 'crit' : 'dmg', source: user.id });
      this.trackDefamed(user, 'dmg', dmg);
      this.log({ ev: 'attack', who: user.id, target: target.id, dmg, crit, madness });
      this.announce(`${this.dispName(user)} attacks ${this.dispName(target)} for ${dmg}${crit ? ' — CRITICAL!' : '!'}`);
    }
  }

  bestElement(list, target) {
    let best = list[0], bestMult = -1;
    for (const el of list) {
      const m = elementMult(el, currentElement(target));
      if (m > bestMult) { bestMult = m; best = el; }
    }
    return best;
  }

  critBlocked(user, target) {
    if (user.kind === 'enemy' && this.blindedByOmega(user)) return true;  // Negative Space
    if (target.kind === 'player') {
      const fx = gearEffects(this.data, target);
      if (fx.crit_immune) return true;   // Monday / Femur Epidermis
    }
    return false;
  }

  offensiveModifiers(user, target, raw) {
    // Purification: +25% against enemies at or below 30% HP.
    if (user.kind === 'player' && user.klass === 'Purifier' && target.kind === 'enemy' &&
        this.passiveActive('Purifier', 'Purification') && target.hp / target.maxHp <= 0.3) {
      raw *= 1.25;
    }
    return raw;
  }

  doCompetence(p, compName, targetId, chosenElement, { taunt = null, furious = false } = {}) {
    if ((hasStatus(p, 'Muted') || hasStatus(p, 'Vilified') || hasStatus(p, 'Corrupted')) && !furious) return { ok: false, refuse: true };
    const kit = this.data.classKits.classes[p.klass];
    const comp = kit.competences.find(c => c.name === compName);
    if (!comp || comp.level > p.level) return { ok: false, refuse: true };
    const rider = this.data.riders[p.klass][compName];
    const gfx = gearEffects(this.data, p);
    const cost = Math.round(comp.cp * gfx.cp_cost_mult);
    if (p.cp < cost) return { ok: false, refuse: true };
    const targetSpec = rider.targetOverride || comp.target;

    // Resolve target set. Dead targets refuse input — except revives, which require them.
    let targets = [];
    if (rider.kind === 'revive') {
      const t = this.find(targetId);
      if (!t || t.kind !== 'player' || !t.down || t.benched) return { ok: false, refuse: true };
      targets = [t];
    } else if (targetSpec === 'one enemy') {
      const t = this.find(targetId);
      if (!t || t.kind !== 'enemy' || t.dead) return { ok: false, refuse: true };
      if (taunt && t.id !== taunt.applierId) return { ok: false, refuse: true };
      targets = [t];
    } else if (targetSpec === 'all enemies') {
      targets = this.livingEnemies();
      if (!targets.length) return { ok: false, refuse: true };
    } else if (targetSpec === 'one ally') {
      const t = this.find(targetId);
      if (!t || t.kind !== 'player' || t.down || t.benched) return { ok: false, refuse: true };
      targets = [t];
    } else if (targetSpec === 'all allies') {
      targets = this.livingParty();
    } else if (targetSpec === 'self') {
      targets = [p];
    }

    // Element-choosing competences need a ring element.
    const needsChoice = (rider.effects || []).some(e => e.type === 'elementSet' && e.element === 'choose');
    if (needsChoice && !['Plastic', 'Metal', 'Smoke', 'Meat'].includes(chosenElement)) return { ok: false, refuse: true };

    p.cp -= cost;   // the competence is spent whether or not it connects
    this.log({ ev: 'competence', who: p.id, name: compName, cp: cost, targets: targets.map(t => t.id) });
    this.announce(`${p.name} uses ${compName}!`);

    const pBase = { ...p, base: memberBase(this.data, p) };

    for (const target of targets) {
      if (rider.kind === 'reveal') { this.reveal(target); continue; }
      if (rider.kind === 'revive') {
        this.revive(target, rider.revive.hpPct);
        for (const e of rider.effects || []) if (e.type === 'cureAllStatuses') this.cureAllStatuses(target, p);
        continue;
      }
      if (rider.kind === 'heal' || (rider.kind === 'support' && comp.movePower == null) || rider.kind === 'elementSet' || rider.kind === 'status') {
        // Non-damaging: cannot miss; a charged crit spent here is simply wasted.
        if (rider.kind === 'heal') {
          const amt = Math.round(playerRaw(pBase, comp, this.rng));
          this.trackDefamed(p, 'heal', this.heal(target, amt));
        }
        this.applyCompEffects(p, target, rider, chosenElement);
        continue;
      }
      // Damaging competence.
      if (!accuracyRoll(comp.accuracy, p, this.rng)) {
        this.float(target.id, 'MISS', 'miss');
        this.announce(`${p.name}'s ${compName} misses ${this.dispName(target)}!`);
        this.log({ ev: 'miss', who: p.id, target: target.id, action: compName });
        continue;   // if the attack misses, the rider doesn't land
      }
      let raw = playerRaw(pBase, comp, this.rng);
      const sp = rider.special || {};
      if (sp.bonusPctIfTargetHasStatus && target.statuses.length > 0) raw *= 1 + sp.bonusPctIfTargetHasStatus / 100;
      if (sp.bonusMultPerStatus) {
        const n = target.statuses.length;   // stat changes do not count
        raw *= (sp.baseTargetMult + sp.bonusMultPerStatus * n) / sp.baseTargetMult;
      }
      if (sp.doubleIfTargetBlinded && hasStatus(target, 'Blinded')) raw *= 2;
      // Standing Ovation: while any Drama is active, Epsilon's Tragedies deal +20%.
      if ((rider.tags || []).includes('tragedy') && this.passiveActive('Epsilon', 'Standing Ovation') &&
          this.livingParty().some(m => m.statChanges.some(sc => sc.tag === 'drama'))) {
        raw *= 1.2;
      }
      raw = this.offensiveModifiers(p, target, raw);
      // Element: competences carrying the class's own element ride the character's
      // current element; forced-element competences (Runs, Crashes, Homeruns) don't.
      let attackEl = comp.element;
      if (!rider.forcedElement && comp.element === p.element) attackEl = currentElement(p);
      const crit = p.critCharged && !this.critBlocked(p, target);
      const dmg = finalDamage(raw, attackEl, this.withBase(target), { crit, ignoresElement: !!sp.ignoresElement });
      this.applyDamage(target, dmg, { style: crit ? 'crit' : 'dmg', source: p.id });
      this.trackDefamed(p, 'dmg', dmg);
      this.announce(`${compName} hits ${this.dispName(target)} for ${dmg}${crit ? ' — CRITICAL!' : '!'}`);
      this.log({ ev: 'hit', who: p.id, target: target.id, action: compName, dmg, crit });
      // Damage resolves before the element change; riders land only on a connected hit.
      this.applyCompEffects(p, target, rider, chosenElement);
    }
    this.spendTurn(p);
    return { ok: true };
  }

  applyCompEffects(p, target, rider, chosenElement) {
    for (const e of rider.effects || []) {
      if (this.dead(target) && e.type !== 'cureAllStatuses') continue;
      if (e.type === 'status') this.tryApplyStatus(target, e.status, p);
      else if (e.type === 'statChange') {
        const res = this.applyStatChange(target, e, { tag: (rider.tags || [])[0] || null });
        if (res === 'applied' && e.dir === 'up' && target.kind === p.kind) this.trackDefamed(p, 'buffs', { stat: e.stat, dir: e.dir, amount: e.amount, turns: e.turns });
      }
      else if (e.type === 'elementSet') this.applyElementSet(target, e.element === 'choose' ? chosenElement : e.element, p);
      else if (e.type === 'cureAllStatuses') this.cureAllStatuses(target, p);
      else if (e.type === 'steal') this.steal(p);
    }
  }

  steal(p) {
    // Ursa Shot steals from the encounter's enemy object pool.
    const names = Object.keys(this.pool).filter(n => this.pool[n] > 0);
    if (!names.length) { this.announce('Nothing to steal.'); return; }
    const name = names[Math.floor(this.rng() * names.length)];
    this.pool[name]--;
    this.grantItem(name, 1);
    this.announce(`${p.name} steals ${name}!`);
    this.log({ ev: 'steal', who: p.id, item: name });
  }

  heal(target, amt) {
    if (this.dead(target)) return 0;
    const maxHp = target.kind === 'player' ? memberBase(this.data, target).hp : target.maxHp;
    const healed = Math.min(amt, maxHp - target.hp);
    target.hp += healed;
    this.float(target.id, `+${healed}`, 'heal');
    this.log({ ev: 'heal', target: target.id, amt: healed });
    return healed;
  }

  revive(target, hpPct) {
    if (!target.down) return false;
    const maxHp = memberBase(this.data, target).hp;
    target.down = false;
    target.hp = Math.max(1, Math.round(maxHp * hpPct / 100));
    target.gauge = REVIVE_GAUGE;   // revived characters return at 50% gauge
    target.holding = false;
    this.rollCrit(target);
    this.announce(`${target.name} returns to the fight!`);
    this.log({ ev: 'revive', target: target.id, hpPct });
    return true;
  }

  reveal(enemy) {
    if (enemy.kind !== 'enemy') return;
    this.revealed.add(enemy.id);   // party-wide, lasts the encounter
    this.announce(`${enemy.name} is revealed!`);
    this.log({ ev: 'reveal', target: enemy.id });
  }

  // ---------- items ----------
  doItem(p, itemName, targetId, { taunt = null } = {}) {
    if (hasStatus(p, 'Corrupted')) return { ok: false, refuse: true };   // Cob's variant also locks items
    const inv = this.campaign.inventory;
    if (!inv[itemName] || inv[itemName] <= 0) return { ok: false, refuse: true };
    const item = this.data.itemsByName[itemName];
    if (!item) return { ok: false, refuse: true };
    if (item.effect.outOfCombatOnly) return { ok: false, refuse: true };
    const res = this.applyItemEffect(p, item, targetId, { taunt });
    if (!res.ok) return res;
    // Light Fingers: whenever any party member uses an Object, 5% chance it is not consumed.
    const bandit = this.memberByClass('Bandit');
    const saved = bandit && !bandit.down && bandit.level >= 2 && this.rng() < 0.05;
    if (saved) this.announce('Light Fingers — the item is not consumed!');
    else inv[itemName]--;
    this.log({ ev: 'item', who: p.id, item: itemName, target: targetId, saved });
    this.spendTurn(p);   // item use is a turn, full stop
    return { ok: true };
  }

  applyItemEffect(user, item, targetId, { taunt = null, byEnemy = null } = {}) {
    const fx = item.effect;
    const target = targetId ? this.find(targetId) : null;
    switch (fx.type) {
      case 'healHp': {
        if (!target || this.dead(target)) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.heal(target, fx.amount);
        return { ok: true };
      }
      case 'healCp': {
        if (!target || this.dead(target)) return { ok: false, refuse: true };
        if (target.kind === 'player') {
          const maxCp = memberBase(this.data, target).cp;
          target.cp = Math.min(maxCp, target.cp + fx.amount);
        } else if (target.cp != null) target.cp += fx.amount;
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.float(target.id, `+${fx.amount} CP`, 'heal');
        return { ok: true };
      }
      case 'revive': {
        if (!target || target.kind !== 'player' || !target.down) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.revive(target, fx.hpPct);
        return { ok: true };
      }
      case 'cureStatus': {
        if (!target || this.dead(target)) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.cureStatus(target, fx.status, 'cured');
        return { ok: true };
      }
      case 'cureAllStatuses': {
        if (!target || this.dead(target)) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.cureAllStatuses(target);
        return { ok: true };
      }
      case 'reveal': {
        if (!target || target.kind !== 'enemy' || target.dead) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        this.reveal(target);
        return { ok: true };
      }
      case 'attack': {
        if (!target || this.dead(target)) return { ok: false, refuse: true };
        if (user.kind === 'player' && (target.kind !== 'enemy')) return { ok: false, refuse: true };
        if (taunt && target.id !== taunt.applierId) return { ok: false, refuse: true };
        this.announce(`${this.dispName(user)} uses ${item.name}!`);
        // 75/400 base + ATK + ESP scaling; elementless; charged crits apply (it deals damage).
        let raw;
        if (user.kind === 'player') {
          const b = memberBase(this.data, user);
          raw = fx.base + b.atk * pctMult(user, 'ATK') + b.esp;
        } else {
          raw = fx.base + enemyRaw(user, 1.0, this.rng);
        }
        const crit = user.critCharged && !this.critBlocked(user, target);
        const dmg = finalDamage(raw, null, this.withBase(target), { crit });
        this.applyDamage(target, dmg, { style: crit ? 'crit' : 'dmg', source: user.id });
        this.trackDefamed(user, 'dmg', dmg);
        this.announce(`${item.name} deals ${dmg} to ${this.dispName(target)}${crit ? ' — CRITICAL!' : '!'}`);
        return { ok: true };
      }
      default:
        return { ok: false, refuse: true };
    }
  }

  // ---------- enemy turns ----------
  allTriggers(e) {
    return this.data.scripts.triggers[e.template] || [];
  }

  pendingTriggers(e) {
    return this.allTriggers(e).filter(t => !this.triggerSpent(e, t) && this.triggerReady(e, t));
  }

  triggerSpent(e, t) {
    if (t.when && (t.when.everySeconds != null || t.when.watchAgeGte != null)) return false;   // repeating cycles never spend
    return e.firedTriggers.includes(t.id);
  }

  triggerReady(e, t) {
    const w = t.when || {};
    const pct = (e.hp / e.maxHp) * 100;
    if (w.everySeconds != null) {
      const next = e.timers[t.id] ?? w.everySeconds;
      return this.elapsed >= next;
    }
    if (w.allyDied && this.enemies.some(x => x !== e && x.dead && !x.fled)) return true;
    if (w.watchAgeGte != null) return !!e.watch && e.turnCount - e.watch.setAtTurn >= w.watchAgeGte - 1;
    if (w.hpPctLte != null && pct <= w.hpPctLte) return true;
    if (w.turn != null && e.turnCount + 1 === w.turn) return true;
    if (w.orTurn != null && e.turnCount + 1 >= w.orTurn) return true;
    return false;
  }

  // Telegraphed scripted moves announce one gauge ahead of firing (AI side).
  telegraphPending(e, t) {
    if (!t.telegraph) return false;
    if (e.telegraphed && e.telegraphed.includes(t.id)) return false;
    (e.telegraphed = e.telegraphed || []).push(t.id);
    this.announce(t.telegraphText || `${e.name}'s gauge glows — ${t.label}.`);
    this.log({ ev: 'telegraph', who: e.id, id: t.id });
    return true;
  }

  fireTrigger(e, trigger) {
    if (trigger.when && trigger.when.everySeconds != null) {
      e.timers[trigger.id] = (e.timers[trigger.id] ?? trigger.when.everySeconds) + trigger.when.everySeconds;
    } else {
      e.firedTriggers.push(trigger.id);
    }
    const a = trigger.action;
    this.log({ ev: 'trigger', who: e.id, id: trigger.id });
    if (a.announce) this.announce(a.announce);
    if (a.addMove) {
      if (!e.moves.some(m => m.n === a.addMove.n)) e.moves.push({ ...a.addMove });
    }
    if (a.partyStatus) {
      this.announce(`${e.name}: ${trigger.label}`);
      for (const t of this.livingParty()) this.tryApplyStatus(t, a.partyStatus.status, e);
    }
    if (a.summon) {
      const total = a.summon.count;
      const real = a.summon.realCount ?? total;
      const picks = [];
      for (let i = 0; i < total; i++) picks.push(i >= real);
      // shuffle which spawns are fakes so slot order tells nothing
      for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
      for (let i = 0; i < total; i++) {
        this.spawnInstance({ template: a.summon.name, control: 'ai', drop: { type: 'none' }, fake: picks[i] }, e.wave);
      }
      this.announce(`${e.name} summons ${total} × ${a.summon.name}!`);
    }
    if (a.selfStatus) {
      this.tryApplyStatus(e, a.selfStatus.status, null, { permanent: !!a.selfStatus.permanent, force: true });
      this.announce(`${e.name}: ${trigger.label}`);
    }
    if (a.statChanges) {
      for (const sc of a.statChanges) this.applyStatChange(e, { ...sc });
      this.announce(`${e.name}: ${trigger.label}`);
    }
    if (a.selfHealBonus) {
      e.selfHealBonus = (e.selfHealBonus || 0) + a.selfHealBonus;
      this.announce(`${e.name}: ${trigger.label}`);
    }
    if (a.setForm) {
      e.form = a.setForm.form;
      if (a.setForm.gauge_s) e.gaugeS = a.setForm.gauge_s;
      e.rotIdx = 0;
      this.announce(`${e.name} — ${trigger.label}`);
      this.log({ ev: 'form', who: e.id, form: e.form });
    }
    if (a.castMove) {
      const move = e.moves.find(m => m.n === a.castMove);
      if (move) {
        const targets = this.pickEnemyTargets(e, move, a.targetId || null);
        this.resolveEnemyMove(e, move, targets);
      }
    }
    if (a.mark) {
      const pool = this.livingParty();
      if (pool.length) {
        const t = pool[Math.floor(this.rng() * pool.length)];
        e.watch = { targetId: t.id, setAtTurn: e.turnCount };
        this.announce(`${e.name} watches ${t.name} with great interest.`);
        this.log({ ev: 'watch', who: e.id, target: t.id });
      }
    }
    if (a.resolveWatch && e.watch) {
      const t = this.find(e.watch.targetId);
      e.watch = null;
      if (t && !this.dead(t)) {
        if (this.rng() < 0.5) {
          const amt = Math.round(t.hp * 0.75);
          this.announce(`${e.name} grants a boon.`);
          this.heal(t, amt);
        } else {
          this.announce(`${e.name}: IONOSPHERE.`);
          this.applyDamage(t, 9999, { style: 'crit', source: e.id });   // unconditional; Sacred Mission still answers
        }
      }
    }
    if (a.addMoveEffect) {
      e.moveFxOverlay = e.moveFxOverlay || {};
      e.moveFxOverlay[a.addMoveEffect.move] = { ...(e.moveFxOverlay[a.addMoveEffect.move] || {}), ...a.addMoveEffect.patch };
      this.announce(`${e.name}: ${trigger.label}`);
    }
    if (a.blast) {
      this.announce(`${e.name}: ${trigger.label}`);
      for (const t of this.livingParty()) {
        const raw = a.blast.damage * rollVariance(10, this.rng);
        const dmg = finalDamage(raw, currentElement(e), this.withBase(t), {});
        this.applyDamage(t, dmg, { style: 'dmg', source: e.id });
      }
    }
    if (a.forfeitDrop) e.drop = { type: 'none' };
    if (a.flee && !e.dead) {
      e.dead = true; e.fled = true; e.drop = { type: 'none' };
      this.announce(`${e.name} slips away!`);
      this.log({ ev: 'flee', who: e.id });
      this.checkEnd();
    }
    if (a.die && !e.dead) this.killEnemy(e, null);
    if (!e.dead) this.spendTurn(e);
  }

  moveFx(e, move) {
    const base = (this.data.scripts.moveEffects[e.template] || {})[move.n] || {};
    const overlay = (e.moveFxOverlay || {})[move.n] || {};
    return { ...base, ...overlay };
  }

  legalMoves(e) {
    return e.moves.filter(m => {
      const fx = this.moveFx(e, m);
      if (fx.scripted) return false;
      if (fx.cpCost && e.cp != null && e.cp < fx.cpCost) return false;
      if (fx.availableBelowHpPct != null && (e.hp / e.maxHp) * 100 > fx.availableBelowHpPct) return false;
      if (fx.formOnly && e.form && !fx.formOnly.includes(e.form)) return false;
      if (fx.oncePerFight && e.usedMoves.includes(m.n)) return false;
      return true;
    });
  }

  aiAct(e) {
    // Scripted behaviors auto-fire for AI-controlled instances only.
    const pending = this.pendingTriggers(e);
    if (pending.length) {
      const t = pending[0];
      // A telegraphed trigger announces this turn and fires the next.
      if (this.telegraphPending(e, t)) { /* fall through to a normal action */ }
      else { this.fireTrigger(e, t); return; }
    }
    const moves = this.legalMoves(e);
    if (!moves.length) { this.spendTurn(e); return; }
    // Canonical rotations (Japhet) are stage directions: the AI follows the cycle.
    const rotations = (this.data.scripts.rotations || {})[e.template];
    let move;
    if (rotations && e.form && rotations[e.form] && rotations[e.form].length) {
      const cycle = rotations[e.form];
      move = e.moves.find(m => m.n === cycle[e.rotIdx % cycle.length]) || moves[0];
      e.rotIdx = (e.rotIdx + 1) % cycle.length;
    } else {
      move = moves[Math.floor(this.rng() * moves.length)];
    }
    const targets = this.pickEnemyTargets(e, move, null);
    this.resolveEnemyMove(e, move, targets);
    if (!e.dead) this.spendTurn(e);
  }

  // GM-piloted enemy action.
  gmEnemyAction(e, action) {
    if (this.over || this.frozen || this.campaign.paused || e.dead || !e.holding) return { ok: false, refuse: true };
    if (action.kind === 'defend') {
      e.defending = true;
      this.announce(`${e.name} defends.`);
      this.spendTurn(e);
      return { ok: true };
    }
    if (action.kind === 'trigger') {
      // The GM's hand is never gated by the trigger's condition — a stage
      // direction is theirs to call early, late, or never.
      const t = this.allTriggers(e).find(x => x.id === action.triggerId);
      if (!t || this.triggerSpent(e, t)) return { ok: false, refuse: true };
      this.fireTrigger(e, t);
      return { ok: true };
    }
    if (action.kind === 'pool-item') {
      if (!this.pool[action.item] || this.pool[action.item] <= 0) return { ok: false, refuse: true };
      const item = this.data.itemsByName[action.item];
      if (!item) return { ok: false, refuse: true };
      const res = this.applyItemEffect(e, item, action.targetId, { byEnemy: e });
      if (!res.ok) return res;
      this.pool[action.item]--;
      this.log({ ev: 'enemy-item', who: e.id, item: action.item, target: action.targetId });
      this.spendTurn(e);
      return { ok: true };
    }
    if (action.kind === 'move') {
      const move = e.moves.find(m => m.n === action.move);
      if (!move) return { ok: false, refuse: true };
      const targets = this.pickEnemyTargets(e, move, action.targetId);
      if (!targets.length) return { ok: false, refuse: true };
      this.resolveEnemyMove(e, move, targets);
      if (!e.dead) this.spendTurn(e);
      return { ok: true };
    }
    return { ok: false, refuse: true };
  }

  pickEnemyTargets(e, move, chosenId) {
    if (move.t === 'self') return [e];
    if (move.t === 'all') return this.livingParty();
    if (move.t === 'allies') return this.livingEnemies();
    if (move.t === 'ally') {
      if (chosenId) {
        const t = this.find(chosenId);
        return t && !this.dead(t) && t.kind === 'enemy' ? [t] : [];
      }
      const others = this.livingEnemies().filter(x => x !== e && !x.fake);
      const pool = others.length ? others : this.livingEnemies();
      return pool.length ? [pool[Math.floor(this.rng() * pool.length)]] : [];
    }
    // one player target
    if (chosenId) {
      const t = this.find(chosenId);
      return t && !this.dead(t) && t.kind === 'player' && !t.benched ? [t] : [];
    }
    const pool = this.livingParty();
    return pool.length ? [pool[Math.floor(this.rng() * pool.length)]] : [];
  }

  resolveEnemyMove(e, move, targets) {
    const fx = this.moveFx(e, move);
    if (fx.cpCost && e.cp != null) e.cp = Math.max(0, e.cp - fx.cpCost);
    if (fx.oncePerFight) e.usedMoves.push(move.n);
    this.announce(`${e.name} uses ${move.n}!`);
    this.log({ ev: 'enemy-move', who: e.id, move: move.n, targets: targets.map(t => t.id) });

    // Attack element resolution.
    let attackEl = currentElement(e);
    if (fx.forceElement) attackEl = fx.forceElement;
    if (fx.randomElement) attackEl = RING[Math.floor(this.rng() * 4)];
    if (fx.attackElementOwnWeakness) attackEl = ringPrev(currentElement(e));   // the element that beats him

    // Self-directed verbs.
    if (fx.selfDamage) this.applyDamage(e, Math.round(fx.selfDamage * rollVariance(10, this.rng)), { style: 'dmg', source: e.id });
    if (fx.selfHeal) this.heal(e, fx.selfHeal);
    if (fx.selfHealPctMax) this.heal(e, Math.round(e.maxHp * fx.selfHealPctMax / 100));
    if (fx.selfRandomElement) {
      e.elementSet = null;
      this.applyElementSet(e, RING.filter(x => x !== e.element)[Math.floor(this.rng() * 3)], null);
      if (e.elementSet) e.elementSet.turnsLeft = 999;   // his own instability, rerolled by the move, not the clock
    }

    const hits = fx.hits || 1;
    for (const target of targets) {
      for (let h = 0; h < hits; h++) {
        if (this.dead(target) && !target.fake) break;
        if (!accuracyRoll(move.acc, e, this.rng)) {
          this.float(target.id, 'MISS', 'miss');
          this.log({ ev: 'miss', who: e.id, target: target.id, action: move.n });
          continue;
        }
        // Ally-directed verbs (enemy supports its own side; these cannot miss by data).
        const isSupport = fx.healAlly || fx.allyStatChange || fx.allyStatus || fx.allyCureAll || fx.allyStripDown;
        if (target.kind === 'enemy' && isSupport) {
          if (fx.healAlly) {
            this.heal(target, fx.healAlly.amount || fx.healAlly);
            if (fx.healAlly.cureStatus) this.cureStatus(target, fx.healAlly.cureStatus, 'cured');
          }
          if (fx.allyStatChange) this.applyStatChange(target, { ...fx.allyStatChange });
          if (fx.allyStatus) this.tryApplyStatus(target, fx.allyStatus, e, { force: true });
          if (fx.allyCureAll) this.cureAllStatuses(target, null);
          if (fx.allyStripDown) {
            const down = target.statChanges.find(sc => sc.dir === 'down');
            if (down) {
              target.statChanges.splice(target.statChanges.indexOf(down), 1);
              this.announce(`${e.name} strips ${down.stat} Down from ${target.name}.`);
            }
          }
          continue;
        }
        if (move.mp > 0) {
          // Per-hit output is dpa × MP with the ruled ±10% variance.
          let raw = enemyRaw(e, move.mp, this.rng);
          if (fx.plusCurrentHpPct) raw += target.hp * fx.plusCurrentHpPct / 100;
          raw = this.enemyOffensiveModifiers(e, target, raw);
          let el = attackEl;
          if (fx.attackElementBestVsTarget) el = this.bestElement([...RING], target);   // element chess, played back
          const crit = h === 0 && e.critCharged && !this.critBlocked(e, target);
          const dmg = finalDamage(raw, el, this.withBase(target), { crit, ignoresDef: !!fx.ignoresDef });
          this.applyDamage(target, dmg, { style: crit ? 'crit' : 'dmg', source: e.id });
          this.trackDefamed(e, 'dmg', dmg);
          if (fx.lifesteal) this.heal(e, dmg);
          this.log({ ev: 'hit', who: e.id, target: target.id, action: move.n, dmg, crit });
        }
        if (this.dead(target)) continue;
        const statuses = fx.statuses || (fx.status ? [fx.status] : []);
        for (const st of statuses) this.tryApplyStatus(target, st, e);
        if (fx.statChange) this.applyStatChange(target, { ...fx.statChange });
        if (fx.setElementRandom) {
          const el = RING.filter(x => x !== target.element)[Math.floor(this.rng() * 3)];
          this.applyElementSet(target, el, e);
        }
        if (fx.drainCp) {
          const [lo, hi] = fx.drainCp;
          const n = lo + Math.floor(this.rng() * (hi - lo + 1));
          if (target.kind === 'player') target.cp = Math.max(0, target.cp - n);
          this.float(target.id, `−${n} CP`, 'miss');
          this.announce(`${e.name} drains ${n} CP from ${this.dispName(target)}!`);
          this.log({ ev: 'drain', who: e.id, target: target.id, cp: n });
        }
        if (Object.keys(fx).length === 0 && move.mp === 0 && move.fx) {
          // Un-transcribed special: surface it to the GM rather than half-building it.
          this.emit({ kind: 'gm-note', text: `${e.name} · ${move.n}: "${move.fx}" — resolve by hand (not in the effects table).` });
        }
      }
    }
    if (fx.summon) {
      const total = fx.summon.count;
      const real = fx.summon.realCount ?? total;
      const picks = [];
      for (let i = 0; i < total; i++) picks.push(i >= real);
      for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
      for (let i = 0; i < total; i++) this.spawnInstance({ template: fx.summon.name, control: 'ai', drop: { type: 'none' }, fake: picks[i] }, e.wave);
      this.announce(`${e.name} conjures ${total} × ${fx.summon.name}${real < total ? ' — but which is real?' : ''}!`);
    }
    // Source's cadence: a self-heal rides every action the template takes.
    const passives = this.templatePassives(e);
    if (passives.selfHealPerAction) this.heal(e, passives.selfHealPerAction + (e.selfHealBonus || 0));
  }

  // Scripted Purification mirror: +25% against targets at or below 30% HP.
  enemyOffensiveModifiers(e, target, raw) {
    if (this.templatePassives(e).purification) {
      const maxHp = target.kind === 'player' ? memberBase(this.data, target).hp : target.maxHp;
      if (target.hp / maxHp <= 0.3) raw *= 1.25;
    }
    return raw;
  }
}
