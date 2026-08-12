// Canon map importer — offline batch converter per assets/level creation/README.
// Reads RPG Maker 2003 LCF binaries (Map####.lmu, RPG_RT.ldb, RPG_RT.lmt) and
// emits, per map: tilemap.json (neutral render recipe, autotile shapes already
// resolved to chipset-relative quadrant rects), collision.json (16px boolean
// grid), pins.json (event positions + Transfer Player destinations); plus one
// global rooms-index.json (names via the LMT + door connectivity).
//
// The engine never parses LCF — it dumb-blits tilemap.json from whichever
// chipset PNG the GM picks. Chunk IDs and tile math verified against the
// EasyRPG project's liblcf/Player documentation of the formats.
//
// Usage: node import-lmu.mjs [--one MapNNNN]   (from anywhere; paths are fixed)
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../assets/level creation/', import.meta.url));
const OUT = fileURLToPath(new URL('../server/data/canon/', import.meta.url));

// ---------------------------------------------------------------- LCF reading
class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  eof() { return this.p >= this.b.length; }
  u8() { return this.b[this.p++]; }
  varint() {                       // big-endian 7-bit groups, high bit = continue
    let v = 0;
    for (;;) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v >>> 0;
    }
  }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  str(n) { return Buffer.from(this.bytes(n)).toString('latin1'); }  // OFF is FR → cp1252-ish
  header() { const n = this.varint(); return this.str(n); }
}

// Read a chunk stream (id 0 terminates when `zeroEnds`); cb(id, dataReader, len).
function chunks(r, cb, { zeroEnds = true } = {}) {
  while (!r.eof()) {
    const id = r.varint();
    if (zeroEnds && id === 0) return;
    const len = r.varint();
    const body = new R(r.bytes(len));
    cb(id, body, len);
  }
}

// LCF array-of-structs: count, then per element: 1-based index, chunk stream.
function lcfArray(r, cb) {
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const idx = r.varint();
    const fields = {};
    chunks(r, (id, body, len) => { fields[id] = { body, len }; });
    cb(idx, fields);
  }
}

