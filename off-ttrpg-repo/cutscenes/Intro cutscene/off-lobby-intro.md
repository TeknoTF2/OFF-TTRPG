# OFF TTRPG — The Lobby & The Intro

Design for everything before the first room: player arrival, campaign start/load, and the interactive intro scene ("the Birthday"). The intro's full text, menus, and reaction lines live in the GM's script document (intro_script, current version) — that script is **authored scene content**, and this document defines the machine that plays it.

## 1. The Lobby

The quiet room before the world. Black screen, the campaign title, and the sparkle field: each connected player is a small white sparkle drifting in the distance, fading in and out. No names, no list, no chrome on the player side — a player who logs in sees the dark, their own sparkle among others, and waits. This is deliberately the intro's visual language already in effect: the lobby *is* the Nothingness.

**GM lobby controls** (GM side only): the seat roster (who is connected, which seat), **New Campaign**, **Load Save** (the QOL snapshot list — restoring drops everyone into the world exactly as held), and the Cutscene tab, from which the intro is launched like any authored scene. Nothing auto-starts; the world begins when the GM says so.

## 2. The Intro Scene Machine

The intro is the first entry in the Cutscene tab and the prototype of an **interactive scene**: a sequence of beats, some of which are choice gates. It establishes the general machinery — any future authored scene may use these parts.

**Beat types:**
- **Text beat** — a line appears on all screens. Advanced only by the GM's Continue. The GM narrates aloud as each line lands; the on-screen text is staging, the voice is the performance (the no-dialogue-box ruling stands: this text is scene content, same exception class as the shop bubble).
- **Choice gate** — a menu appears on every player's screen (class, gender, desire, fear, virtue, the final question) or an input box (name). Players choose independently at their own pace. On confirming, a player's screen returns to the sparkle field: they wait in the dark with the others.
- **Ceremony beat** — scripted automatic staging paced by GM Continue: the stat tick-up (values from `off-level-tables.json` level 1 for the chosen class, filling one stat per Continue as the GM voices its line) and the starter competences appearing (level-1 rows from `off-class-kits.json`).
- **Scene beat** — visual backdrop changes (the Queen's silhouette, the workers loop). Components of the scene, GM-advanced like text.

**The sparkle protocol.** Throughout the intro, every player's screen keeps the distant sparkle field. When any player confirms a choice, one sparkle pulses on everyone else's screen. Never labeled, never explained, exactly as scripted. This is presence without information — players know their siblings are deciding, and nothing more.

**Barrier and the GM's Continue.** At a choice gate the GM's conductor view shows who has confirmed and who is pending. **Continue is never locked** — per the core philosophy, the console never tells the GM "you can't." The pending count is information; waiting for it is the GM's choice. Advancing past a pending player auto-confirms nothing: their gate stays open in parallel and their choice records whenever made (the GM can also set it by hand in the conductor, as with everything).

**Hover micro-lines.** The Puppeteer's per-option reaction lines (the class portraits' lines, deliberately uneven) display as **private text on the hovering player's screen only**. This is the one place text speaks without the GM's voice, forced by physics: six players hover asynchronously and one voice cannot narrate six private moments. Thematically it earns its exception — the Puppeteer whispering to each soul individually while speaking aloud to all.

**Branches.** Script branches are scene data: the Mercy→Justice refusal is a conditional text beat keyed to the virtue choice, played per-player (only the Mercy-choosers see their virtue overwritten; the GM's conductor shows the override). The final question's four reactions key the same way. Branch machinery is general: any authored scene may branch on a recorded choice.

## 3. The Conductor View (GM)

The GM's screen during any interactive scene: the script's beat list with the current beat highlighted, the **choice matrix** — six rows, filling live as players confirm (class, gender, name, desire, fear, virtue, final feeling) — pending indicators, the Continue button, and a per-player override (set or change any choice by hand; the matrix is a Players-panel view, not a separate authority). The GM watches the party assemble itself in real time while performing the Puppeteer.

## 4. What Persists

Class, gender, and name create the character record (stats and kit follow from data files). **Desire, Fear, Virtue, and the final feeling are recorded onto the character sheet** as a flavor block — visible to their player and the GM, mechanically inert, permanently in reach of the GM's narration. A campaign's worth of callbacks lives in that matrix; the system's only job is to never lose it.

## 5. Edges

- **Reconnect mid-intro:** the QOL seat-restore rule applies — a dropped player returns to their current gate or waiting state exactly.
- **Absent player at session zero:** the GM can run the intro scene for any subset, any time — a late sibling is born late, alone with the Puppeteer, which is its own scene.
- **Load Save** skips the intro entirely; the intro is playable again only by GM choice (it is a Cutscene-tab entry like any other, launchable whenever — unrestricted creation engine).
- **Duplicate names:** allowed by the engine; the table sorts itself out. The Puppeteer has opinions the GM may voice.

## 6. Boundary

The scene machine (beats, gates, barriers, sparkle protocol, branches, conductor) is engine work. The script's text, menu options, reaction lines, and pacing are **authored content** — the GM's, editable without code, and the intro script document is their source of truth. Where the script and this document disagree on content, the script wins; where they disagree on machinery, this document wins.
