# OFF TTRPG — Build 1

The first production build: server, six player clients, and the GM console, implementing the
System Document, the build spec's engine addenda, the data files, and the item catalog's
effect column — and nothing else. The enforcement boundary was treated as law: income bands,
stock checklists, per-leg quantities, and rest placement are nowhere in this code.

## Running it

```bash
cd off-ttrpg-repo/src
npm install
npm start          # http://localhost:8420
npm test           # 55 engine rule tests
```

Open the URL: the lobby offers six player seats and the Judge's seat (GM console).
Reconnection is seat-exact — a refreshed browser rejoins with gauge, statuses, and
pending menus intact. A second connection to the same seat takes it over.

### Railway hosting

The repo root carries `package.json` + `railway.json` for one-click deploy. The server
binds `0.0.0.0:$PORT`, sends WebSocket heartbeats every 30 s, and persists campaign
state to `RAILWAY_VOLUME_MOUNT_PATH` (mount a volume or state resets on redeploy;
`DATA_DIR` also works). Set `ACCESS_KEY` to require `?key=...` on the public URL —
left unset, seats are open, as at a private table.

## What is in build 1

**Engine (server-authoritative, seven seats).** The gauge loop (40/AGI, 1.0 s floor,
hold-at-full), crits rolled at fill and held visibly, the four buttons, the full damage
formula with the element ring, per-target AoE accuracy, miss-spends-CP,
validate-target-before-initiate (a dead target refuses the click — no resolve-then-undo),
Defend +25 until next fill, all nine statuses with escalation cure checks and the
8th-turn auto-clear, one-instance rules, Up/Down cancellation, element changes with
native-cancellation, all six class kits as data rows with every passive, items as a turn,
enemy AI (uniform random over legal moves, no weights), GM piloting with scripted-behavior
prompts (auto-fire for AI only), waves, the enemy shared pool (Ursa Shot steals from it),
per-instance drops, victory toast, party-wipe freeze-and-nothing, reveal gating
(element/stats/HP hidden until Wide Angle or an Eye, party-wide, per encounter),
pause-everything, and Poisoned's 1/10 tick per GM location transition.

**Equipment.** The five-slot model from `off-gear-tables.json`, additive on top of the
level tables, slot-first picker (only legal items appear; shared-pool items worn by
someone else grey out with the wearer's name), server category/class validation as the
silent backstop, and the full active-effects vocabulary: crit_immune, status_immune,
res_vs, cp_cost_mult, overworld_tick_immune, attack_element (incl. Perfect Symbol's
best-multiplier rule), Ashley Bat's double hit and cannot-miss.

**Player client.** The combat mockup's shell and behaviors: zone bar, shared-inventory
column wired to Objects, action stack with the crit fire, competence drawer with
affordability, MISS floats vs. unresponsive dead targets, two icon vocabularies,
party strip with held-gauge blink and red crit gauge, the ten canon JPGs as battle
backdrops with chrome themed from `off-palettes.json`, the overworld (room-kit renderer,
per-player camera, grid movement, examine/sign/switch/keypad/dock/pickup, vehicle
walkability inversion), the shop (greyscale + yellow, ribbons, bubble, price slip,
half-price selling), the character sheet with the soul block, and the lobby sparkle field.

**GM console.** Location (rooms, teleports = poison ticks, palette/music per room, clone),
Enemies (bestiary library → template editor with tiers/moves/element, campaign overlay —
the data file is never touched — clone-anything), Encounter (waves with spawn triggers,
slots, GM/AI flags, per-instance overrides, drops, per-enemy ITEMS feeding the shared
pool, backdrop/palette/music, save/launch), Items (grant/deduct/set, credits, gear grants, the one-press wipe
toll), Players (the universal override: HP/CP/level/status/stat-change/element/down/class),
Shop stock gate (ON/OFF + price per item; players see only what's on), Jukebox and
Stingers tabs, Cutscene tab with the intro's conductor (choice matrix, never-locked
Continue, per-player override), System (snapshots incl. auto-before-boss, single-step
undo of hand-edits, combat log export as JSON/TXT, data-reload diff, new campaign).

**The intro.** `server/data/intro-scene.json` is the v3 script as authored scene data:
text beats, the six choice gates, hover micro-lines (private per player), the stat and
competence ceremonies, the Mercy→Justice branch, the final question's reactions, and the
sparkle protocol. Desire/Fear/Virtue/final feeling are recorded to the character sheet,
mechanically inert. The scene machine (beats, gates, branches, effects: static/inversion/
whiteout as scene components) is generic — new scenes are JSON files, no code.

**Assets are hot folders.** Filename is display name. `Common Specter.png` ↔
"Common Spectre" is bridged by normalization (case, digits, the spectre/specter spelling);
anything unmatched renders as a named grey silhouette and never blocks. Fonts per
`assets/fonts/Readme.txt`: off-game-font for headers/titles in caps, 7-12 serif for body.

## Where things live

```
server/engine/    formulas.js · members.js · battle.js — the rules, tested
server/data/      transcription tables (see below) + the intro scene
server/           dataload · state/persistence · scenes · server (HTTP+WS)
client/           index (seats) · player.* · gm.* · common.* · roomkit.js
tests/            55 rule tests, each named for the doc sentence it locks
```

The three transcription tables are the only place doc prose was converted to data, each
with source notes: `comp-riders.json` (Part 4 effect semantics), `items.json` (the
catalog's effect column + orbs from economy Part 5), `enemy-scripts.json` (the full bestiary's move
effects, scripted triggers, rotations, passives, and compound-fight unit templates). Loading fails loud if a competence lacks a classification.

## GM rulings received and implemented (session 2)

1. **All documented statuses are built**: Thorns (10% max HP on acting, 2 turns —
   consumed turns are not acting), Famine (2/25 max HP per turn on its own clock),
   Impure (rides the element-change machinery: weak to a random ring element, 2 turns,
   one-instance and native-cancellation apply), Vilified (= Muted), Corrupted (Cob's
   variant: competences AND items locked), and Defamed (guaranteed charged crits for 3
   turns; everything produced — damage, healing, buffs — reflects onto the holder's
   whole party at the fade; curing it early, e.g. Focus, prevents the reflection).
2. **Enemy damage carries ±10% variance** (ruled), applied to every dpa-scaled hit and
   scripted blast.
3. **Inspiration/Expiration are 100% accuracy** (ruled — confirmed as built).
4. **Enemy CP is unlimited** (ruled — confirmed as built; per-instance override remains).
5. **Cutpurse steals from the encounter's enemy object pool** (ruled). Note: this
   supersedes the build spec sentence "Cutpurse draws from the zone drop table, not the
   pool" — implemented as ruled. Enemies can now carry items per instance (the ITEMS
   field in the Encounter builder, next to slot/control/drop/overrides); carried items
   enter the shared pool at spawn, where Ursa Shot steals mid-fight and Cutpurse takes
   its bonus drop on a Bandit kill. Stocking enemies IS the steal table.

