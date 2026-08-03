# OFF TTRPG — Enemy Restat Worksheet

Companion to the System Document. **Sourcing policy: the 2025 remake is the primary canon** — its tuning is better and its enemy data is formatted in this system's own schema (BaseValue / Atk-Esp split / Var / MovePower, confirmed via the remaster's published competence tables). Original RPG Maker data is the fallback where remake documentation is thin, and remains valid for relative toughness ordering within a zone. The worked examples below were derived from party throughput, not canon magnitudes, so they hold under either anchor; movesets should be checked against remake data as it becomes available.

## Party level anchors

All conversion math is evaluated at the level the party meets the enemy. Growth is anchored to the system document's checkpoint tables.

| Zone | Party levels | Boss at |
|---|---|---|
| Zone 1 | 1–5 | 5 (Dedan) |
| Zone 2 | 6–10 | 10 (Japhet) |
| Zone 3 | 11–15 | 15 (Enoch) |
| The Room / endgame | 16–20 | 20 |

## The conversion procedure

Seven steps per enemy. Canon supplies identity; the party's throughput supplies magnitude.

**1. Element — from canon, inverted where needed.** Canon lists resistances and weaknesses; the system derives identity from them. "Light resistance to Smoke" means the enemy *is* Smoke (mirror match, now neutral 1.0 in our engine). "Light weakness against Metal" also means Smoke, since Metal beats Smoke on the ring. Where canon gives nothing, assign from flavor and zone.

**2. Archetype — fodder, elite, or boss.** Sets the status-tier template and the fight-length target: tutorial fodder dies in ~1 action, standard fodder fights run 45–90 s, elites 90–120 s, bosses 3–4 minutes.

**3. HP — from party DPS at the anchor level.** Estimate effective party damage per second (damage-per-action × summed gauge rates, discounted for accuracy, enemy DEF, element mix, and the share of party actions spent on support), multiply by the fight-length target, and split across the canon group size. Canon HP fixes only the *ordering* within a zone — a One-eyed Spectre stays ~6× a Common Spectre.

**4. Damage — from party HP and heal throughput.** Sustained incoming DPS should sit at 60–90% of the party's maximum healing throughput at that level, so attrition drains CP and items without healing being a solved loop. Spikes (a boss's big move, a group's synchronized cycle) may exceed it. Because player HP is anchored to the Batter's canon 100, canon damage numbers at matched levels are often close to portable — verify, don't assume.

**5. Gauge seconds — hand-set, no enemy AGI.** Fodder 4.5–6.0 s, elites 3.0–4.5 s, bosses 2.0–3.0 s. Total enemy actions per second across a group should stay below the party's ~1.4–2.0, or incoming damage outruns step 4.

**6. RES, LCK, and status tiers — from the archetype template.**

| | Fodder | Elite | Boss |
|---|---|---|---|
| RES | 5–10 | 12–20 | 25–32 |
| LCK | 1–4 | 5–10 | 8–15 |
| Hard control (Palsied, Asleep, Madness, Muted) | Vulnerability or Neutral | Light immunity | **Strong immunity** |
| Soft control (Blinded, Furious) | Vulnerability | Neutral | Light immunity |
| Poisoned | Neutral | Neutral | **Light immunity** (see note) |
| Stat changes | always land (never roll) | always land | always land |

**Boss Poison note.** Poisoned ticks 1/25 of *max HP* per turn of the afflicted. On a 4,000+ HP boss at a fast gauge, each tick is ~170 and a neutral-tier application is worth ~500 damage for 18 CP — an order of magnitude over any damage competence. At Light immunity (45 − RES), expected value drops to ~85–90 per cast, which prices correctly against the damage ladder. Light immunity to Poisoned is therefore the boss default, not a flavor choice. Alpha's Corrosion (treats Light immunity as Neutral, level 18) deliberately re-opens this against endgame bosses — that's the payoff it was built for.

**7. Moves — canon names and effects, hand-set MP and accuracy.** Keep every canon competence name and its effect category (damage / damage+status / drain / summon). Set MovePower against the enemy's own ATK/ESP so the output lands where step 4 wants it. Enemy accuracy is hand-set per move, per the system document.

**Enemy CP is bookkeeping, not economy.** Enemies don't participate in the item economy; give them enough CP for the intended number of competence uses and nothing more, or mark the pool unlimited for bosses with scripted behavior.

---

## Worked example A — Common Spectre (tutorial fodder)

