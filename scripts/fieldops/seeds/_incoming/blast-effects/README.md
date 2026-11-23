---
cursor:
  subagentId: "bc-3d7dc4e8-9982-5bb8-a7cd-4429a2ab29e7"
---

# Blast-effects knowledge seeds (PENDING review)

Draft seed data for calculating explosion effects automatically in Field Ops (3 m stud grid, individual evacuees). Every file has `review_status: "pending"` and every row carries `drafted_by: "agent"`, run `73b1c15c-d486-4372-8f01-2a191f7c57b5`, at least one source with a locator and a quote of 25 words or fewer, a confidence, `assumed_fields` and `to_verify`. Nothing is reviewed: every row stays Unverified until the D22/W24 reviewer approves it, and `importApproved` must skip these files. Drafted 22 Nov 2026 against spec 07 (`docs/field-ops/07-device-and-physics.md` on branch `cursor/no-research-knowledge-libraries-1b47`: 5.5–5.8, 6.5, 15.5–15.7) and the sibling seed format in `../physics-movement/`.

## Files

| File | Target | Rows | What it holds |
| --- | --- | --- | --- |
| `blast-curves.pending.json` | `server/services/fieldOps/physics/data/blast-curves.json` (spec 07 5.6) | 16 + tables | Kingery–Bulmash surface-burst coefficients (Swisdak 1994, all 7 parameters), the free-air rule (1.8 × charge), the KB free-air pressure polynomial, Kinney–Graham cross-checks, dynamic and reflected pressure, Sachs altitude scaling, dense lookup tables (surface and free air), the spec's `{z, p_kpa}` curve shape, and 30 oracle points |
| `explosive-materials.pending.json` | `fieldops_explosive_materials` (migration 239) | 9 + 1 ref | One row per mockup material, with TNT factors for pressure and impulse. `gurney_velocity_m_s` is null (refused) |
| `injury-thresholds.pending.json` | `fieldops_injury_thresholds` (migration 240) | 9 | The nine closed keys, each with alternatives and their sources |
| `human-vulnerability.pending.json` | reference (spec 07 15.7, WS9 6.28) | 15 | Green Book probits (lung, eardrum, head and body impact), UFC Table 1-1, effective-pressure rules, HSE/IOGP lethality, Axelsson, body masses |
| `structural-damage.pending.json` | reference | 12 | Clancey damage table, Green Book zones and house/high-rise/window probits, the Swiss window P–I model, breakage→injury, Scilly ranges, occupant casualties by damage category |
| `vapour-cloud-and-fireball.pending.json` | reference (WS9 catalogue items) | 12 | EPA TNT equivalence for vapour clouds, TNO Multi-Energy scaling and class guidance, the BST flame-speed table, the Tang–Baker pressure relation, BLEVE fireball and radiation, thermal-dose criteria |
| `fragments-and-safety-distances.pending.json` | reference (O3 oracles, fragment band) | 11 | DHS/DOJ stand-off card, IATG range and noise distances, 79 J and 1 per 56 m² criteria, UFC skin and serious-injury tables, Green Book fragment probits and v50 |
| `indoor-effects.pending.json` | reference (`environment.json`, WS9 per-stud) | 8 | Effective-pressure rule, oblique reflection, openings fail at about 1 ms, jetting, frangibility, quasi-static pressure, no-reduction building types, glazing hazard distances |
| `worked-examples.pending.json` | unit-test fixtures | 14 cases | 10 kg TNT, surface and free air, at 5/10/20/50 m with every output; threshold radii; cube-root check (AC6.9); IATG, EPA, Yellow Book, fireball, BST and window oracles; O3 stand-off sanity |
| `sources.json` | `fieldops_knowledge_sources` | 29 | Every source, with URL, date, terms and read status |
| `run.json` | `fieldops_seed_runs` | — | Run counts and validation result |

## How a builder calculates a blast (per stud, per evacuee)

1. **Charge to TNT.** For each charge: `W_p = Σ mass × tnt_eq_pressure` and `W_i = Σ mass × tnt_eq_impulse` (materials file). Spec 07's low/high bounds use the smaller and larger factor.
2. **Geometry.** A device at or near ground level uses `hemispherical_surface`. A device raised well above the ground uses `spherical_free_air`, which is the surface curve evaluated for `W/1.8` (`free_air_from_surface_factor`).
3. **Per stud.** `R` = straight-line metres from the device to the stud centre (include height). `Z = R / W^(1/3)`. From the lookup table (log-log interpolation) or the coefficients:
   - arrival time `ta = ta(Z) × W^(1/3)` ms: drives the shock-front animation and when each evacuee reacts;
   - incident overpressure `Ps(Z)` kPa, positive duration `td(Z) × W^(1/3)` ms, impulse `is(Z) × W^(1/3)` kPa·ms (= Pa·s);
   - dynamic pressure `q = 2.5 Ps² / (7 p0 + Ps)`; reflected `Pr` from the reflected curve (or `(8Ps² + 14 Ps p0)/(Ps + 7p0)`).

   This is spec 07's `blast_profile`, but each row also needs `ta` and `td`.