function readI16(bytes, len) {
  const out = new Int16Array(len / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  return out;
}

// ---------------------------------------------------------------- LMU (maps)
function parseLmu(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfMapUnit') throw new Error('not an LMU');
  const map = { chipsetId: 1, w: 20, h: 15, lower: null, upper: null, events: [] };
  chunks(r, (id, body, len) => {
    if (id === 0x01) map.chipsetId = body.varint();
    else if (id === 0x02) map.w = body.varint();
    else if (id === 0x03) map.h = body.varint();
    else if (id === 0x1f) map.panoFlag = !!body.varint();
    else if (id === 0x20) map.pano = body.str(len).trim();
    else if (id === 0x47) map.lower = readI16(body.b, len);
    else if (id === 0x48) map.upper = readI16(body.b, len);
    else if (id === 0x51) {
      lcfArray(body, (evId, f) => {
        const ev = { id: evId, name: '', x: 0, y: 0, doors: [], condTiles: [] };
        if (f[0x01]) ev.name = f[0x01].body.str(f[0x01].len).trim();
        if (f[0x02]) ev.x = f[0x02].body.varint();
        if (f[0x03]) ev.y = f[0x03].body.varint();
        if (f[0x05]) {
          lcfArray(f[0x05].body, (pageId, pf) => {
            // Page condition (chunk 0x02): flags bit 1/2 = switches, 4 = variable,
            // 8 = item-in-inventory. A conditioned page's graphic is scenery that
            // appears when the story says so — the Zone 0 secret door.
            let cond = null;
            if (pf[0x02]) {
              const cc = {};
              chunks(pf[0x02].body, (cid, cb) => { cc[cid] = cb.varint(); });
              if (cc[0x01]) cond = { flags: cc[0x01], switchA: cc[0x02] || 0, switchB: cc[0x03] || 0, varId: cc[0x04] || 0, varVal: cc[0x05] || 0, itemId: cc[0x06] || 0 };
            }
            const charset = pf[0x15] ? pf[0x15].body.str(pf[0x15].len).trim() : '';
            const tileIdx = pf[0x16] ? pf[0x16].body.varint() : 0;
            const layer = pf[0x22] ? pf[0x22].body.varint() : 0;
            if (!charset && tileIdx > 0) {
              // Unconditioned page 1 bakes as static scenery — doors, ladders,
              // signs. Conditioned pages (any number) become toggleable scenery.
              if (pageId === 1 && !cond) ev.tile = { idx: tileIdx, above: layer === 2 };
              else if (cond) ev.condTiles.push({ idx: tileIdx, above: layer === 2, cond });
            }
            if (!pf[0x34]) return;
            for (const c of parseCommands(pf[0x34].body)) {
              if (c.code === 10810 && c.params.length >= 3) {
                ev.doors.push({ map: c.params[0], x: c.params[1], y: c.params[2] });
              }
            }
          });
        }
        map.events.push(ev);
      });
    }
  }, { zeroEnds: false });
  return map;
}

function parseCommands(r) {
  const out = [];
  while (!r.eof()) {
    const code = r.varint();
    r.varint();                          // indent
    const slen = r.varint(); r.bytes(slen);
    const argc = r.varint();
    const params = [];
    for (let i = 0; i < argc; i++) params.push(r.varint());
    if (code) out.push({ code, params });
  }
  return out;
}

// ---------------------------------------------------------------- LDB
// Chipsets (0x14) for rendering/passability; item (0x0D) and switch (0x17)
// names so condition-gated scenery gets a human-readable label.
function parseLdb(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfDataBase') throw new Error('not an LDB');
  const chipsets = {}, items = {}, switches = {};
  chunks(r, (id, body) => {
    if (id === 0x14) {
      lcfArray(body, (csId, f) => {
        const cs = { name: '', lower: null, upper: null };
        if (f[0x02]) cs.name = f[0x02].body.str(f[0x02].len).trim();
        if (f[0x04]) cs.lower = Buffer.from(f[0x04].body.b);
        if (f[0x05]) cs.upper = Buffer.from(f[0x05].body.b);
        chipsets[csId] = cs;
      });
    } else if (id === 0x0d) {
      lcfArray(body, (itId, f) => { if (f[0x01]) items[itId] = f[0x01].body.str(f[0x01].len).trim(); });
    } else if (id === 0x17) {
      lcfArray(body, (swId, f) => { if (f[0x01]) switches[swId] = f[0x01].body.str(f[0x01].len).trim(); });
    }
  }, { zeroEnds: false });
  return { chipsets, items, switches };
}

// ---------------------------------------------------------------- LMT (names)
function parseLmt(buf) {
  const r = new R(buf);
  if (r.header() !== 'LcfMapTree') throw new Error('not an LMT');
  const names = {};
  const parents = {};
  lcfArray(r, (id, f) => {
    if (f[0x01]) names[id] = f[0x01].body.str(f[0x01].len).trim();
    if (f[0x02]) parents[id] = f[0x02].body.varint();
  });
  return { names, parents };              // trailing tree-order data is irrelevant here
}

// ---------------------------------------------------------------- name translation
// The LMT names are Mortis Ghost's French editor labels (never player-facing in
// the game itself). The UI shows English: literal translations, with the
// established fan-translation terms where one exists (Sucre → Sugar, La
// Chambre → The Room). Unmatched names pass through a generic word-level pass.
const NAME_EN = {
  '-> titre': '-> Title',
  '1er étage': '1st Floor', '2ème étage': '2nd Floor', '3ème étage': '3rd Floor',
  '4ème étage': '4th Floor', '5ème étage': '5th Floor',
  'Aile droite': 'Right Wing', 'Aile gauche': 'Left Wing', 'Aile gauche blanche': 'Left Wing (White)',
  'Balcon 1': 'Balcony 1', 'Balcon 2': 'Balcony 2',
  'Ballman QG': 'Ballman HQ', 'BallVillenoire': 'Black Ballville',
  'Bibliothèque': 'Library',
  'boyeau 1': 'Tunnel 1', 'boyeau 2': 'Tunnel 2', 'boyeau 3': 'Tunnel 3', 'boyeau 4': 'Tunnel 4',
  'boyeau profond': 'Deep Tunnel',
  'Bunker est': 'East Bunker', 'Bunker nord': 'North Bunker', 'Bunker sud': 'South Bunker',
  "Bureau d'Enoch": "Enoch's Office", 'Bureau de Dedan': "Dedan's Office",
  'Bureau de Zacharie': "Zacharie's Office", 'Bureau du directeur': "Director's Office",
  'Cafétaria': 'Cafeteria',
  'Centre (est)': 'Center (East)', 'Centre (nord)': 'Center (North)',
  'Centre (ouest)': 'Center (West)', 'Centre (sud)': 'Center (South)',
  'Centre Commercial': 'Shopping Mall', 'Centre du parc': 'Park Center',
  'Chambres est': 'East Bedrooms', 'Chambres ouest': 'West Bedrooms',
  'Chapitre 0': 'Chapter 0', 'Chapitre 1': 'Chapter 1', 'Chapitre 2': 'Chapter 2',
  'Chapitre 3': 'Chapter 3', 'Chapitre 4': 'Chapter 4', 'Chapitre 5': 'Chapter 5',
  'cheminée': 'Chimney',
  'corridor': 'Corridor', 'corridor secret': 'Secret Corridor',
  'couloir': 'Hallway', 'couloir 1': 'Hallway 1', 'Couloir 1': 'Hallway 1',
  'couloir 2': 'Hallway 2', 'couloir 2 bis': 'Hallway 2b',
  "Couloir d'Enoch": "Enoch's Hallway", "Couloir de l'interupteur": 'Switch Hallway',
  'Couloir du stress': 'Stress Hallway', 'couloir envers': 'Reverse Hallway',
  'Croisière': 'Cruise', 'Croisière du Bonheur': 'Happiness Cruise',
  'Cuisines': 'Kitchens',
  'dédale': 'Maze', 'dédale 1': 'Maze 1', 'dédale 2': 'Maze 2',
  'Dernière Salle': 'Final Hall', 'Descente': 'Descent',
  'Devant la Chambre': 'Before the Room', 'Devant la Chambre (white': 'Before the Room (White)',
  'Embarcations': 'Boats',
  'Entrée': 'Entrance', 'entrée cheminée': 'Chimney Entrance', 'entrée de la mine': 'Mine Entrance',
  'entrée des fontaines': 'Fountain Entrance', 'Entrée du Bureau': 'Office Entrance',
  'Entrepos de Sucre': "Sugar's Warehouse", 'Entrepot du Juge': "The Judge's Warehouse",
  'Escalier Monorail': 'Monorail Stairs',
  'escaliers 1': 'Stairs 1', 'escaliers 2': 'Stairs 2', 'escaliers 3': 'Stairs 3',
  'escaliers 4': 'Stairs 4', 'escaliers 5': 'Stairs 5',
  'Est': 'East', 'étables': 'Stables',
  'Etage 02584': 'Floor 02584', 'Etage 10258': 'Floor 10258',
  'Etage 10258 1/2': 'Floor 10258 1/2', 'Etage 10258 2/3': 'Floor 10258 2/3',
  'Etage 10258 3/4': 'Floor 10258 3/4',
  'Etage de Dedan': "Dedan's Floor", 'Etage Secret': 'Secret Floor', 'Etages Divers': 'Misc Floors',
  'explications': 'Explanations',
  'Extérieur (Dedan)': 'Outside (Dedan)', 'Extérieur (Enoch)': 'Outside (Enoch)',
  'Extérieur (Full)': 'Outside (Full)', 'Extérieur (Japhet)': 'Outside (Japhet)',
  'facade': 'Facade', 'fermes': 'Farms',
  'Fin du Chapitre': 'Chapter End', 'Fin Secrète': 'Secret Ending',
  'Fours': 'Furnaces',
  'générique 1': 'Credits 1', 'générique 2': 'Credits 2', 'générique 3': 'Credits 3',
  'hors de la cabane': 'Outside the Cabin',
  'intérieur': 'Interior', 'Intérieur Monorail': 'Monorail Interior',
  'jeu de la chute funèbre': 'Funereal Fall Game', 'jeu de la chute mortelle': 'Deadly Fall Game',
  'Jeu des Ballons': 'Balloon Game',
  'La Chambre': 'The Room', 'La Chambre (white)': 'The Room (White)',
  'Le trône': 'The Throne',
  'Magasin de Zacharie': "Zacharie's Shop",
  'Maison 1': 'House 1', 'Maison 2': 'House 2', 'Maison 3': 'House 3',
  'mer 1': 'Sea 1', 'mer 2': 'Sea 2',
  'Mince Principale': 'Main Mine', 'mine annexe': 'Annex Mine',
  'Montagnes': 'Mountains', 'Montagnes Russes': 'Roller Coaster',
  'nord': 'North', 'Nord': 'North', 'nord-est': 'Northeast', 'nord-ouest': 'Northwest',
  'Ouest': 'West', 'Parc': 'Park',
  'passage': 'Passage', 'passage des mines': 'Mine Passage', 'passage est': 'East Passage',
  'passage extérieur': 'Outer Passage', 'Passage extérieur': 'Outer Passage',
  'Passage inférieur': 'Lower Passage', 'passage ouest': 'West Passage',
  'passage souterrain': 'Underground Passage', 'Passage vers le parc': 'Passage to the Park',
  'pièce 0': 'Room 0', 'pièce 1': 'Room 1', 'pièce 2': 'Room 2', 'pièce 3': 'Room 3',
  'pièce arrière': 'Back Room', 'pièce cachée': 'Hidden Room',
  "pièce de l'incendié": "Burned Man's Room", 'Pièce de la snes': 'SNES Room',
  'Pièce de Sucre': "Sugar's Room", 'Pièce de Zach': "Zach's Room",
  'pièce des indices 1': 'Clue Room 1', 'pièce des indices 2': 'Clue Room 2',
  'pièce du code': 'Code Room', 'pièce du coffre': 'Chest Room',
  'pièce du marchand': "Merchant's Room", 'pièce passage': 'Passage Room',
  'pièce secrète': 'Secret Room',
  "Plan de l'extérieur": 'Outside Map', 'Premier couloir': 'First Hallway',
  'Quartier Résidentiel': 'Residential District', 'rez-de-chaussée': 'Ground Floor',
  'Salle 1': 'Hall 1', 'Salle 2': 'Hall 2', 'Salle 3': 'Hall 3', 'Salle 4': 'Hall 4',
  'Salle des blocs': 'Block Hall', 'Salle Enigmatique': 'Enigmatic Hall',
  'Salles de Traitement': 'Treatment Halls', 'Salles de Traitement 1': 'Treatment Halls 1',
  'Salles de Transition': 'Transition Halls', 'Salles de Transition 1': 'Transition Halls 1',
  'Sans Enoch': 'Without Enoch', 'sauvegarde': 'Save',
  'Scène Hugo 1': 'Hugo Scene 1',
  'Section centrale (N)': 'Central Section (N)', 'Section centrale (NE)': 'Central Section (NE)',
  'Section centrale (NO)': 'Central Section (NW)', 'Section centrale (S)': 'Central Section (S)',
  'Section centrale (SE)': 'Central Section (SE)', 'Section centrale (SO)': 'Central Section (SW)',
  'Section centrale Out': 'Central Section Out',
  'sortie': 'Exit',
  'sous sol': 'Basement', 'Sous sol': 'Basement', 'sous-sol': 'Basement',
  'stopped monorail': 'Stopped Monorail',
  'sud-est': 'Southeast', 'sud-ouest': 'Southwest',
  'sur le chemin': 'On the Path',
  'terminus': 'Terminus', 'Terminus': 'Terminus',
  'toit': 'Roof', 'Toit': 'Roof',
  'vers Alma': 'Toward Alma', 'Vers Damien': 'Toward Damien',
  "vers l'extérieur": 'Toward Outside', 'vers les étables': 'Toward the Stables',
  'vers Shachihata': 'Toward Shachihata',
  'world map': 'World Map',
  'zone 0 (centre)': 'Zone 0 (Center)', 'zone 0 (sortie)': 'Zone 0 (Exit)',
  'zone blanche ultime': 'Final White Zone', "zone d'attersissage": 'Landing Zone',
};
function englishName(fr) {
  if (NAME_EN[fr]) return NAME_EN[fr];
  return fr;   // proper nouns (Alma, Bismark, Pentel…) and already-English labels
}

// ---------------------------------------------------------------- tile math
// Chipset PNGs: 480×256, 16px tiles (30×16 grid). Quadrants are 8×8.
// Lower-layer tile IDs: 0-2999 water A/B · 3000-3999 animated C ·
// 4000-4599 terrain autotiles D (12 × 50 shapes) · 5000-5143 plain lower E.
// Upper-layer IDs: 10000-10143 plain upper F.
// The shape variant is baked into the stored ID — no neighbor matching here.

// Water (A/B) quadrant table: value = A-block row for the quadrant, -1 = take
// the quadrant from the B block instead. Indexed [aShape][row][col].
const A_SUB = [
  [[-1, -1], [-1, -1]], [[3, -1], [-1, -1]], [[-1, 3], [-1, -1]], [[3, 3], [-1, -1]],
  [[-1, -1], [-1, 3]], [[3, -1], [-1, 3]], [[-1, 3], [-1, 3]], [[3, 3], [-1, 3]],
  [[-1, -1], [3, -1]], [[3, -1], [3, -1]], [[-1, 3], [3, -1]], [[3, 3], [3, -1]],
  [[-1, -1], [3, 3]], [[3, -1], [3, 3]], [[-1, 3], [3, 3]], [[3, 3], [3, 3]],
  [[1, -1], [1, -1]], [[1, 3], [1, -1]], [[1, -1], [1, 3]], [[1, 3], [1, 3]],
  [[2, 2], [-1, -1]], [[2, 2], [-1, 3]], [[2, 2], [3, -1]], [[2, 2], [3, 3]],
  [[-1, 1], [-1, 1]], [[-1, 1], [3, 1]], [[3, 1], [-1, 1]], [[3, 1], [3, 1]],
  [[-1, -1], [2, 2]], [[3, -1], [2, 2]], [[-1, 3], [2, 2]], [[3, 3], [2, 2]],
  [[1, 1], [1, 1]], [[2, 2], [2, 2]], [[0, 2], [1, -1]], [[0, 2], [1, 3]],
  [[2, 0], [-1, 1]], [[2, 0], [3, 1]], [[-1, 1], [2, 0]], [[3, 1], [2, 0]],
  [[1, -1], [0, 2]], [[1, 3], [0, 2]], [[0, 0], [1, 1]], [[0, 2], [0, 2]],
  [[1, 1], [0, 0]], [[2, 0], [2, 0]], [[0, 0], [0, 0]],
];

// Terrain (D) quadrant table: [shape][row][col] → [dx, dy] tile offsets into
// the autotile's 3×4 template block.
const D_SUB = [
  [[[1, 2], [1, 2]], [[1, 2], [1, 2]]], [[[2, 0], [1, 2]], [[1, 2], [1, 2]]],
  [[[1, 2], [2, 0]], [[1, 2], [1, 2]]], [[[2, 0], [2, 0]], [[1, 2], [1, 2]]],
  [[[1, 2], [1, 2]], [[1, 2], [2, 0]]], [[[2, 0], [1, 2]], [[1, 2], [2, 0]]],
  [[[1, 2], [2, 0]], [[1, 2], [2, 0]]], [[[2, 0], [2, 0]], [[1, 2], [2, 0]]],
  [[[1, 2], [1, 2]], [[2, 0], [1, 2]]], [[[2, 0], [1, 2]], [[2, 0], [1, 2]]],
  [[[1, 2], [2, 0]], [[2, 0], [1, 2]]], [[[2, 0], [2, 0]], [[2, 0], [1, 2]]],
  [[[1, 2], [1, 2]], [[2, 0], [2, 0]]], [[[2, 0], [1, 2]], [[2, 0], [2, 0]]],
  [[[1, 2], [2, 0]], [[2, 0], [2, 0]]], [[[2, 0], [2, 0]], [[2, 0], [2, 0]]],
  [[[0, 2], [0, 2]], [[0, 2], [0, 2]]], [[[0, 2], [2, 0]], [[0, 2], [0, 2]]],
  [[[0, 2], [0, 2]], [[0, 2], [2, 0]]], [[[0, 2], [2, 0]], [[0, 2], [2, 0]]],
  [[[1, 1], [1, 1]], [[1, 1], [1, 1]]], [[[1, 1], [1, 1]], [[1, 1], [2, 0]]],
  [[[1, 1], [1, 1]], [[2, 0], [1, 1]]], [[[1, 1], [1, 1]], [[2, 0], [2, 0]]],
  [[[2, 2], [2, 2]], [[2, 2], [2, 2]]], [[[2, 2], [2, 2]], [[2, 0], [2, 2]]],
  [[[2, 0], [2, 2]], [[2, 2], [2, 2]]], [[[2, 0], [2, 2]], [[2, 0], [2, 2]]],
  [[[1, 3], [1, 3]], [[1, 3], [1, 3]]], [[[2, 0], [1, 3]], [[1, 3], [1, 3]]],
  [[[1, 3], [2, 0]], [[1, 3], [1, 3]]], [[[2, 0], [2, 0]], [[1, 3], [1, 3]]],
  [[[0, 2], [2, 2]], [[0, 2], [2, 2]]], [[[1, 1], [1, 1]], [[1, 3], [1, 3]]],
  [[[0, 1], [0, 1]], [[0, 1], [0, 1]]], [[[0, 1], [0, 1]], [[0, 1], [2, 0]]],
  [[[2, 1], [2, 1]], [[2, 1], [2, 1]]], [[[2, 1], [2, 1]], [[2, 0], [2, 1]]],
  [[[2, 3], [2, 3]], [[2, 3], [2, 3]]], [[[2, 0], [2, 3]], [[2, 3], [2, 3]]],
  [[[0, 3], [0, 3]], [[0, 3], [0, 3]]], [[[0, 3], [2, 0]], [[0, 3], [0, 3]]],
  [[[0, 1], [2, 1]], [[0, 1], [2, 1]]], [[[0, 1], [0, 1]], [[0, 3], [0, 3]]],
  [[[0, 3], [2, 3]], [[0, 3], [2, 3]]], [[[2, 1], [2, 1]], [[2, 3], [2, 3]]],
  [[[0, 1], [2, 1]], [[0, 3], [2, 3]]], [[[1, 2], [1, 2]], [[1, 2], [1, 2]]],
  [[[1, 2], [1, 2]], [[1, 2], [1, 2]]], [[[0, 0], [0, 0]], [[0, 0], [0, 0]]],
];

// D autotile template top-left (in tile coords) for block 0..11.
function dBlockOrigin(block) {
  if (block < 4) return [(block % 2) * 3, 8 + Math.floor(block / 2) * 4];
  return [6 + (block % 2) * 3, Math.floor((block - 4) / 2) * 4];
}

// A cell is either a single 16×16 source [sx,sy], four 8×8 quadrant sources
// [TLx,TLy,TRx,TRy,BLx,BLy,BRx,BRy], or null (empty). Coordinates in px.
function lowerCell(id) {
  if (id >= 5000 && id < 5144) {
    const t = id - 5000;
    const col = t < 96 ? 12 + t % 6 : 18 + (t - 96) % 6;
    const row = t < 96 ? Math.floor(t / 6) : Math.floor((t - 96) / 6);
    return [col * 16, row * 16];
  }
  if (id >= 4000 && id < 4600) {
    const block = Math.floor((id - 4000) / 50), shape = (id - 4000) % 50;
    const [bx, by] = dBlockOrigin(block);
    const q = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const [dx, dy] = D_SUB[shape][j][i];
      q.push((bx + dx) * 16 + i * 8, (by + dy) * 16 + j * 8);
    }
    return q;
  }
  if (id >= 3000 && id < 4000) {
    const col = 3 + Math.floor((id - 3000) / 50);
    return [col * 16, 4 * 16];           // static frame 0 of the C animation
  }
  if (id >= 0 && id < 3000) {
    // Water: block 0 = A1+coast, 1 = A2+coast, 2 = A1+deep.
    const block = Math.floor(id / 1000);
    const bSub = Math.floor((id % 1000) / 50), aSub = id % 50;
    if (aSub > 46) return null;
    const q = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const a = A_SUB[aSub][j][i];
      let col, row;
      let t = (bSub >> (j * 2 + i)) & 1;
      if (a === -1) {
        if (block === 2) t ^= 3;
        col = 0; row = 4 + t;            // B block, frame 0
      } else {
        col = block === 1 ? 3 : 0;       // A1 or A2, frame 0
        row = a;
      }
      // combined A+B: a B corner overrides where its bit is set
      if (bSub !== 0 && aSub !== 0 && a !== -1) {
        let bt = (bSub >> (j * 2 + i)) & 1;
        if (block === 2) bt *= 2;
        if (bt !== 0) { col = 0; row = 4 + bt; }
      }
      q.push(col * 16 + i * 8, row * 16 + j * 8);
    }
    return q;
  }
  return null;
}

