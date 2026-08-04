// Campaign state: everything that persists server-side across sessions —
// party, inventory, credits, rooms and staged pieces, encounter library,
// enemy template overlay, reveal flags, jukebox, notes, snapshots.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CLASSES } from '../shared/constants.js';
import { makeMember, statsAt } from './engine/members.js';

export function newCampaign(data) {
  const party = CLASSES.map((klass, i) => {
    const m = makeMember(data, klass, 1);
    m.id = `P${i + 1}`;       // seat id; class is the intro's Body choice, GM-overridable
    return m;
  });
  return {
    party,
    inventory: {},            // shared, uncapped; starting loadout is stocked by the GM at session zero
    credits: 0,
    paused: false,
    location: { zone: 'Zone 1', name: 'lobby' },
    mode: 'lobby',            // lobby | intro | overworld | battle | shop | rest
    rooms: {},                // location name -> room JSON (floors/structs/props/pieces/palette/music)
    templates: {},            // GM enemy-template overlay (bestiary stays untouched on disk)
    encounters: {},           // saved encounter definitions by name
    zoneDropTables: {},       // GM-stocked Cutpurse tables per zone
    shop: null,               // active shop: { stock: {name:{on,price}}, mode }
    scene: null,              // active cutscene state (scene machine)
    scenes: {},               // authored scene overlay (intro ships as the first entry)
    jukebox: { track: null, queue: [], playing: false },
    musicZones: {},           // track file -> zone heading (folders are layout; this is the GM's re-shelving)
    sceneMusic: {},           // scene id -> track that starts looping when the scene starts
    notes: {},                // GM notes by key ("room:alma", "enc:dedan", "tmpl:Tiburce")
    log: [],                  // combat logs per encounter: {id, name, startedAt, entries[]}
    poisonNote: 'Poisoned ticks 1/10 max HP per location transition',
  };
}

export class Store {
  constructor(data, varDir) {
    this.data = data;
    this.varDir = varDir;
    this.snapDir = path.join(varDir, 'snapshots');
    mkdirSync(this.snapDir, { recursive: true });
    this.file = path.join(varDir, 'campaign-state.json');
    this.campaign = this.loadFromDisk() || newCampaign(data);
    this.dirty = false;
    this.lastUndo = null;     // single-step undo for GM hand-edits (Players/Items panels)
  }

  loadFromDisk() {
    try {
      if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) { console.error('state load failed:', e.message); }
    return null;
  }

  markDirty() { this.dirty = true; }

  persist() {
    if (!this.dirty) return;
    writeFileSync(this.file, JSON.stringify(this.campaign, null, 1));
    this.dirty = false;
  }

  // Human-readable JSON snapshots; auto before boss launches and at will.
  snapshot(name) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${stamp}__${(name || 'snapshot').replace(/[^\w\- ]+/g, '')}.json`;
    writeFileSync(path.join(this.snapDir, fname), JSON.stringify(this.campaign, null, 1));
    return fname;
  }

  listSnapshots() {
    return readdirSync(this.snapDir).filter(f => f.endsWith('.json')).sort().reverse()
      .map(f => ({ file: f, name: f.replace(/^[^_]*__/, '').replace(/\.json$/, ''), at: f.split('__')[0] }));
  }

  restore(file) {
    const p = path.join(this.snapDir, path.basename(file));
    this.campaign = JSON.parse(readFileSync(p, 'utf8'));
    this.dirty = true;
    return this.campaign;
  }

  // Record state before a GM hand-edit so the last one can be undone.
  recordUndo(desc) {
    this.lastUndo = { desc, state: JSON.stringify(this.campaign) };
  }

  undo() {
    if (!this.lastUndo) return null;
    const desc = this.lastUndo.desc;
    this.campaign = JSON.parse(this.lastUndo.state);
    this.lastUndo = null;
    this.dirty = true;
    return desc;
  }

  // Milestone level grant: heal to the new maximums.
  setLevel(member, level) {
    member.level = Math.max(1, Math.min(20, level));
    const s = statsAt(this.data, member.klass, member.level);
    member.hp = s.hp;
    member.cp = s.cp;
  }
}
