// The scene machine (off-lobby-intro.md §2): beats, choice gates, ceremony beats,
// branches, the sparkle protocol, and the GM's conductor. The machinery is engine
// work; the text is authored content from the scene's data file.
//
// Rules encoded:
// - Continue is never locked; advancing past a pending player leaves their gate
//   open in parallel, and their choice records whenever made.
// - Hover micro-lines are private to the hovering player.
// - A sparkle pulses on everyone else's screen when any player confirms.
// - The GM can set or change any choice by hand.

import { statsAt } from './engine/members.js';

export class SceneRun {
  constructor(data, campaign, sceneDef, { emit = () => {} } = {}) {
    this.data = data;
    this.campaign = campaign;
    this.def = sceneDef;
    this.emit = emit;
    this.state = {
      sceneId: sceneDef.id,
      beatIndex: 0,
      subIndex: 0,          // within ceremony beats
      choices: {},          // seat -> {key: value}
      done: false,
    };
  }

  beat() { return this.def.beats[this.state.beatIndex]; }

  // GM Continue: advance sub-step or beat. Never locked.
  advance() {
    const b = this.beat();
    if (!b) { this.state.done = true; return; }
    if (b.type === 'ceremony-stats' && this.state.subIndex < b.lines.length - 1) {
      this.state.subIndex++;
      return;
    }
    this.state.subIndex = 0;
    if (this.state.beatIndex >= this.def.beats.length - 1) {
      this.state.done = true;
      this.emit({ kind: 'scene-ended', scene: this.def.id });
      return;
    }
    this.state.beatIndex++;
    const nb = this.beat();
    // Branch beats apply their overrides the moment they play.
    if (nb && nb.type === 'branch-text' && nb.override) {
      for (const [seat, ch] of Object.entries(this.state.choices)) {
        if (ch[nb.on] === nb.equals) this.recordChoice(seat, nb.override.key, nb.override.value, { silent: true });
      }
    }
  }

  jumpTo(index) { this.state.beatIndex = Math.max(0, Math.min(this.def.beats.length - 1, index)); this.state.subIndex = 0; }

  // A gate is open for a seat if its beat has been reached and the seat hasn't confirmed.
  openGatesFor(seat) {
    const gates = [];
    for (let i = 0; i <= this.state.beatIndex && i < this.def.beats.length; i++) {
      const b = this.def.beats[i];
      if ((b.type === 'choice' || b.type === 'input') && !(this.state.choices[seat] || {})[b.key]) {
        gates.push({ index: i, beat: b });
      }
    }
    return gates;
  }

  recordChoice(seat, key, value, { silent = false } = {}) {
    this.state.choices[seat] = this.state.choices[seat] || {};
    this.state.choices[seat][key] = value;
    const member = this.campaign.party.find(m => m.id === seat);
    if (member) this.applyToMember(member, key, value);
    if (!silent) this.emit({ kind: 'sparkle-pulse', from: seat });   // never labeled, never explained
  }

  applyToMember(member, key, value) {
    if (key === 'class') {
      const wasDefaultName = Object.keys(this.data.classKits.classes).includes(member.name);
      member.klass = value;
      member.element = this.data.classKits.classes[value].element;
      if (wasDefaultName) member.name = value;   // placeholder names follow the chosen class
      const s = statsAt(this.data, value, member.level);
      member.hp = s.hp; member.cp = s.cp;
    } else if (key === 'name') {
      member.name = String(value).slice(0, 40) || member.name;
    } else if (key === 'gender') {
      member.gender = value;
    } else {
      // Desire, Fear, Virtue, final feeling — recorded onto the character sheet,
      // mechanically inert, permanently in reach of the GM's narration.
      member.flavor[key] = value;
    }
  }

  hoverLine(beatIndex, option) {
    const b = this.def.beats[beatIndex];
    return b && b.hoverLines ? b.hoverLines[option] || null : null;
  }

  // What a given player seat sees right now.
  viewFor(seat) {
    const b = this.beat();
    const gates = this.openGatesFor(seat);
    const my = this.state.choices[seat] || {};
    const view = {
      sceneId: this.def.id, done: this.state.done,
      beatIndex: this.state.beatIndex, subIndex: this.state.subIndex,
      gate: gates.length ? gates[gates.length - 1] : null,
      waiting: !gates.length,
      beat: null,
    };
    if (!b) return view;
    const t = { ...b };
    if (b.type === 'branch-text') {
      t.lines = my[b.on] === b.equals || (b.override && my[b.override.key] === b.override.value && my[b.on] === b.equals)
        ? b.textIf : b.textElse;
      // Only the Mercy-choosers see their virtue overwritten.
      if (my[b.on] === b.equals) t.lines = b.textIf;
      else t.lines = b.textElse;
    }
    if (b.type === 'ceremony-stats') {
      const member = this.campaign.party.find(m => m.id === seat);
      const stats = member ? statsAt(this.data, member.klass, 1) : null;
      t.values = stats;
      t.revealed = b.lines.slice(0, this.state.subIndex + 1).map(l => l.stat);
    }
    if (b.type === 'ceremony-competences') {
      const member = this.campaign.party.find(m => m.id === seat);
      if (member) {
        t.competences = this.data.classKits.classes[member.klass].competences
          .filter(c => c.level <= 1).map(c => ({ name: c.name, cp: c.cp, effect: c.effect }));
      }
    }
    if (b.type === 'choice' && b.reactions && my[b.key]) t.reaction = b.reactions[my[b.key]];
    if (b.perPlayerName) {
      const member = this.campaign.party.find(m => m.id === seat);
      t.text = member ? member.name + '.' : t.text;
    }
    view.beat = t;
    return view;
  }

  // The conductor: full beat list, current beat, choice matrix, pending indicators.
  gmView(connectedSeats) {
    return {
      sceneId: this.def.id, name: this.def.name, done: this.state.done,
      beatIndex: this.state.beatIndex, subIndex: this.state.subIndex,
      beats: this.def.beats.map((b, i) => ({
        index: i, type: b.type, key: b.key || null,
        label: b.title || b.text || (b.lines ? '(ceremony)' : b.type) || b.type,
      })),
      matrix: this.state.choices,
      pending: this.def.beats
        .filter((b, i) => (b.type === 'choice' || b.type === 'input') && i <= this.state.beatIndex)
        .map(b => ({
          key: b.key,
          waiting: this.campaign.party.map(m => m.id).filter(s => !(this.state.choices[s] || {})[b.key]),
        })),
    };
  }
}