function upperCell(id) {
  if (id === 10000) return null;         // F tile 0 is the blank upper tile
  if (id >= 10000 && id < 10144) {
    const t = id - 10000;
    const col = t < 48 ? 18 + t % 6 : 24 + (t - 48) % 6;
    const row = t < 48 ? 8 + Math.floor(t / 6) : Math.floor((t - 48) / 6);
    return [col * 16, row * 16];
  }
  return null;
}

// ---------------------------------------------------------------- passability
// passable_data_lower indices: water block 0-2 → 0-2, C → 3-5, D → 6-17,
// E → 18+tile. passable_data_upper: F tile directly. Bits: 1 down, 2 left,
// 4 right, 8 up, 0x10 above-hero, 0x20 wall, 0x40 counter.
function lowerPassIndex(id) {
  if (id >= 5000 && id < 5144) return 18 + (id - 5000);
  if (id >= 4000 && id < 4600) return 6 + Math.floor((id - 4000) / 50);
  if (id >= 3000 && id < 4000) return 3 + Math.floor((id - 3000) / 50);
  if (id >= 0 && id < 3000) return Math.floor(id / 1000);
  return null;
}

function cellWalkable(lowId, upId, cs) {
  // RM2k rule: a present upper (F) tile REPLACES the lower tile's passability
  // entirely — unless it's above-hero (star), which never blocks and defers to
  // the lower tile. Ladders and walkways are passable upper tiles laid over
  // impassable wall/void tiles; requiring both layers broke every ladder.
  if (upId > 10000 && upId < 10144 && cs.upper) {   // 10000 itself = blank
    const ubits = cs.upper[upId - 10000] ?? 0x0f;
    if (!(ubits & 0x10)) return (ubits & 0x0f) !== 0;
  }
  const li = lowerPassIndex(lowId);
  const lbits = li != null && cs.lower && li < cs.lower.length ? cs.lower[li] : 0x0f;
  return (lbits & 0x0f) !== 0;
}

