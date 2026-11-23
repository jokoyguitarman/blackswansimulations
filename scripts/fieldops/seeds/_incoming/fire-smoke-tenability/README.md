---
cursor:
  subagentId: "bc-f053248e-fcdd-571e-8c24-5eefd7303c53"
---

# Fire, smoke and tenability knowledge seeds (PENDING review)

Draft reference rows that give the Field Ops layered engine (WS9, `docs/field-ops/11-living-world.md` sections 6.23, 6.24 and 6.30 on branch `cursor/no-research-knowledge-libraries-1b47`) the numbers it needs to simulate fire spread, smoke movement and evacuee response on the 3 m stud grid with four layers per storey. Every file has `review_status: "pending"`, every row has `drafted_by: "agent"` and `run_id` `c5e39fd8-acfd-5eb9-8a63-41d97cc2d703`, and `importApproved` must skip them until a W24 reviewer approves (AC9.81). Drafted 22 Nov 2026.

These seeds **extend** `../physics-movement/` (ISO 13571 constants, NFPA 92 plume and layer equations, C/VM2 sprinklers and yields, t-squared classes, crawl speed, Jin and Frantzich–Nilsson speed fits) and `../building-hazards/`. They don't repeat those rows; where a row overlaps, its `extends` field names the existing row.

## Files

