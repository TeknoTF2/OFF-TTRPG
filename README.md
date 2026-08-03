# OFF TTRPG

A real-time, gauge-based online TTRPG faithful to OFF (Mortis Ghost, 2008 / 2025 remake), built for exactly six players and one GM, played through custom software: a player client, a GM console, and a server that holds all truth. Everything in this repository was designed turn-by-turn with the GM; nothing here is placeholder philosophy. **Read this file completely before writing any code.**

## The two laws

**1. The enforcement boundary.** The engine implements only: the System Document's mechanics (`docs/off-ttrpg-system.docx`), the build spec's engine sections, the data files in `data/`, and the item catalog's effect column in the economy doc. Everything else in the economy doc — income bands, stock checklists, per-leg quantities, rest placement — is GM reference material and must **never** be coded. When any sentence in any document is ambiguous about which side it lives on, it is GM-side.

**2. The core philosophy.** *A game for the players, an unrestricted creation engine for the GM.* Player-side interfaces enforce rules and filter to legality (a slot picker shows only legal items; a dead enemy refuses the click). GM-side interfaces organize and suggest but never restrict — every list reachable from everywhere, every value editable, and no console feature may ever tell the GM "you can't." Folder structures, categories, and templates on the GM side are presentation, not permission.

## Reading order

1. This README.
2. `docs/off-build-spec.md` — the master handoff. Its enforcement-boundary preamble and engine addenda are binding. Every GM ruling from the design process is recorded there.
3. `docs/off-ttrpg-system.docx` — the **root authority** for all mechanics: stats, damage formula, gauge, crits, elements, statuses, targeting, death, progression, competence pricing, class kits, the Part 5 schema. Where any other file disagrees with it on a mechanic, the docx wins — then flag the disagreement to the GM.
4. `data/*.json` — the executable form of the design. Load these; do not re-derive them.
5. `mockups/*.html` — **behavioral specifications.** Their code is disposable; their behavior and aesthetic are the spec.
6. `docs/off-economy.md` (GM reference + the item catalog) and `docs/off-qol.md` (build requirements).

## Authority hierarchy

System docx → build-spec rulings → data JSONs → mockup behavior → economy item catalog. `docs/off-restat-worksheet.md` and `data/reference/` are audit trail and canon source — consult them to understand *why* a number is what it is; never load them as game data. The `reference/` wiki XMLs exist so that **no canon fact is ever invented**: if you need an OFF name, item, enemy, or detail not in the data files, look it up there first, and if it isn't there, ask the GM rather than inventing.

## Directory map

```
docs/       authority + reference documents
data/       game data the engine loads (level tables, class kits, gear, bestiary, palettes)
data/reference/  canon sources + raw merged canon DB (never loaded by the engine)
mockups/    behavioral specs for every screen built so far
assets/     hot-folder asset tree (see below)
src/        your workspace — all implementation goes here
```

## Non-negotiable engine facts

These are the rules most likely to be silently violated by reasonable-looking code. Each one was established deliberately; violating any of them breaks derived math or a GM ruling.