function upperAbove(upId, cs) {
  if (upId >= 10000 && upId < 10144 && cs.upper) return !!(cs.upper[upId - 10000] & 0x10);
  return false;
}

// ---------------------------------------------------------------- batch
const only = process.argv.includes('--one') ? process.argv[process.argv.indexOf('--one') + 1] : null;

const { chipsets: ldb, items: ldbItems, switches: ldbSwitches } = parseLdb(readFileSync(path.join(SRC, 'RPG_RT.ldb')));
const lmt = parseLmt(readFileSync(path.join(SRC, 'RPG_RT.lmt')));
const chipFiles = readdirSync(path.join(SRC, 'chipset')).filter(f => /\.png$/i.test(f));
console.log(`LDB: ${Object.keys(ldb).length} chipsets, ${Object.keys(ldbItems).length} items, ${Object.keys(ldbSwitches).length} switches · LMT: ${Object.keys(lmt.names).length} map names · ${chipFiles.length} chipset PNGs`);

// Human-readable label for a page condition — this is the toggle's name in the
// GM console, so favor the story-facing part (item/switch names) over IDs.
function condLabel(cond) {
  const parts = [];
  if (cond.flags & 1) parts.push(ldbSwitches[cond.switchA] ? `switch "${ldbSwitches[cond.switchA]}"` : `switch #${cond.switchA}`);
  if (cond.flags & 2) parts.push(ldbSwitches[cond.switchB] ? `switch "${ldbSwitches[cond.switchB]}"` : `switch #${cond.switchB}`);
  if (cond.flags & 4) parts.push(`var #${cond.varId} ≥ ${cond.varVal}`);
  if (cond.flags & 8) parts.push(ldbItems[cond.itemId] ? `has "${ldbItems[cond.itemId]}"` : `has item #${cond.itemId}`);
  return parts.join(' & ') || 'special';
}