| File | Rows | What it holds |
| --- | --- | --- |
| `smoke-movement.pending.json` | 23 | Yamana–Tanaka layer descent, Heskestad plume (entrainment, flame height, virtual origin, temperature, wall and corner factors, weak-plume cap), Alpert ceiling jet (dimensional and CFAST forms, corridor form), soot production, soot yields for 24 materials, extinction coefficients (flaming, smouldering), visibility constants by object, smoke detector model, door vent flow, spill plume, C/VM2 leakage areas, stack pressure, MQH layer temperature, lining properties, and a **grid smoke-transfer scheme** |
| `fire-growth-spread.pending.json` | 19 | t-squared α classes (plus car park and storage), critical heat flux and thermal response for 13 materials, ignition time, measured ignition times, flashover (MQH, Babrauskas, Thomas, Peacock and C/VM2 criteria), flame-spread rates by mode, compartment-to-compartment spread, Singapore fire-door ratings, sprinkler activation (RTI equation, generic RTIs), Evans suppression decay, sprinkler reliability, pool fire HRR, point-source radiation, vehicle fire HRR (NFPA 502), window radiation |
| `tenability-response.pending.json` | 16 | Purser FED (CO, HCN, NOx, O₂, CO₂ hyperventilation), Purser irritant FIC/FLD, NZ Building Code tenability limits, CIBSE heat-exposure temperatures, C/VM2 pain time, EPA burn endpoint, Jin's tenable smoke densities, Jin corridor turn-back, Bryan and Wood smoke-movement shares, Fridolf tunnel speed, crouch gap, pre-travel times (C/VM2, PD 7974-6 percentiles, measured store) |
| `outdoor-evacuation.pending.json` | 10 | SCDF assembly-area distance, ERG Guides 112, 115 and 128, ERG BLEVE table, ERG chlorine large-spill distances, "don't gather at the boundary", CISA/NCTC bomb stand-off, UK cordons, running-crowd speeds and flows |
| `worked-examples.pending.json` | 16 examples | Test vectors with inputs, expected outputs and tolerances, computed from the rows (also embedded in each row's `worked_example`) |
| `sources.json` | 34 | Every cited source with URL, access date, terms note and access status |
| `run.json` | — | Run counts, sources that weren't accessed, checks run |

Row shape follows `../physics-movement/exposure-reference.pending.json`: `ref_key`, `topic`, `value`, `unit`, optional `formula`, `note`, `spec_ref`, `extends`, `worked_example`, and `provenance` (sources with locator and a quote of 25 words or fewer, `confidence`, `assumed_fields`, `to_verify`), plus a blank `review` block. `merge` is `reference_only`: migrations 250 and 258 have no columns for most of these, so WS9 decides whether they become engine constants or new columns. The generator script is at `/cursor/stores/bc-dd814976-2bda-4cfb-92e8-2402418d2ccf/internal/fire-smoke-tenability-seed-generator/`.

## Spec corrections for reviewer attention

| # | Spec (PR #23) | Finding | Suggested change |
| --- | --- | --- | --- |
| 1 | 6.23.2 Radiation: 12.5 kW/m² ignites a combustible stud after 30 s | NUREG-1805 Table 6-3 and Eq. 6-3: red oak (CHF 10, TRP 134) takes about 2,260 s at 12.5 kW/m² and 141 s at 20 kW/m²; PMMA (CHF 11) is slower still | Use `t_ig = π/4 (TRP/(q − CHF))²` per contents class, with a dose sum for varying flux (`ignition_time_thick`) |
| 2 | 6.23.3 Visibility: K = 8 while power holds, 3 when it fails | Jin, via NUREG Table 18-1 and FDS: 8 applies only to light-emitting signs; walls, floors and doors, which people navigate by, are 3 under any lighting | Use K = 3 for route perception and posture; use 8 only for "can I see the exit sign" |
| 3 | 5.19 `tenable_temp_head_c` 60 °C (ISO 13571, PD 7974-6) | CIBSE (NUREG Table 2-2): 60 °C is the **metal-contact** burn temperature; for air it gives 100 °C for 30 min and 120 °C for under 5 min. PD 7974-6's 60 °C couldn't be checked | Keep 60 °C as Unverified until PD 7974-6 is read; record 120 °C for under 5 min as the sourced alternative |
| 4 | 5.19 `crouch_visibility_m` 5 m (PD 7974-6) | The NZ Building Code (C4.3) uses 10 m, or 5 m in rooms under 100 m². Jin 1997 gives K 0.15/m for unfamiliar occupants and 0.5/m for familiar ones; his metres imply K = 2 | Store the thresholds as extinction coefficients (0.15 visitors, 0.5 staff), not metres |
| 5 | 5.19 `reroute_visibility_m` 3 m, `turn_back_permille` 300 (Bryan, Wood) | Confirmed in substance: Bryan 29.9 % and Wood 26 % of those who moved through smoke turned back; the median turn-back visibility was 2 yd (1.8 m) or less | Keep 300; a reroute threshold of 2 m fits the data as well as 3 m |
| 6 | 6.23.3 Filling: 60 % lost to boundaries (Assumed) | MQH gives a sourced loss term, with hₖ from the lining's thermal inertia (NUREG Eq. 2-1 to 2-5) | Replace the Assumed 60 % with MQH or an hₖ energy balance |
| 7 | 6.23.3 Across regions: 0.5 m/s across the smoke depth (planning) | CFAST orifice flow (C = 0.7) gives a mean of about 0.9 m/s for a 400 K layer 0.5 m above the neutral plane | Use `vent_flow_orifice`; 0.5 m/s is the right order only for cool smoke |
| 8 | W29 / AC9.62: heat release held constant after sprinkler activation (C/VM2) | Evans (NIST IR 5254) bounds unshielded fuel at `Q_act · exp(−Δt/435 s)` for spray density of at least 0.07 mm/s | Keep the cap as the default, and add the decay as an option for sprinkler or crew suppression |
| 9 | 6.23.2 Flashover at 600 °C | Peacock 1999 confirms 600 °C **or** 20 kW/m² at the floor; C/VM2 designs at 500 °C with a 15 s ramp | Add the floor-flux criterion; note C/VM2's 500 °C |
| 10 | 6.30.7 `outdoor_safe_distance_m` 200 (planning) | Distances depend on the threat. Fire (SCDF): at least the building's height and never under 20 m. Suspect item (UK): 100, 200 or 400 m. Explosive (CISA): 21 to 479 m mandatory, 366 to 2,835 m preferred. Hazmat (ERG): 50 to 1,600 m | Choose the safe distance by event type from `outdoor-evacuation.pending.json` |
| 11 | 5.19 `smoke_speed_floor_factor` cites Fridolf, Nilsson and Frantzich (2013) *Fire Technology* 49 | The located 2013 paper is Fridolf, Ronchi, Nilsson and Frantzich, *Fire Safety Journal* 59: 0.9 m/s at K 2.2/m | Fix the citation |
| 12 | 5.12.2 contents `flame_spread_m_min` 0.5–8 m/min | USFA gives lateral spread on thick solids of about 0.1 cm/s (0.06 m/min) and upward spread of 1–100 cm/s. The spec's rates are room-scale fitted values, not surface spread | Label them as fitted room-scale rates; no per-material source found |
| 13 | Purser vs ISO 13571 constants | Two families: FDS/Purser (CO 2.764e-5·C^1.036; irritant FIC HCl 900, SO₂ 120) against ISO (C·t/35,000; HCl 1,000, SO₂ 150). At 1,000 ppm CO for 10 min they give 0.354 vs 0.286 | Pick one family per engine; don't mix |

## Coverage and confidence

| Topic | Status | Confidence |
| --- | --- | --- |
| Two-zone layer descent (Yamana–Tanaka; NFPA 92 already seeded) | Covered | High (NUREG-1805 page image read) |
| Plume entrainment (Heskestad), ceiling jet (Alpert) | Covered | High; Zukoski form not found open (gap) |
| Smoke production, soot yields, extinction, visibility constants | Covered | High |
| Smoke through doors, leakage, stairs | Covered | High for door flow and leakage; stack form Assumed (medium) |
| Grid cell-to-cell transfer | Covered as an assembled scheme | Medium (step order Assumed; acceptance test AC9.63) |
| t-squared, flashover, ignition by CHF, pool and point-source fires | Covered | High |
| Flame-spread rates per material | Partly covered | Medium (by mode only) |
| Compartment spread and Singapore fire doors | Covered | High for door ratings; the spread rule is low (Assumed) |
| Sprinkler activation, suppression, reliability | Covered | High |
| Vehicle fires | Covered (NFPA 502 representative values) | Medium (curve shape Assumed) |
| FED/FEC, heat, pain and burns | Covered | High |
| Smoke behaviour (turn back, reroute, move through) | Covered | Medium (survey data, secondary source for Bryan) |
| Crouch speed factor | **Gap** | — |
| Pre-movement distributions | Covered | High (C/VM2), medium (PD 7974-6 sample pages) |
| Outdoor assembly and isolation distances | Covered, with a Singapore rule for fire | High |
| Running-crowd density–speed | Partly covered | Medium (free speeds and breakpoint only) |

## Gaps

- **Crouch speed factor.** No measured stoop or crouch speed with a matched walking baseline was found; the spec's 0.6 stays Assumed.
- **60 °C head-height limit.** PD 7974-6's full text wasn't available (sample pages only).
- **Zukoski entrainment and CIBSE Guide E** aren't openly available; Heskestad, NFPA 92 and Yamana–Tanaka cover the same need.
- **Per-material room-scale flame spread** and **car-to-car spread intervals** (BRE BD 2552 wasn't accessed).
- **Singapore hazmat or bomb cordon distances.** No public SCDF or SPF figures were found; ERG, CISA and UK figures stand in.
- **Running crowds.** The full speed–density curve wasn't read (the 1.65 p/m² breakpoint is from a summary page); dispersal beyond 50 m falls back to walking speed.

## Caveats

- NRC's website refused this machine (403), so NUREG-1805 was read from the US GPO govinfo copy. Its equations are images and were read from rendered pages. One coefficient was printed as "538" and is recorded as the established 5.38 (`to_verify`).
- Several NUREG tables are reproduced from the SFPE Handbook "with permission". The values are transcribed as facts, but a reviewer should confirm reuse terms.
- PD 7974-6 values come from the publisher's sample pages and must be checked against a licensed copy.
- No attack, device or tactics detail is included. The stand-off rows hold only published public-safety distances.