- **Server-authoritative, seven seats** (6 players + GM). All state lives server-side; clients render and request. Player reconnection restores the seat exactly — gauge position, statuses, pending menus — and must be deliberately tested.
- **Gear is additive.** The level tables are the true base stats; equipment from `off-gear-tables.json` stacks on top, and a geared party deliberately runs above the printed curve. Do not implement any base-stat discount or "geared curve" model — one was proposed during design and explicitly rejected by the GM. Bestiary numbers were derived against table values; if geared parties trivialize fights, that is the GM's to rebalance with GM tools, not the engine's to prevent.
- **Progression is deterministic.** No variance, no point-buy, ever. Interior levels are already computed in the tables; AGI steps only at levels 5/9/13/17/20.
- **Everything is a data row.** Competences, enemy moves, items, gear: if a behavior seems to need custom code, stop and ask — the system's rule is "reprice it until it doesn't." Canon gear effects are ACTIVE, implemented strictly through the existing-machinery vocabulary in the gear file’s meta (crit/status immunities, RES bonuses, CP cost multiplier, attack-element forcing, Ashley’s double hit) — an effect the engine cannot express through that vocabulary gets flagged to the GM, never half-built.
- **Scripted enemy behaviors auto-fire for AI-controlled instances only.** For GM-piloted instances they surface as prompts ("Dedan at 40% — Half Past?") and never act uninvoked. AI = uniform random over currently legal moves; no weight system.
- **Battles start with both sides at gauge zero. There is no fleeing.** Item use costs a full turn. Crits roll at gauge fill and are held visibly. Defend is +25 DEF until next fill, restores nothing.
- **Statuses persist outside combat** until cured, rest, or next-combat cure checks; Poisoned ticks 1/10 max HP per GM location transition and can kill. All transitions are GM clicks; one click = one tick.
- **Party wipe:** engine detects, freezes, announces — and then does nothing. Cutscene, teleport, and the 50% toll are GM-administered (Items panel therefore needs deduct/set controls, not just grants).
- **Reveal gating:** players see enemy sprite, name, and visible effect icons only; element/stats/HP require Wide Angle or an Eye, party-wide, lasting the encounter. The GM sees everything always.
- **Equipment is the canon five-slot model** with slot-first pickers player-side (the slot is the menu; shared-pool items worn by someone else show greyed with the wearer's name). Symbols and Epidermides are single-copy pools shared across the three ring-bearers — allocation is their difficulty; exploration is everyone else's.
- **Pause freezes every gauge everywhere.** The ten JPGs in `assets/backdrops/` render directly as battle backdrops; UI chrome themes from `data/off-palettes.json`; any palette is assignable to any room or encounter.
- **No dialogue box.** The GM narrates by voice. The shop bubble is the coded exception. Cutscenes are pre-authored scenes triggered by name from the Cutscene tab; static/inversion/whiteout are components inside scenes, never standalone buttons.

## Asset conventions

Hot folders: anything dropped into `assets/` appears in the matching picker on refresh; filename is display name; no manifests. **Folders are menu layout, never restriction** — `music/zone2/` is a heading, not a lock. Missing art never blocks: absent sprites render as named grey silhouettes, absent tracks play silence with a greyed name. Sprite sheets follow the RPG Maker 3×4 convention with a per-file grid-parameter sidecar (see `mockups/off-sprite-tester.html`)

## Build order

From the spec, in order: (1) gauge loop and the four buttons; (2) damage formula with elements and crits; (3) statuses keyed to target gauge fills; (4) competences as data rows from `off-class-kits.json`; (5) **vertical slice: one full Zone 1 fight, six clients + GM console — stop and playtest here**; (6) Objects and inventory + shop; (7) overworld rooms, movement, camera; (8) GM console panels, staging, jukebox, cutscenes; (9) QOL requirements from `off-qol.md`. The playtest priorities at the slice: slow-seat feel (Epsilon's 8s gauge), fodder fights landing 30–40s and Dedan 3–4 minutes, Purifier healing versus Fortune Tickets, and reconnection mid-fight.

## How to work with the GM

This project's history is a record of one lesson learned repeatedly: **the design authority is the GM, and the failure mode is inventing.** Concretely: never resolve an ambiguity by adding a rule — surface it as a question with options and a canon note. Never invent a canon fact — check `data/reference/` first, then ask. Never automate something the documents assign to the GM's hand, and never restrict the GM console to "help." When the GM states something, it is a ruling: implement it as said, and if it conflicts with something existing, say so plainly *while implementing their version.* Honest pushback is welcome; silent reinterpretation is not. If you find a genuine error in the data or documents, report it with evidence from the sources rather than quietly fixing it — every number here traces to a derivation, and untraceable changes are worse than wrong ones.