**Canon:** HP 10, ATK 40, DEF 1, AGL 35. Attack deals 7–10 at 95%. Resists Smoke. Appears in the smoke mines, two groups of four. Light vulnerability to nearly every status.

**Derivation.** Resists Smoke → *is* Smoke → weak to Metal, resists Meat. Tutorial fodder: dies to one solid hit. Level 1 party basic attacks land 11–21 before element; the Purifier's Metal attack doubles to ~42. HP 20 means the Purifier and Bandit one-shot, support classes two-shot, and the Meat classes (Epsilon, Burnt) deal half — the first fight quietly teaches that element matchups run both ways. Canon damage 7–10 ports directly since party HP is Batter-anchored: eight spectres at ~5.5 s gauges deal ~11/s across a 480 HP party pool. The fight ends in 15–25 seconds.

| Field | Value |
|---|---|
| Element | Smoke |
| HP | 20 |
| ATK | 9 |
| ESP | — |
| DEF | 0 |
| LCK | 2 |
| RES | 5 |
| Gauge | 5.5 s |
| CP | 0 |

**Moves:** Attack — one target, Smoke, acc 95, ~8–10 damage.

**Status tiers:** Vulnerability across the board (canon). Let Alpha's level-1 kit feel powerful here.

**Grouping:** 8 (two waves of 4, per canon).

---

## Worked example B — One-eyed Spectre (standard fodder)

**Canon:** HP 65, ATK 70, DEF 70, AGL 35. Attack 15–25 at 95%, Swing 40–55 at 100% for 5 CP. Weak to Metal. Always in groups of three.

**Derivation.** Weak to Metal → Smoke. Met mid–Zone 1, anchor level 3 (interpolated stats). Effective party DPS ≈ 20/s after accuracy, DEF, element mix, and support turns; a ~35 s standard fight against a group of three gives a ~690 pool → **230 HP each**. (Errata: an earlier draft said 190, silently anchoring to the canon 6.5× ratio over the Common Spectre instead of the pool math — the ratio orders enemies within a zone, but the pool sizes them. Pool math governs.) Incoming: canon Swing at 40–55 would take half the level-3 Bandit's HP per hit — too hot for a *standard* encounter with six targets to spread across. Ported down: three spectres at 5.0 s cycling Attack (~15) with occasional Swing (~30) deal ~10–13/s against ~14–17/s of maximum party healing. The party wins but pays CP — which is the entire job of a random encounter in a rest-zone economy.

| Field | Value |
|---|---|
| Element | Smoke |
| HP | 230 |
| ATK | 15 |
| ESP | — |
| DEF | 5 |
| LCK | 3 |
| RES | 8 |
| Gauge | 5.0 s |
| CP | 15 |

**Moves:** Attack — one target, Smoke, acc 95, ~13–17. Swing — one target, Smoke, 5 CP, MP 2.0, acc 90, ~27–33.

