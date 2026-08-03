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
npm test           # 37 engine rule tests
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
slots, GM/AI flags, per-instance overrides, drops, pool, Cutpurse table, backdrop/palette/
music, save/launch), Items (grant/deduct/set, credits, gear grants, the one-press wipe
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
tests/            37 rule tests, each named for the doc sentence it locks
```

The three transcription tables are the only place doc prose was converted to data, each
with source notes: `comp-riders.json` (Part 4 effect semantics), `items.json` (the
catalog's effect column + orbs from economy Part 5), `enemy-scripts.json` (Zone 1 move
effects and scripted triggers). Loading fails loud if a competence lacks a classification.

## Rulings I had to make — flagged for the GM, not silently resolved

1. **Enemy damage variance**: the bestiary carries none, so enemy hits are deterministic
   `dmg_per_action × MP`. If you want the worksheet's "~13–17" feel, say the word and
   variance becomes a data field.
2. **Speckter-mite**: moves data says MP 0.5 ×2 hits (≈ dpa 7 per action); the special
   prose says "~7 each" (≈ 14 per action). The moves data wins here — flag if wrong.
3. **Tiburce**: the special says drain "on ~1/3 of actions", but the AI rule is uniform
   over legal moves, which makes it 1/2 (two moves). The rule wins.
4. **Closed Bracket** carries `target: null` in the kits JSON; implemented as one enemy
   per the Bracket ladder.
5. **Inspiration/Expiration accuracy** is stated nowhere; implemented cannot-miss, and
   charged crits apply (they deal damage).
6. **Enemy CP** isn't in the bestiary rows; pools default unlimited ("bookkeeping, not
   economy"), overridable per instance in the Encounter builder.
7. **Scripted triggers consume the turn** (a summon or Half Past is that action).
8. **Enemy statuses vs. players** roll at Neutral (80) − RES, per the worksheet's Dedan
   examples, unless a move ever specifies otherwise.
9. **Enemy charged crits** show on the GM console only — the doc calls visibility a
   presentation choice; hiding them from players keeps enemy turns threatening. A dial.
10. **Light Fingers** is inactive while the Bandit is down.
11. **Cutpurse** draws from a GM-stocked zone/encounter drop table (drop decisions are
    GM-side); an empty table means no bonus drop until you stock it.
12. **Taunted** restricts single-target actions to the applier; AoE and untargeted
    actions stay legal (the status names "target").
13. **Asleep** counts from landing: 1st fill acts, every 2nd fill is consumed.
14. **Manual waves**: if all spawned enemies die and only manual-trigger waves remain,
    the fight holds open for your spawn or END ENCOUNTER — victory doesn't fire itself.
15. **Duplicate classes** are legal via the intro (the engine doesn't restrict; the
    four-test comp screen is yours).

## Known gaps (next builds)

- **Endgame statuses** (Thorns, Famine, Impure, Vilified, Defamed) are not yet coded —
  Zone 1 needs none of them; they ride existing machinery when Zone 3+/Room content is next.
- **Zone 2+ enemy specials** beyond plain damage/status/drain resolve via the generic
  machinery where the fx strings parse; anything untranscribed surfaces to the GM as a
  prompt ("resolve by hand") rather than being half-built. Transcribing Zones 2–4 into
  `enemy-scripts.json` is data work, not code work.
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
