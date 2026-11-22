---
cursor:
  subagentId: "bc-84b1690f-a7f4-5728-bdd7-c084b3f8a26b"
---

# Physics and movement knowledge seeds (PENDING review)

Draft seed rows for the Field Ops knowledge tables that do not exist yet. Every file has `review_status: "pending"`, and every row has `drafted_by: "agent"`, at least one source with a locator, a confidence and its `assumed_fields`. Nothing here has been reviewed. Every row stays Unverified until the W24 reviewer approves it, and `importApproved` must skip these files (WS9 6.19, AC9.81).

Formats follow `docs/field-ops/11-living-world.md` on branch `cursor/no-research-knowledge-libraries-1b47`: the seed header in 5.12, `SeedProvenance` in 5.18, the 5.19 tables, migration 250 (5.2) and migration 258 (5.16), the incident types in 6.27, and the agent output shape in 8.5 (`rows`, `uncovered`, `refused`). Each row also has a `review` block for the reviewer to fill in (6.19 step 7). Drafted 22 Nov 2026.

## Files

| File | Target | Rows | What it holds |
| --- | --- | --- | --- |
| `spread-materials.pending.json` | `fieldops_spread_materials` (250) | 7 | Patches to the design-fire columns of the contents rows: growth class, HRR per m², heat of combustion, soot and CO yields |
| `release-agents.pending.json` | `fieldops_release_agents` (258) | 12 | Industrial and combustion-product gases: physical properties from NIOSH, AEGL tiers 1–3 at every duration from US EPA |
| `threat-profiles.pending.json` | `fieldops_threat_profiles` (258) | 5 | Outdoor plume (Briggs urban sigmas, Turner stability), vented gas deflagration (NFPA 68 / Zalosh), crowd crush (Fruin, Green Guide), pedestrian injury-risk curve (Tefft), aircraft impact fuel split (NIST NCSTAR 1, FEMA 403) |
| `movement-parameters.pending.json` | `fieldops_movement_parameters` (258) | 31 | SFPE hydraulic model, Weidmann, Fruin levels of service, Green Guide flows, crawl speeds, Jin visibility, extinction coefficient, radiant tenability |
| `incident-types.pending.json` | `fieldops_incident_types` (258, 6.27) | 7 | The phase-1 types, with responders, catalogue needs and templates from 6.27 and their public physics sources |
| `exposure-reference.pending.json` | none yet | 43 | Values with no column in 250/251/258: ISO 13571 FED/FEC/heat/smoke constants, C/VM2 sprinkler and post-flashover values, NFPA 92 plume and layer equations, Eurocode fire loads, walking speed in smoke, plus two recorded gaps |
| `sources.pending.json` | `fieldops_knowledge_sources` (259) | 32 | Every cited source with its access date, terms note and review-due date |
| `run.json` | `fieldops_seed_runs` (259) | — | Run counts. There is no `brief_hash` because `researchAgent.ts` doesn't exist yet |

Migration 251 (`fieldops_world_models`) is built per scenario by the prepare job and has nothing to seed.

## Coverage by topic

| Topic | Status | Notes |
| --- | --- | --- |
| Fire growth (t-squared classes, HRR per occupancy) | Covered, medium | Eurocode EN 1991-1-2 Tables E.4 and E.5; NZ C/VM2 2025 Table 2.3.2.1 |
| Sprinkler effects | Covered, high (reference only) | C/VM2: RTI, C-factor, 68 °C activation, and HRR held constant once sprinklers operate. This matches WS9's W29 rule. No sprinkler reliability figure was sourced |
| Smoke production and layer descent | Covered, medium | NFPA 92 plume and layer equations, checked against an open-access paper; Mulholland and Croarkin's extinction coefficient; Jin's visibility constants |
| Toxic and irritant gases, FED/FEC | Covered, high | ISO 13571 clauses 6, 8 and 9; AEGLs for 12 agents |
| Gas explosion venting | Partly covered, medium | Swift–Epstein low-strength form and C table (Zalosh 2002); NFPA 68 (2023) burning-velocity form not captured cleanly; glass and house damage thresholds Unverified |
| Outdoor plume | Covered, high | Briggs urban sigmas (two tabulations agree) and the Turner stability table; dense-gas tables are a gap |
| Crowd movement | Covered, high | SFPE hydraulic constants, Weidmann/Kladek, Fruin levels of service, Green Guide flows |
| Posture speeds | Partly covered | Crawl speeds covered (medium); no crouch factor found |
| Visibility effects on movement | Partly covered | Regressions by Jin, Frantzich and Nilsson, and Fridolf, from a secondary source; WS9's factor form isn't in any source |
| Crush and compression | Partly covered | Fruin: about 7 p/m² is near-fluid, forces over 4,500 N. No public source for compression dose bands (gap) |
| Slopes | Gap | Tobler's function recorded with low confidence and not re-read; Weidmann gives only a figure |
| Vehicle–pedestrian impact | Covered, high | Tefft (2013) risk points in mph. Vehicle masses and barrier classes are gaps |
| Aircraft impact and fuel fire | Partly covered, medium | Only how the fuel splits (NIST below 15 % burned inside, FEMA 25 % in the fireball) and the role of dislodged fireproofing. Class bands, swath and penetration are gaps by design (see Rules) |