**Status tiers:** Vulnerability to hard control, Neutral to soft control (slightly tougher than tutorial fodder; canon lists broad vulnerability, tightened here so Alpha's Palsy doesn't trivialize every standard fight by level 3 — this is the one deliberate departure from canon tiers, and it's a dial).

**Grouping:** 3, per canon. Add a fourth for a hard encounter.

---

## Worked example C — Dedan (Zone 1 boss, party level 5)

**Canon:** HP 4,000, CP 200, ATK 80, DEF 65, ESP 70, AGL 55. Competences: Minute Hand (moderate single-target damage), Hour Hand (inflicts Sleep), Sweep Hand (damage + Furious). Summons 笑 speech bubbles at HP thresholds (~55%, ~45%, ~15%) that inflict Blind and drain CP. The remaster adds **Half Past — Dedan inflicts Hasty on himself** (remaster-only, imported deliberately; see below). Zone 2's library describes his "body made out of steel."

**Derivation.** Element: the steel body reads as **Metal**, weak to Plastic — which hands the fight to Alpha (Plastic strings at 2×) and punishes the Smoke classes (Bandit and Omega deal 0.5×). The Purifier's Homeruns ignore it entirely at Sugar. First boss, first hard lesson in who carries which fight.

HP: level-5 party effective throughput on the boss ≈ 22/s once support turns, healing turns, and bubble-killing are discounted (raw striker output ~37/s with Comic Drama and Gaussian Blur running, Alpha doubled, Bandit halved). A 3–3.5 minute fight → **4,200 HP**. Canon's 4,000 lands almost exactly right — not a coincidence, since the system's player stats are Batter-anchored and six players output roughly 3–4× one Batter, while a boss fight for six should run roughly 3–4× longer than solo pacing intended.

Action economy: at a 2.4 s gauge Dedan takes 0.42 actions/s against the party's ~1.4 — outnumbered 3.3:1, which is why he gets two force multipliers. The bubbles absorb the party's surplus actions (and their Blind bites the Bandit hardest, 87 → 67). Half Past is the phase turn: **at 40% HP** Dedan casts it and goes Hasty until death (scripted, no cure check — a phase mechanic, not a status application). Incoming damage jumps from ~15/s (right at the party's sustainable healing) to ~28/s (decisively above it), converting the last 1,700 HP into a race the party wins with items, Depth of Field, and revives — or doesn't. The 40% trigger is the difficulty dial; 50% was tested on paper and produces a race long enough to likely wipe a level-5 party.

Hour Hand's Asleep and Sweep Hand's Furious both roll at Neutral against party RES — the level-5 spread (Burnt 24 down to Bandit 12) means the same move is a shrug for one player and a crisis for another, which is the RES system doing its job in a boss fight for the first time.

| Field | Value |
|---|---|
| Element | Metal (weak to Plastic) |
| HP | 4,200 |
| ATK | 40 |
| ESP | 35 |
| DEF | 20 |
| LCK | 10 |
| RES | 28 |
| Gauge | 2.4 s |
| CP | unlimited (scripted) |

**Moves:**

| Move | Target | Split | MP | Acc | Effect |
|---|---|---|---|---|---|
| Attack | one | 100/0 | 1.0 | 95 | ~40 Metal |
| Minute Hand | one | 100/0 | 1.1 | 95 | ~44 Metal |
| Hour Hand | one | 0/100 | 0.6 | 90 | ~21 Metal + Asleep (Neutral tier) |
| Sweep Hand | one | 0/100 | 1.0 | 90 | ~35 Metal + Furious (Neutral tier) |
| Half Past | self | — | — | — | Scripted at 40% HP: Hasty until death, no cure check |

**Summons (scripted, not competences):** 2 × 笑 at 55% HP, 2 × at 45%, 3 × at 15%.

**笑 (speech bubble):** Sugar-adjacent nuisance — no element (elementless damage-free kit). HP 25, RES 5, gauge 4.0 s. Moves: Chronic Migraine — one target, Blinded (Neutral tier), cannot-miss pure status; Partie Quarrée — one target, acc 95, drains 10 CP, no damage. One hit from anyone kills a bubble; ignoring them costs CP the party cannot restore mid-dungeon.

**Status tiers (boss template):** Strong immunity — Palsied, Asleep, Muted, Madness. Light immunity — Blinded, Furious, Poisoned. Stat changes land normally, so Gaussian Blur and Ganache-line debuffs remain the party's levers, per template.

**Playtest watch list for this fight:** whether the Bandit player feels useless at 0.5× (mitigated by bubble duty and Perseus Mark not existing yet — steal turns are the fallback), whether three Neutral-tier status moves land too often on the low-RES half of the party, and how long the post-40% race actually runs at the table versus the ~75 s paper estimate.

---

## Standing notes

**Naming collision.** Canon Zone 1 has an enemy called "Burnt" and Zone 3 has "Cavalry-burnt," while a player class is the Burnt. Rename the enemies ("burnt Elsen," "Cinder," zone-specific names) or the collision will bite at the table the first time someone says "attack the Burnt."

**Source discrepancies.** The Fandom compilation notes several places where Wide Angle's in-game readout disagrees with the RPG Maker database (Crown of the Dead's Smoke weakness, Cavalry-burnt HP). Where they conflict, prefer the database value — the readout is flavor, the database is the game.

**Remake-first sourcing.** The system's damage formula matches the remake's competence schema field for field, so remake enemy blocks need rescaling only, not translation. Half Past and the clock mechanic (every action advances a clock; at 12:00 Dedan uses Hour Hand or Half Past) are canon under this anchor, and the clock is a telegraph system worth implementing wholesale in the software — it makes a real-time boss readable. Update the system document's provenance paragraph to match this policy.

**Data access.** The Miraheze OFF wiki (remake-anchored) blocks automated access; consult it manually in a browser, or pull stat blocks from the game itself, and paste them in when statting specific enemies. Fandom documents the remaster only in patches; its complete bestiary compilation is original-version data, which is why it serves as the fallback tier.