### Interpretations inside those rulings, flagged

- **Defamed's reflection** deals the accumulated damage to *each* living party member
  (per the bestiary's "deals ~350-450 to each party member"), as elementless direct
  damage; Sacred Mission still answers it. Buffs re-apply under normal one-instance rules.
- **Famine does not tick on overworld transitions** — the spec's "Poisoned is the only
  status that acts in the overworld" stands. Say the word if double-tick should travel.
- **Impure re-rolling the weakness the target already has** fizzles (one-instance:
  reapplying an existing state does nothing).

## Standing rulings from build 1 (unchanged)

1. **Speckter-mite**: moves data (MP 0.5 ×2 ≈ dpa per action) wins over the "~7 each" prose.
2. **Tiburce**: uniform-random AI makes the drain 1/2, not the prose's ~1/3.
3. **Closed Bracket** target: one enemy, per the Bracket ladder.
4. **Scripted triggers consume the turn** (a summon or Half Past is that action).
5. **Enemy statuses vs. players** roll at Neutral (80) − RES per the worksheet.
6. **Enemy charged crits** show on the GM console only (a presentation dial).
7. **Light Fingers** is inactive while the Bandit is down.
8. **Taunted** restricts single-target actions to the applier; AoE stays legal.
9. **Asleep** counts from landing: 1st fill acts, every 2nd is consumed.
10. **Manual waves** hold the fight open — victory doesn't fire itself.
11. **Duplicate classes** are legal via the intro.

## The full bestiary is now transcribed

`enemy-scripts.json` covers every zone: move effects (multi-status riders, CP drains,
multi-hits, lifesteal, current-HP% strikes, DEF-ignoring hits, forced/random/best-vs-
target attack elements, ally heals/buffs/Hasty grants), scripted triggers (thresholds,
turn schedules, every-N-seconds cycles, telegraphs, summons with shell-game fakes,
self-destructs, flee, form transitions, Cob's watch/judgment cycle, the survivor's
Double Attack), Japhet's canonical form rotations, template passives (Source's
per-action regen, the Batter's Purification and Sacred Mission mirrors, Add-On Alpha's
Chain Mastery), and unit templates for the compound fights (Psalmanazar, Herodotus,
Gnosticus, Sugar, Dummy, the Pastel-burnt body and heads) — all queueable in the
Encounter builder.

**The only things left GM-run, by design** (flagged in the file's meta):

- **Carnival's four Games and the bidirectional prize-tempo system** — Game transitions
  announce at 75/50/25% and every move resolves, but the per-Game move pools and the
  "either side meets the condition → +50% gauge" economy are yours to run (pilot him).
- **Pastel-burnt's assembly** — the ~18 s sequential head spawns and kill-heads-kills-body
  win call are yours from the unit templates (manual waves + END ENCOUNTER).
- Three data notes honored as written: Gilles de Rais's optional 2008 trait (dropped per
  its own "drop if schema purity wins"), Enoch's below-60% Double Attack frequency
  (conflicts with uniform-random AI — pilot him for the canon cadence), Ballman's
  set-piece minigame (a GM call per canon).

## Known gaps (next builds)

- **Tiled import** for image backdrops: image rooms work (`backdrop: "image"`), the
  importer doesn't exist yet.
- **Sprite-sheet sidecars**: the renderer assumes single-character 3×4 sheets (which all
  current art is); the tester's multi-character grid convention isn't wired in yet.
- Combat-log auto-analysis against the playtest targets (fight lengths, heal shares) —
  the logs export now; the arithmetic is yours or a later build's.

## Playtest hooks (from the spec's priorities)

Fight lengths, damage, misses, statuses, items, and deaths all land in per-encounter logs
(System tab → JSON/TXT). Watch: Epsilon's 8 s felt pacing, fodder at 30–40 s and Dedan at
3–4 minutes, Purifier heals vs. Fortune Tickets, and mid-fight reconnection (pull a
player's cable during the Dedan race — the seat comes back exact).
