# OFF TTRPG — Build Specification

The consolidation document. Everything designed across the system, bestiary, economy, and UI work, organized as the handoff for building the actual client. Read this first; everything else is a component it points into.

**THE ENFORCEMENT BOUNDARY (read before implementing anything).** The engine implements only: the System Document's mechanics, this spec's §2–§3, the bestiary JSON, and the item catalog's effect column. The economy document (except that catalog), all income templates, stock checklists, per-leg quantities, rest-zone placement guidance, and anything phrased as a band, template, or suggestion is **GM reference material — never code**. This campaign's design principle is a hard split: the engine enforces physics (damage, gauges, statuses, item effects); the GM administers everything with judgment in it (income, drops beyond queued assignments, penalties, pacing, mercy). When a sentence in any document is ambiguous about which side it lives on, it is GM-side. The governing philosophy, binding on every screen: **a game for the players, an unrestricted creation engine for the GM** — player-side interfaces enforce rules and filter to legality; GM-side interfaces organize and suggest but never restrict, and no console feature may tell the GM "you can't."

## 1. The document stack

| Artifact | Role |
|---|---|
| **System Document** (yours) | The engine: stats, damage, gauge, elements, statuses, classes, pricing, Part 5 schema. Canonical rules. |
| **off-restat-worksheet.md** | The enemy conversion procedure and calibration examples. Methodology reference; superseded numerically by the bestiary. |
| **off-canon-bestiary.json** | Raw merged canon (2008 + remaster + remake), per-field source tags. The audit trail. |
| **off-campaign-bestiary.json** | **The enemy database.** 59 entries, schema v2: element, HP (units[] for compound fights), DEF/RES/LCK, gauge (phases where needed), status tiers, structured moves[]. Software-ready; loads directly into the GM console's Enemies panel. |
| **off-economy.md** | Items, equipment, orbs, income, prices, Zacharie stock, Bandit EV, rest-zone placement. The attrition spine: 7–8 fights per leg, one leg per session. |
| **off-ui-combat-mockup.html** | Player client: shell (zone bar / inventory column / play viewport), battle screen, full interaction contract demonstrated. |
| **off-ui-gm-console.html** | GM seat: Location/Enemies/Encounter/Items/Players panels, CREATE/PARTY column, enemy party strip, staging, pause. |
| **off-ui-shop-mockup.html** | Zacharie's shop, greyscale with yellow, Buy/Sell/Leave, bubble-as-description. Renders in the player viewport. |

The mockups are living specs: their behaviors are requirements, their code is disposable.

## 2. Engine addenda

Rules created during encounter and UI design that are now canon and must be treated as part of the System Document:

**Enemy AGI is deleted.** Enemy blocks carry `gauge_s` directly (and `gauge_phases` for form fights). Enemy accuracy is hand-set per move. Both per the worksheet.

**The enemy shared object pool.** The GM's creatures share one item pool per encounter, mirroring the party inventory rule exactly: any creature may spend its turn using a pool item. The pool is set in the Encounter builder and is **distinct from drops**, which are curated per enemy instance. **Ursa Shot steals from the pool** — stocking the pool is setting the fight's steal table. Cutpurse draws from the zone drop table, not the pool.

**Waves.** Encounters queue in waves; a wave spawns at launch, on the previous wave's death, or on manual GM trigger. Queued instances carry: GM/AI control flag, drop assignment, and optional per-instance overrides (template untouched — the modified copy exists only in that encounter).