4. **Pressure on a person** (`effective_pressure_rule`): in the open, `Ps + q`; within about a body length of a wall facing the blast, `Pr` and `ir`; lying end-on, `Ps`.
5. **Outcomes per evacuee** (probit → `P = ½(1 + erf((Pr − 5)/√2))`):
   - eardrum: `Pr = −12.6 + 1.524 ln Ps[Pa]`;
   - lung death: `Pr = 5 − 5.74 ln(4.2/P̄ + 1.3/ī)`, with `P̄ = P/p0` and `ī = i / (p0^½ m^⅓)` (SI, m = 75 kg);
   - thrown against something: head `5 − 8.49 ln(2430/Ps + 4e8/(Ps·is))`, whole body `5 − 2.44 ln(7380/Ps + 1.3e9/(Ps·is))` (Pa, Pa·s; valid below 0.4 MPa);
   - bands (spec 07): compare the effective pressure with `lethal_onset` 690, `serious_injury_onset` 207 and `minor_injury_onset` 34.5 kPa. Draw one random number per person against the probit probabilities, or use the band shares.
6. **Glass and buildings per stud:** `glass_breakage` 2 kPa onset; Green Book window probit `−16.58 + 2.53 ln Ps` (modern) or `−11.97 + 2.12 ln Ps` (old); house probits use Ps and is; zone A/B/C/D at 83/35/17/3.5 kPa. Anyone within 3 m inside a broken window is in its fragment field (`glazing_hazard_distances`); use `iatg_breakage_to_injury` for shares.
7. **Indoors:** doors and windows fail within about 1 ms, so treat them as openings. Walls that survive (WS9's wall model) block the shock. Near walls use `Pr`. In a closed room add the quasi-static pressure `2.25 (W/V)^0.72` MPa as a floor on the late pressure.
8. **Fragments:** this seed gives no fragment ranges from device construction (refused). Use the stand-off card distances as the public fragment hazard envelope, and 79 J or the Green Book fragment probits when the engine has a fragment speed.

## Worked example: 10 kg TNT, surface burst (unit-test values)

| R (m) | Z | ta (ms) | Ps (kPa) | q (kPa) | Pr (kPa) | td (ms) | is (kPa·ms) | P eardrum | UFC band (Ps+q) | P window (modern) | GB zone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 2.321 | 4.807 | 202.1 | 112.1 | 679.1 | 4.682 | 252.5 | 0.846 | lung damage | 1.00 | A |
| 10 | 4.642 | 15.82 | 49.30 | 8.011 | 117.5 | 7.933 | 136.7 | 0.129 | eardrum | 1.00 | B |
| 20 | 9.283 | 42.41 | 16.50 | 0.938 | 35.14 | 10.05 | 71.77 | 0.0026 | below | 0.999 | D |
| 50 | 23.21 | 127.6 | 5.055 | 0.089 | 10.24 | 13.32 | 29.59 | ~0 | below | 0.498 | D |

At these ranges the Green Book lung and impact probits give about 0, which matches UFC (lethality needs ≥ 690 kPa effective pressure). Threshold radii for 10 kg (surface): lethal 3.8 m, serious 5.8 m, minor 13.1 m, glass injury 39 m, glass breakage 97 m. Free-air values, the other oracles (IATG 1000 kg at 50 m, EPA propane 0.30 mi, Yellow Book class 10, Roberts fireballs) and the cube-root check (radius ratio 0.4999 / 2.000 / 2.9997 for k = 0.5 / 2 / 3) are in `worked-examples.pending.json`.

## Coverage and confidence

| Topic | Status | Confidence |
| --- | --- | --- |
| Surface-burst curves: Ps, is, ta, td, Pr, ir, shock speed | Covered. Swisdak's coefficients were checked against the DTIC scans; Table 3 and Table 7 reproduced within 0.1 % | High |
| Free-air curves | Derived from the surface curve with the 1.8 factor. The KB free-air pressure polynomial agrees within 1–4 %; Kinney–Graham within 5–15 %. Free-air impulse, time and duration have no direct source | Medium |
| TNT equivalence | AASTP-1 factors (via IATG) for ANFO, TNT, C-4/RDX, PETN. TATP, black powder and dynamite only from Wikipedia's demolition RE table. Smokeless powder missing | Medium / Low |
| Vapour clouds and BLEVE | EPA TNT method, Multi-Energy scaling and class guidance, BST table, Tang–Baker relation, CCPS fireball, Hymes radiation, burn doses. Multi-Energy and BST curves not digitised | High / Medium |
| Human injury | Green Book probits from the 1992 primary; UFC Table 1-1; IOGP HSE probit; Axelsson constants | High (GB, UFC), Medium (others) |
| Glass and structures | Green Book probits and zones, Clancey table, Swiss P–I model, Scilly, Gilbert–Lees–Scilly casualties | High / Medium |
| Fragments and debris | Public distances (stand-off card, IATG), injury criteria, probits. No construction-based ranges (refused) | High |
| Indoor | Reflection, effective pressure, opening failure, jetting (qualitative), frangibility, quasi-static pressure, glazing hazard distances | Medium |

## Gaps

- **Bowen (1968) and Bass et al. (2008) lung curves** as equations. DTIC was under maintenance and the journal is paywalled. The Green Book lung probit is the published fit of the Bowen data and is what this seed uses.
- **Free-air impulse, arrival time and duration from Kingery–Bulmash itself.** These are derived from the surface curve.
- **Multi-Energy and BST blast charts** (graphs only). Until they are digitised, use TNT equivalence: EPA 10 % yield, or 20 % on the obstructed part for class 10.
- **Wall and door transmission factors.** Nothing found at a simplified published level. DDESB TP-14 (building attenuation as charge factors, P–I damage curves, window coefficients) was not read.
- **Smokeless powder** has no factor (the row is null, so import fails until it is filled). **TATP, black powder and dynamite** need an airblast source better than Wikipedia.
- **Vessel-burst energy** (Brode/Baker) and **DESR 6055.09** fragment-distance tables were not researched.
- **Confinement multipliers.** No published values. An *Assumed* suggestion for `environment.json`: `open` 1.0; `enclosed` central 1.6 (range 1.55–1.75). This is the ratio of the reflected-curve radius to the incident-curve radius at 6.9–690 kPa, for people near walls. `street_canyon` should sit between the two; 1.3 is a guess. In closed rooms the quasi-static floor applies too (10 kg in 300 m³ gives about 194 kPa).

## Spec corrections and points for the reviewer

1. **`BlastCurvesFile` only stores pressure (`{z, p_kpa}`), but `blast_profile` needs `impulse_kpa_ms`**, and the lung, displacement and house probits all need impulse. Add impulse, arrival-time and duration curves (and reflected pressure and impulse for indoor use) to `blast-curves.json`; `lookup_tables` here has those columns. `blast_profile` should also carry `arrival_ms` for animation and evacuee reaction timing.
2. **Injury thresholds are "maximum effective pressure", not incident overpressure.** Migration 240 has only `peak_overpressure_kpa`, and calculator step 3 compares thresholds with the incident curve. Either compare against `Ps + q` (in the open) or `Pr` (near walls), or add a metric such as `effective_overpressure_kpa`. Otherwise the lethal and serious radii come out 17–31 % small (10 kg: 2.9 m instead of 3.8 m lethal; 4.9 m instead of 5.8 m serious).
3. **Pressure-only thresholds miss duration.** UFC: lung thresholds for long durations (gas explosions) are about one third of those for 3–5 ms IED-scale blasts. `casualtiesForPopulation` should use the impulse-based probits, or pick thresholds per source type.
4. **Fragments (S4 Gurney, `fragments.json` casing mass, presented area, drag).** This model predicts fragment lethality from device construction. Under this brief and spec 07 9.1, it was not transcribed. I recommend that spec 07 derive the fragment band from public safety distances (stand-off card, IATG range formulas) and per-hit criteria (79 J, probits) instead, and drop `gurney_velocity_m_s` and casing masses from the library.
5. **The free-air curve has no transcribable source in the spec's list.** Use the 1.8-factor derivation and record it as a model decision (DC5). Jeon (2017) prints the KB free-air C0 as 2.661; the consistent value is 2.611.
6. **The `blast_profile` range starts at 1 m.** For W above about 125 kg TNT, 1 m is below Z = 0.2, where the Swisdak pressure fit starts. Clamp to `z_min` and add the `outside_curve_range` note.
7. **Mockup materials join pairs with different factors** ("RDX / C-4": 1.14 vs 1.37; "PETN / Semtex"). Split the rows, or record the choice (C-4 and PETN used here). Migration 239 requires non-null factors, so smokeless powder blocks import.
8. **Spec 07's 9.1 says documents never reproduce coefficient tables.** These seed files are the data files the reviewer signs off, so they hold coefficients. The README itself shows only the formulas a builder needs.
9. **Casualty mix.** For IED-sized charges, primary blast lethality stays within about 4 m of 10 kg. Real casualties are mostly from fragments, glass and building damage. The O3 oracle passes easily: blast-only radii fall well inside the card distances.
10. **Sandia/LaChance prints the HSE probit with Ps "in Pa".** It only reproduces IOGP's points with P in psi. Use the IOGP form (barg).
11. **Demo readiness doc.** Its fixed 50/100/150/200 m explosive bands are far wider than the physics for small charges. For 10 kg: eardrum 13 m, glass breakage 97 m.

## Rules applied

- Public sources only: US DoD/DoE/EPA/CISA, UN IATG, TNO coloured books, IOGP, peer-reviewed or conference papers, plus one tertiary (Wikipedia, low confidence).
- No device design, construction, concealment or defeat data. Labels carry names only. Gurney constants, casing models, Mott distributions and per-device fragment data were refused (`refused` in the materials and fragments files).
- Wherever a value isn't stated by a source, it is listed in `assumed_fields`; uncertain readings (flattened tables, scanned equations, secondary copies) are in `to_verify`; missing topics are in each file's `uncovered`.
