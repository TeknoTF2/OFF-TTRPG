# OFF TTRPG — Quality of Life

The parking lot for features that belong to no other document. These are **build requirements, not philosophy** — each one is engine or console work Claude Code should implement, sized small on purpose. The campaign is run by one person for six friends across months of sessions; everything here exists so session twelve feels like session two.

**The core design philosophy, stated once and binding everywhere:** this software is **a game for the players and an unrestricted creation engine for the GM.** Rules, validation, and filtered menus exist on the player side. The GM side organizes and suggests but never restricts — every list is reachable from everywhere, every value is editable, and no console feature may tell the GM "you can't."

## 1. Hot-folder assets

The asset library is a folder tree that mirrors the pickers: `assets/music/<zone>/`, `assets/stingers/`, `assets/sprites/party/`, `assets/sprites/enemies/`, `assets/sprites/npcs/`, `assets/backdrops/`, `assets/props/`. Anything dropped into a folder appears in the matching picker on refresh (a refresh button is sufficient; live file-watching is optional polish). Filename becomes display name. No manifest editing, ever.

**Folders are menu layout, never restriction.** `music/zone2/` means the track sorts under the Zone 2 heading in the picker — it does not mean the track is only selectable in Zone 2. Every asset is assignable to any room, encounter, or moment anywhere in the campaign; the folder decides where it appears in the list, nothing else. The same holds for every categorized picker on the GM side: organization is presentation, and the full library is always reachable.

**Missing art never blocks.** An enemy template with no sprite renders as a grey silhouette carrying its name; a room with a missing prop renders the prop's footprint with a label; a track assignment pointing at a file that isn't there yet plays silence and shows the name greyed in the Jukebox tab. The GM can author and run content ahead of its art, and dropping the file in later completes it with no further action. Sprite sheets keep the grid-parameter sidecar convention from the sprite tester (per-file layout set once, stored beside the file).

## 2. Session snapshots

One button captures complete world state: party stats, inventory, credits, statuses and stat changes, current location, room hidden/revealed piece states, encounter queues and their pools, jukebox state. Snapshots are also taken automatically at session end and **automatically before every boss encounter launch**. Restoring is one click from a named list ("before Dedan", "end of session 4"). Snapshots are server-side files, human-readable JSON, so a catastrophic case can be hand-edited.

## 3. Undo last hand-edit

The Players and Items panels get a single-step undo for the most recent GM edit — the misclicked ±50 HP, the credit grant with an extra zero. One step is the requirement; a history stack is optional polish. Combat actions are never undoable (the engine's results stand); this is for the GM's own hands only.

## 4. Clone anything

Encounters duplicate with waves, slot assignments, GM/AI flags, object pools, and drop assignments intact. Rooms duplicate with geometry, props, hidden states, and palette. Enemy templates duplicate with full kits. Fight #40 starts from fight #39, not from zero — the console's authoring model is copy-and-vary, which is how a GM authoring one leg ahead actually works.

## 5. GM notes on everything

A free-text note field on rooms, encounters, and enemy templates, visible only to the GM, displayed wherever the object is shown (a small expandable line in the Encounter lane, the Location list, the template editor). "Dedan enters after wave 2 — voice: gravel." "The left switch is the fake one." "Party skipped the Alma detour; loop back before boss." No structure, no features, just the GM screen living inside the console.

## 6. Refresh-proof players

A player who closes their tab, crashes, or loses connection mid-combat rejoins into their seat with full state — HP, CP, gauge position, statuses, pending action menu — exactly as the server holds it. This is already implied by server-authoritative architecture; it is named here so it gets **built and tested deliberately**, because a browser will die during a Guardian fight and that moment decides the table's trust in the software. Reconnection must never reset a gauge, duplicate a seat, or drop a queued action.

## 7. Data-reload diff

When the GM reloads any data file (bestiary, class kits, level tables, gear, item catalog), the console shows a diff of what changed before applying: "Dedan: hp 4200 → 4000 · Fortune Ticket: heal 200 → 150 · Ursa Shot: cp 16 → 18." The system's doctrine is balance-patches-as-data-edits; the diff makes each patch visible and catches the fat-fingered zero before it reaches the table. Confirm applies, cancel discards.

## 8. Combat log export

Every fight writes a timestamped action log — actor, action, target, roll results, damage/heal values, status applications and cures, gauge events, deaths, item uses — exportable as a text or JSON file per encounter. This is how the playtest watch-list gets audited against reality: actual fight lengths versus the 30–40 s fodder / 3–4 min boss targets, actual Purifier heal share versus Fortune Ticket usage, actual Epsilon AoE contribution. Numbers over vibes.

## Boundary note

Everything in this document is engine/console implementation. None of it changes a rule of the game: no feature here may alter combat outcomes, economy values, or any behavior defined by the System Document, the spec, or the data files. QOL serves the table; it never plays the game.
