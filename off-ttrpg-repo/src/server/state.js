// Campaign state: everything that persists server-side across sessions —
// party, inventory, credits, rooms and staged pieces, encounter library,
// enemy template overlay, reveal flags, jukebox, notes, snapshots.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
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
    mode: 'lobby',            // lobby | scene | overworld | battle
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
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      // Never silently overwrite an unreadable save: set it aside so it can be
      // recovered by hand, and say so loudly.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, aside); } catch { /* best effort */ }
      console.error(`state load failed (${e.message}) — bad file moved to ${aside}; starting a new campaign`);
      return null;
    }
  }

  // Any change other than the undo itself retires the undo point: undo is for
  // the hand-edit just made, never a rollback of everything since.
  markDirty() { this.dirty = true; if (this.lastUndo) this.lastUndo.stale++; }

  // Write-then-rename so a crash or redeploy mid-write can't truncate the save.
  writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  persist() {
    if (!this.dirty) return;
    this.writeAtomic(this.file, JSON.stringify(this.campaign, null, 1));
    this.dirty = false;
  }

  // Human-readable JSON snapshots; auto before boss launches and at will.
  snapshot(name) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${stamp}__${(name || 'snapshot').replace(/[^\w\- ]+/g, '')}.json`;
    this.writeAtomic(path.join(this.snapDir, fname), JSON.stringify(this.campaign, null, 1));
    this.snapCache = null;
    return fname;
  }

  // Cached: the GM view lists these on every state push.
  listSnapshots() {
    if (!this.snapCache) {
      this.snapCache = readdirSync(this.snapDir).filter(f => f.endsWith('.json')).sort().reverse()
        .map(f => ({ file: f, name: f.replace(/^[^_]*__/, '').replace(/\.json$/, ''), at: f.split('__')[0] }));
    }
    return this.snapCache;
  }

  restore(file) {
    const p = path.join(this.snapDir, path.basename(file));
    this.campaign = JSON.parse(readFileSync(p, 'utf8'));
    this.lastUndo = null;
    this.dirty = true;
    return this.campaign;
  }

  // Record state before a GM hand-edit so the last one can be undone. The
  // edit's own touch() is expected (stale 1); anything beyond retires it.
  recordUndo(desc) {
    this.lastUndo = { desc, state: JSON.stringify(this.campaign), stale: 0 };
  }

  undoDesc() { return this.lastUndo && this.lastUndo.stale <= 1 ? this.lastUndo.desc : null; }

  undo() {
    if (!this.undoDesc()) return null;
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