## Discrepancies with the spec (reviewer attention)

1. **`crawl_speed`.** WS9 5.19 holds 0.4 m/s (range 0.2–0.7) citing Muhdi and Nagai, but those papers report means of 0.71 and 0.73 m/s, and Kady and Davis report 0.54–0.93. This draft uses 0.71 (range 0.54–0.93).
2. **`irritant_speed`.** 0.3 m/s is Jin's walking speed in darkness, not a speed he measured in irritant smoke. This draft records it as `smoke_dark_reference_speed`.
3. **`contents_retail` HRR per m².** Eurocode Table E.5 gives a shopping centre 250 kW/m² with fast growth. WS9 uses 550 from PD 7974-1, which wasn't checked here.
4. **Convective fraction.** C/VM2 uses a radiative fraction of 0.35, so convection is 0.65; WS9 6.23.2 assumes 0.70.
5. **Density ratios.** NIOSH gives chlorine 2.47 (spec 2.45) and propane 1.55 (spec 1.52). For NO₂, NIOSH's 2.62 reflects N₂O₄; molecular weight over air gives 1.59.
6. **`crush_density` 5.0 and `compression_fatal_s` 300 s.** Not confirmed. The public revised Fruin paper states about 7 p/m² and gives no minutes to asphyxia.

## Gaps (recorded in each file's `uncovered`)

- **Spread:** industrial, flammable-liquid, chemical and electrical fuel rows; HRR per m² for car parks.
- **Agents:** methane, town gas, hydrogen, and the ten Berge `toxic_load_n` for every agent.
- **Threats:** dense-gas plume tables; aircraft class bands, swath, penetration and fire-resistance factor; jet fuel properties; vehicle masses and barrier classes.
- **Movement:** crouch factor; crouch and reroute visibility; turn-back share; the 60 °C head-height limit; water depths; breathing heights.
- **Exposure:** the `compression` and `impact` rows. No public dose bands were found, so mapping them is a modelling decision for the reviewer.
- **Schema:** migrations 250 and 258 have no column for post-flashover yields, ISO 13571 constants, sprinkler RTI, or ppm-based limits (the movement `unit` list has no ppm).

## Confidence and caveats

- **High:** US government sources (EPA AEGL, NIOSH, NIST, FEMA, Turner) and open government codes (C/VM2, and Eurocode via EU JRC).
- **Medium:** values from paywalled handbooks and standards (SFPE, NFPA 68 and 92, ISO 13571) read through public previews or secondary sources that cite clause and page. ISO 13571 clauses 6, 8 and 9 were read in a publicly hosted national-adoption text whose licence is unclear, so confirm them against a licensed copy. I did not cite copies that looked pirated.
- **Low:** Fridolf's citation details, and Tobler.
- **Patch rows:** `spread-materials.pending.json` rows are patches. The null columns keep the 5.12.2 values, and the car-park row has a null HRR per m², so the 250 contents constraint fails until it's filled.

## Rules applied (WS9 6.27.10 and 9.8)

- Public sources only. No named site, operator, flight or person appears in any row.
- Hydrogen cyanide is kept only as the ISO 13571 fire-gas term, not as a release agent. Phosgene and all warfare agents are refused (listed in `refused`).
- No attack or tactics detail. Aircraft rows hold only the public-report fuel and fireproofing statements, with no approach, speed or targeting data. Vehicle rows hold only an injury-risk-against-speed curve, used in bands.
- Wherever a value isn't stated in a source it is listed in `assumed_fields` or `uncovered`; no value was filled in without a source.