**GM/AI control.** Each enemy instance is either GM-piloted (GM receives its action stack on gauge fill, mirroring the player interface) or AI-run (engine picks **uniformly at random from currently legal moves** — no weight system; the GM's override is flipping the instance to GM control). The flag is per instance and can be flipped mid-fight. **Scripted behaviors in the bestiary (phase triggers, threshold casts, summon schedules, timed cycles) auto-fire for AI-controlled instances only.** For GM-piloted instances they surface as prompts — "Dedan at 40% — Half Past?" — and never act uninvoked. A scripted line in an enemy record is a stage direction, not a mandate, whenever the GM holds the instance.

**Staged rooms.** Locations persist a saved layout of placed pieces. Placement is silent. Any piece can be flagged hidden (invisible on player clients, marked on the GM's); toggling visibility is the GM's reveal action. Teleporting the party to a location loads its saved room.

**Progression is deterministic — no per-level variance.** The system doc writes checkpoint stats (levels 1/5/10/15/20); every level between them is **linear interpolation, rounded**, with checkpoints exact and AGI stepping at its doc-defined milestone levels (5, 9, 13, 17, 20) rather than lerping. Full generated tables, all eight stats: **off-level-tables.json**, extracted verbatim from the system doc. Player competence kits are likewise data, not prose: **off-class-kits.json** carries all six classes' competences in the Part 5 schema (58 rows plus passives), with class base accuracy (100 minus level-1 AGI, held constant: Epsilon 95 / Omega 94 / Burnt 93 / Alpha 91 / Purifier 90 / Bandit 87) in its meta. The engine reads kits and levels from these two files; the docx remains the authority on effect semantics. Quality-of-life build requirements live in **off-qol.md** — hot-folder assets with never-blocking placeholders, session snapshots (auto before bosses), single-step GM-edit undo, clone-anything authoring, GM notes, refresh-proof player reconnection, data-reload diffs, and combat log export. All engine/console work; none of it may alter game rules. Equipment is data too: **off-gear-tables.json** — the canon five-slot model (offensive / defensive 1-3 / special) with class locks on offensive and defensive-2 only; Auras, Colours, and Days are universal single-copy pools, Symbols and Epidermides are shared single-copy pools across the three ring-bearers (allocation is their difficulty; exploration is the Purifier's, Bandit's, and Burnt's), stats derived from the economy doc's 15% gear-share rule split across slots. The equip screen is SLOT-FIRST: pick a slot, see only its legal items (shared-pool items worn by someone else show greyed with the wearer's name) — illegal equips are unrepresentable in the UI, with server-side category-slot validation as the silent backstop. ENGINE MODEL, per GM ruling: GEAR IS ADDITIVE. The level tables are the true base stats and equipment stacks on top; a geared party runs above the printed curve, and any resulting rebalancing is GM-side (waves, templates, dials) — never a reduction of player stats. Playtest note: bestiary numbers assume table-value parties, so watch fight lengths at full gear. This ratifies the rule the bestiary derivation already used for in-between anchor levels — every enemy was tuned against these exact interpolated values, which is also why there is no random variance and no point-buy: any deviation desyncs a player from every derived number in the campaign.

**Leveling is milestone-only.** The GM grants levels at story points matching the zone anchor levels (Zone 1 = 1–5 through the Room and endgame = 16–20). Canon EXP values in drop data are flavor, never counted — every enemy in the bestiary was derived from the anchor assumption, and milestone leveling converts that assumption into a guarantee. Farming yields credits and items, never levels.

**There is no fleeing.** Combat has four buttons and no exit: entering a fight is a commitment. Fight avoidance is overworld play — reading staged warnings, routing around trigger zones, choosing not to open the door. Obligation on the GM: encounter entries must be legible commitments (telegraphed zones, narrated danger), never gotchas, because the players have no escape hatch.

**Vehicle state (the pedalo).** A player token in a vehicle inverts terrain walkability: water becomes walkable, land does not, boarding/exiting happens at GM-placed dock pieces. One flag on the token; covers Zone 1 sea travel and anything similar.

