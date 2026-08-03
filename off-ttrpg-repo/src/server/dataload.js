// Loads the design data files (the executable form of the design — never re-derived)
// plus this build's transcription tables, and validates that every competence in the
// class kits has a rider classification. Fails loud on any gap: an effect the engine
// cannot express gets flagged, never half-built.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

export function loadAll() {
  const levelTables = loadJson(path.join(DATA_DIR, 'off-level-tables.json'));
  const classKits = loadJson(path.join(DATA_DIR, 'off-class-kits.json'));
  const bestiary = loadJson(path.join(DATA_DIR, 'off-campaign-bestiary.json'));
  const palettes = loadJson(path.join(DATA_DIR, 'off-palettes.json'));
  const gear = loadJson(path.join(DATA_DIR, 'off-gear-tables.json'));

  const riders = loadJson(path.join(here, 'data', 'comp-riders.json'));
  const items = loadJson(path.join(here, 'data', 'items.json'));
  const scripts = loadJson(path.join(here, 'data', 'enemy-scripts.json'));

  // Validate: every competence row must have a rider classification.
  const problems = [];
  for (const [klass, kit] of Object.entries(classKits.classes)) {
    for (const comp of kit.competences) {
      if (!riders[klass] || !riders[klass][comp.name]) {
        problems.push(`${klass}/${comp.name} has no rider classification`);
      }
    }
  }
  if (problems.length) {
    throw new Error('comp-riders.json does not cover the class kits:\n' + problems.join('\n'));
  }

  const itemsByName = {};
  for (const it of items.catalog) itemsByName[it.name] = it;

  const enemiesByName = {};
  for (const e of bestiary.enemies) enemiesByName[e.name] = e;

  return { levelTables, classKits, bestiary, enemiesByName, palettes, gear, riders, items, itemsByName, scripts };
}