const mapFiles = readdirSync(path.join(SRC, 'maps')).filter(f => /^Map\d+\.lmu$/i.test(f)).sort();
const index = { maps: {}, chipsets: chipFiles };
let done = 0, failed = 0;

for (const mf of mapFiles) {
  const mapKey = mf.replace(/\.lmu$/i, '');
  if (only && mapKey !== only) continue;
  const mapId = parseInt(mapKey.slice(3), 10);
  try {
    const m = parseLmu(readFileSync(path.join(SRC, 'maps', mf)));
    if (!m.lower || m.lower.length !== m.w * m.h) throw new Error(`layer size mismatch (${m.w}×${m.h}, ${m.lower ? m.lower.length : 'none'})`);
    const cs = ldb[m.chipsetId] || { name: '', lower: null, upper: null };

    // tilemap: rows of cells; upper cells get a trailing 1 when above-hero.
    const lower = [], upper = [];
    for (let y = 0; y < m.h; y++) {
      const lrow = [], urow = [];
      for (let x = 0; x < m.w; x++) {
        const li = m.lower[y * m.w + x], ui = m.upper ? m.upper[y * m.w + x] : 0;
        lrow.push(lowerCell(li));
        const uc = upperCell(ui);
        if (uc && upperAbove(ui, cs)) uc.push(1);
        urow.push(uc);
      }
      lower.push(lrow); upper.push(urow);
    }

    // collision: string rows of 0/1 at the 16px grid
    const grid = [];
    for (let y = 0; y < m.h; y++) {
      let row = '';
      for (let x = 0; x < m.w; x++) {
        row += cellWalkable(m.lower[y * m.w + x], m.upper ? m.upper[y * m.w + x] : 0, cs) ? '1' : '0';
      }
      grid.push(row);
    }
    // A below-hero tile-graphic event overrides the tile's passability with its
    // own tile's — how the game lays walkable doors over solid walls.
    for (const ev of m.events) {
      if (!ev.tile || ev.tile.above) continue;
      if (ev.y >= m.h || ev.x >= m.w || !cs.upper) continue;
      const ubits = cs.upper[ev.tile.idx] ?? 0x0f;
      grid[ev.y] = grid[ev.y].slice(0, ev.x) + ((ubits & 0x0f) !== 0 ? '1' : '0') + grid[ev.y].slice(ev.x + 1);
    }

    // pins: every event; doors carry their Transfer Player destination
    const pins = m.events.map(ev => ({
      id: ev.id, name: ev.name, x: ev.x, y: ev.y,
      door: ev.doors.length ? { map: ev.doors[0].map, x: ev.doors[0].x, y: ev.doors[0].y } : null,
    }));

    const nativeChip = chipFiles.find(f => f.replace(/\.png$/i, '').toLowerCase() === (cs.name || '').toLowerCase()) || null;
    // Static scenery from tile-graphic events (ladders, doors, signs): the
    // upper-tile source rect at the event's cell. Visual only — no behavior.
    const evTiles = [];
    // Conditioned scenery: tile graphics on pages gated by a switch/item/var —
    // hidden by default (a first visit's view), toggleable live by the GM.
    const evCond = [];
    for (const ev of m.events) {
      if (ev.tile) {
        const cell = upperCell(10000 + ev.tile.idx);
        if (cell) {
          if (ev.tile.above) cell.push(1);
          evTiles.push({ x: ev.x, y: ev.y, c: cell });
        }
      }
      for (const ct of ev.condTiles || []) {
        const cell = upperCell(10000 + ct.idx);
        if (!cell) continue;
        if (ct.above) cell.push(1);
        evCond.push({ x: ev.x, y: ev.y, c: cell, cond: condLabel(ct.cond) });
      }
    }

    const dir = path.join(OUT, mapKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'tilemap.json'), JSON.stringify({
      w: m.w, h: m.h, tile: 16, lower, upper, ev: evTiles,
      evc: evCond.length ? evCond : undefined,           // conditioned scenery, GM-toggled
      pano: m.panoFlag && m.pano ? m.pano : null,       // panorama shows through keyed-transparent cells
    }));
    writeFileSync(path.join(dir, 'collision.json'), JSON.stringify({ width: m.w, height: m.h, grid }));
    writeFileSync(path.join(dir, 'pins.json'), JSON.stringify(pins));

    index.maps[mapKey] = {
      id: mapId,
      name: englishName(lmt.names[mapId] || mapKey),
      nameFr: (lmt.names[mapId] && englishName(lmt.names[mapId]) !== lmt.names[mapId]) ? lmt.names[mapId] : undefined,
      parent: lmt.parents[mapId] || 0,
      w: m.w, h: m.h,
      chipset: nativeChip,
      doorsTo: [...new Set(m.events.flatMap(ev => ev.doors.map(d => `Map${String(d.map).padStart(4, '0')}`)))],
      pinCount: pins.length,
      doorCount: pins.filter(p => p.door).length,
      pano: m.panoFlag && m.pano ? m.pano : null,
    };
    done++;
  } catch (err) {
    failed++;
    console.log(`SKIP ${mapKey}: ${err.message}`);
  }
}

if (!only) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'rooms-index.json'), JSON.stringify(index, null, 0));
}
console.log(`converted ${done} maps, skipped ${failed}${only ? ` (only ${only})` : ''}`);