**Absent players.** The GM pilots the absent character or the seat sits out for the session (that class's counters simply go untested that week). Party composition rulings from the design discussion apply: any comp is legal subject to the four-test screen (element spread, striker floor ≥2.5, no effect-class tripled, speed skew re-derivation).

**Party wipe.** The engine's only job: detect all six down, freeze combat, announce defeat. Everything after is the GM's sequence, by design: trigger the death cutscene (an authored Cutscene-tab scene), teleport via the Location panel to the zone's beginning, and apply the toll by hand — **50% of credits and 50% of each consumable stack** (equipment, orbs, and key items survive). Implementation requirement this creates: **the Items panel needs deduct and set controls, not just grants** (a one-press "halve credits & consumables" convenience button is welcome; automation of the sequence is not). No game over, no reload — the world took its toll, administered by its keeper.

**Status persistence.** Statuses, stat changes, and element changes persist outside combat until cured, until a rest zone, or until the cure-check machinery resumes in the next fight (carried statuses enter the next battle already applied, rolling their per-turn checks as normal). Poisoned is the only status that acts in the overworld: **1/10 max HP per location transition** until cured — and it kills, per canon. All transitions are GM Location-panel actions (there is no other kind), so one click is one tick regardless of distance jumped — fast travel is naturally gentler — and the GM's override for anything, including stripping the poison itself, is the Players panel. Everything else just means walking into the next fight already wounded in kind.

**Victory.** On the last enemy's death: drops and credits enter the shared inventory automatically and a three-second "You got: [list]" toast plays. No results screen, no bookkeeping.

**Item use is a turn, full stop.** Using an Object in battle resets the user's gauge to zero like any other action. Out of combat, anything in the shared inventory can be used freely by anyone.

**Inventory is uncapped** — including Abaddon's Meat: supply control is the GM's drop decisions, not a system cap. Selling is at **half price**. **Equipment swaps out of combat only.** **Milestone level grants heal to the new maximums.** Starting loadout is not a system default: the GM stocks the party manually at session zero via the Items panel.

**Formations.** The battle screen has fixed sprite slots: **six party slots** on the right in the Batter-and-rings arrangement (one forward anchor, the rest orbiting), and **eight enemy slots** on the left in two loose rows. Party slot assignment is **randomized per encounter** — who stands where is fresh every fight. Enemy slot assignment is **GM-set in the Encounter builder** per queued instance; waves inherit their assigned slots on spawn, and slot markers render on the GM's field only. Slots are presentation, not mechanics — position carries no rules weight.

**Reveal gating.** Player clients render an enemy as sprite, name, and its visible effects only — active statuses and stat changes, which are public because the party watched them land. Element, stats, HP, and tiers are hidden until **Wide Angle or an Eye reveals that instance**; a reveal is party-wide and lasts the encounter. The GM sees everything always. This is why Wide Angle costs 2 CP and why the Eye exists in the shop — identification is a purchase, and the UI must never give it away.

**Pause.** The GM can freeze time globally: every gauge on every client stops, a PAUSED state renders everywhere. For narration, phase transitions, and stepping away. No game state advances while paused; talking was always free — pause makes deliberation free too.

**Statuses added by the endgame** (enemy-only, riding existing status machinery): Thorns (10% max HP on acting, 2 turns), Famine (double-tick Poison), Impure (weak to a random element, 2 turns; one-instance and native-cancellation rules apply), Vilified (= Muted; Cob's Corrupted variant also locks items), Defamed (the crit gift: 3 turns of guaranteed charged crits, then all output produced reflects onto the whole party; curable by Focus).

**Remake status vocabulary map** (for reading canon sources): Lethargic=Blinded, Frail=DEF Down, Sturdy=DEF Up, Confused=Madness (GM ruling), Impure=as above.

## 3. Architecture

Server-authoritative real-time state; seven seats (six players + GM). The server owns gauges, resolution, and legality; clients render and request.

Core state objects: `party[6]` (stats, statuses with per-status escalation counters, stat changes with timers, element changes, gauge, held-crit flag), `enemyTeam` (instances from bestiary rows + overrides, control flags, shared pool), `partyInventory` + credits (shared), `rooms{location: pieces[]}`, `encounterQueue` (waves), `clock` (paused flag).

Resolution rules the server enforces, from the System Document verbatim: gauge holds at full; crit rolled at gauge-fill start and flagged visibly; **validate-target-before-initiate** (a dead target refuses input — never resolve-then-undo); a miss spends CP and resets the gauge; AoE rolls accuracy per living target; Defend expires on the defender's next gauge fill; status durations count the afflicted's own turns; one-instance and Up/Down cancellation on contact; Madness auto-resolves at fill; Taunted dies with its applier.

**Persistence:** all campaign state — rooms and staged pieces, party inventory and credits, levels, encounter queues, reveal flags — persists server-side across sessions. The mockups are in-memory; the build is not.

Latency note: the refused-click rule is why the server validates and the client renders greyed-out dead targets from server state — a click racing a death must land as a refusal, not a rollback. This is the one place netcode design touches game feel directly.

## 4. Data layer

`off-campaign-bestiary.json` is the enemy table: load it, render the Enemies panel from it, instantiate encounters from it. Its meta carries the party DPS/heal tables (1–20) used to derive every number — keep them beside the GM as tuning context. One field is deliberately unfinished: **per-move ATK/ESP splits are hand-tuned in software** against each entry's `dmg_per_action` target; the moves[] carry MP multipliers and accuracy, which is everything except the split.

Player classes come from the System Document's tables as-is. Economy tables from off-economy.md: item catalog (with the Joker at 35% overriding canon), per-zone prices and income, Zacharie stock lists, equipment tiers (gear share is inside the printed checkpoints — a character without current-tier gear is below curve), orb caps.

## 5. UI

Built and specified: the player shell (zone bar, shared-inventory column wired to the Objects action, battle viewport), the battle screen (gauge hold + pulse, crit as fire on the armed menu and red gauge in the strip, MISS as event, dead-target refusal, icon rows for statuses/stat changes in two visual vocabularies, competence drawer with affordability), the GM console (five panels, CREATE/PARTY column, enemy party strip with red gauges, enemy action stacks, pool, staging, pause; the Players panel is **full member editing** — HP, CP, and adding or stripping any status or stat change, the GM's universal override), and the shop (greyscale + yellow, ribbons, bubble-as-description, price slip, half-price selling, and a GM stock gate: before the shop opens to players, the GM sees the full catalog with per-item ON/OFF toggles — players see only what's on; selling is unaffected, Zacharie buys anything).

Visual language: flat zone-color field per zone (Z1 blue / Z2 ochre / Z3 green / Room red), monochrome outlined sprites, damask motifs, slanted black boxes, Jersey-10-class pixel display type, amber selection, red reserved for crits/death/GM-side, shop outside the palette entirely. No rules prose in play surfaces — data only.

Presentation systems, per GM rulings from the campaign sweep:

**No dialogue box.** The GM narrates and voice-acts; overworld dialogue is a person, not a panel — the same "GM is the event system" principle that cut puzzle physics and darkness mechanics. The shop's coded bubble is the exception, not the pattern.

**Jukebox.** One uploaded music library, organized by zone (no type sorting, no sourcing tiers). Room and encounter creation assign a track that autoplays and loops on entry/launch. A **Jukebox tab** in the GM console shows the current track and a queue with skip/previous; a separate **Stingers tab** is the one-shot sound board.

**Cutscene tab.** Not an effects panel: a library of **pre-coded scenes** the GM authors ahead of time (sequenced effects — static, inversion, whiteout, timing — as components of a scene, never standalone buttons) and triggers by name on all clients. The ending is a cutscene; so is anything else that deserves more than narration.

**Palettes: the ten canon battle backgrounds** (Black, Blue, Green, Lime, Orange, Pink, Purple, Red, Yellow, and White = purified), selectable per room and per encounter in all zones — no fixed zone-to-color mapping. The source images render directly as battle backdrops (the damask is no longer drawn procedurally on battle screens); UI chrome themes from the sampled values in **off-palettes.json** (base / tint / pale per palette). The overworld room renderer keys its floor/wall colors from the same file.

Remaining screens, in build order of need: exploration mode in the player viewport (the staged-room renderer — players see placed visible pieces, click pickups); rest zone (full restore + shop entry + the session-boundary beat); Wide Angle / Eye reveal card (per-enemy: stats, element, tiers — GM-gated); character sheet and level-up; death and ending screens. All follow the established language; none need new design decisions.

Art is the honest open item: every sprite is a glyph placeholder. Canon sprites are copyrighted — the build needs original art in the monochrome style, which is the single largest non-code cost in the project.

## 5b. The overworld

A room is three layers: **backdrop + collision + staged pieces** — and the primary backdrop source is **procedural**: rooms are JSON (floor rects with a pattern, wall rects, prop placements) rendered by a ~20-prop drawing kit in the client (proof: off-room-renderer.html). OFF's visual language — flat two-tone fills, black outlines, orthogonal geometry, repeating floor patterns, a small prop vocabulary — makes this near-lossless. Procedural rooms mean collision derives automatically from walls and solid props, zone-palette reskinning is free, room data is tiny and console-editable, and the room art is original (deleting the copyright flag for the overworld layer). Image backdrops (screenshots or Tiled compositions) remain a supported fallback for complex setpieces the prop kit can't express — the engine treats backdrop:'procedural'|'image' per room. Canon maps were sized for one sprite; rooms are composed wide enough for six independently-moving players. Rooms are authored one leg ahead of the party, never in bulk.

**The room kit (what the CREATE/BUILD tab offers).** Three layers, all extendable (a new pattern or prop is a ~10-line drawing function; the builder lists whatever the kit contains — reference implementation: off-room-renderer.html). **Ground patterns**, each carrying a walkable flag: plain, brackets, carpet, path, grass, metal plate, tracks (walkable); water (animated) and void (unwalkable). **Structures** — unwalkable footprints drawn as faces, placed ON ground, never enclosing it: wall (interiors), building (facade with roofline; doors and windows stamp onto it), fence, ledge. **Prop stamps**: crate, barrel, cabinet, bottles, counter, rug, door, window, plant, smokestack (animated smoke), lamppost, sign, bed, shelf, vat, dock, rock — plus the interaction props (sign/switch/keypad) and pickups from the staging column. **Outdoor philosophy:** exteriors have no walls — the room bounds clamp movement and footprints block it; a street is an open ground plane with buildings placed on it. Interiors are separate rooms: a building's door is an examine target, and entering is the GM clicking the interior in the Location panel, exactly canon's screen-transition grammar.

**Movement:** grid-snapped to the backdrop's tile size, four directions, all six players moving freely and independently within a room. **Rooms may exceed the viewport** (long exteriors, causeways): each player's client cameras on their own sprite, clamped to room bounds, so the party can physically spread out; the GM camera free-scrolls with jump-to-player. **Floor patterns carry a walkable flag** — water, chasms, and other terrain block movement without wall rects, and animated patterns (water shimmer) run on a two-frame clock like the crit fire. **Transitions are GM-authority**: door pieces ping the GM on contact; only the Location panel moves the party. **Interaction:** the core verb is *examine* — clicking an adjacent piece announces it to all screens, and the GM answers by voice. Three prop behaviors cover the rest: sign/note (displays staged text), switch (visible state, consequences by voice), keypad (staged code; attempts ping the GM privately, examines announce publicly). Block puzzles and anything bespoke are the GM moving pieces by hand — the GM is the event system. **Encounter triggers** are manual LAUNCH by default, with optional painted trigger zones for unauthored-feeling ambushes. **Sprites:** character and enemy sprites with walk animations are GM-provided assets; the room kit covers everything else. Glyph placeholders serve until art exists.

Copyright posture: for the private table, screenshots and tileset compositions are practically equivalent; the public-release art flag in §8 applies to both identically.

## 6. Build order

Extends the System Document's Part 5, now with the UI layer sequenced: (1) server gauge loop + four buttons + party state, (2) damage formula with elements and gauge-fill crits, (3) statuses keyed to target gauge fills, escalation counters, stat-change timers, (4) competences and enemies as data rows from the bestiary JSON, (5) objects, shared pools, drops, credits, (6) the GM seat: encounter queue, waves, control flags, instance overrides, pause, (7) staging: rooms as backdrop+collision+pieces, Tiled import, hidden pieces, location switching, exploration movement and examine, (8) shop and rest zones off the economy tables, (9) polish: announcements, floats, reveal gating, sound.

A playable vertical slice exists at the end of step 5 with a hotseat GM; steps 6–7 make it a campaign tool.

## 7. Playtest plan

Session one is Zone 1, leg one, exactly as statted. Watch, in priority order: the slow-seat experience (Epsilon and Omega players' felt pacing at 6–8 s gauges — the one thing no formula answered); real fight lengths against the 30–40 s target (recalibrates all HP pools if off); whether the Purifier feels obsolete next to Fortune Tickets (pre-registered fix: Ticket to 400); Epsilon's damage share against groups of 3–4; and the attrition model's two soft assumptions (45% in-combat healing share, 30% HP buffer tolerance) — one session hardens both into facts and recalibrates the economy for Zones 2–4 automatically, since everything derives from the same throughput model.

Later, dedicated watch items already flagged in the bestiary: Vela Shot with crit-hits-everyone as the burst outlier, Blinded's uneven bite on the Bandit, the Dedan post-40% race length, and — much later — whether the Defamed crit gift's table psychology plays as designed.

## 8. Open items

Original art (sprites, Zacharie, bosses) — largest cost, no design blocker. Netcode for the real-time gauge (see §3 latency note). Justus's canon kit is wiki-flagged incomplete; his four known mirror-competences stand, backfill freely. Per-move stat splits (§4). The three prose-only boss kits that were hand-built (Sugar, Judge, Hugo-excluded) rest on your supplied data — final authority is yours. And the remaining UI screens (§5), none of which block the vertical slice.

Everything else is sessions.
