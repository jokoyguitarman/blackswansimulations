---
cursor:
  subagentId: "bc-00acc3e6-9284-5cbd-acd4-71e5b8340e7b"
---

# Building-hazard seeds for Singapore (PENDING review)

**Status: PENDING.** An agent drafted every row (`provenance.drafted_by: "agent"`). Every file has `review_status: "pending"`, so under AC9.81 `importApproved` skips it until a W24 reviewer marks rows approved. Nothing here is reviewed data.

The files follow WS9 (`docs/field-ops/11-living-world.md`): the four tables of migration 257 (section 5.15), the seed format of sections 5.12 and 5.19, `SeedProvenance` (section 5.18), and the agent rules of sections 6.19, 6.27.10, 8.5 and 9.8. Run id: `8b6a903f-4b01-52ef-acfb-e95876934d23`, recorded in `run.json`.

## Files

| File | Table | Rows | What it holds |
| --- | --- | --- | --- |
| `building-types.json` | `fieldops_building_types` (257) | 24 | Singapore building types mapped to WS3's place classes |
| `hazard-item-kinds.json` | `fieldops_hazard_item_kinds` (257) | 35 | Item kinds with category, phase, agent, stored pressure and flash point |
| `building-items.json` | `fieldops_building_items` (257) | 130 | What each type typically holds: location, quantity band, likelihood |
| `hazard-interactions.json` | `fieldops_hazard_interactions` (257) | 32 | Trigger, threshold, effect, delay and probability per item kind |
| `release-agents.json` | `fieldops_release_agents` (258) | 7 | Only the agents the rules name: propane, town gas, chlorine, ammonia, hydrogen fluoride, hydrogen and carbon monoxide |
| `sources.json` | `fieldops_knowledge_sources` (259) | 41 | Every cited source with URL, access date, terms and review-due date |
| `run.json` | `fieldops_seed_runs` (259) | 1 | Run manifest with counts, uncovered subjects and refusals |

**File format.** Each file has the section 5.12 header plus `library` and `provenance`, a `review` block for the reviewer's decisions, and `review_flags`. The `review_flags` map is keyed by row and lists that row's Assumed fields and any Unverified sources. Each row holds its table's columns (no ids, status, versions or timestamps), `source_keys`, `source_ref`, `source_note`, and a `provenance` block. The provenance block carries sources with locators, quotes of at most 25 words, a confidence level and `assumed_fields`. `review_flags` is a review aid, so strip it at import if `seedFileSchema` refuses unknown header keys.

**Checks run.** A local script mirrored migration 257/258's SQL checks: key patterns, ranges, enums, foreign keys to the spread materials, the unique `(type, kind, location)` constraint, the quantity, explosive-store, mitigation, release and delay constraints, and the tier and flammable-range pairing. It also applied the AC9.74 hygiene checks: every type has items, restricted items are `category_only` with `auto_place: false`, and no text names a site, street or postcode. Finally it confirmed every locator is at most 120 characters, every quote at most 25 words, and every agent a rule names is present. All files pass.

## Coverage

| Type | Items | Notes |
| --- | --- | --- |
| Shopping mall | 14 | Town gas, LPG manifold envelope, fryers, generator diesel, transformer, batteries, car park, sprinklers, smoke control |
| Hospital | 11 | Bulk liquid oxygen, oxygen cylinders, laboratory chemicals, diesel day tank and bulk tank, UPS |
| Office, hotel, data centre | 9 each | Data centre: lithium-ion UPS, lead-acid, diesel, gas suppression |
| Light industry | 8 | Flammable liquid store (factory exemption band), welding gases, LPG up to 1,000 kg, ammonia refrigeration |
| Condominium, school, warehouse, airport | 6 each | Warehouse: racked stock, cold-store ammonia, forklift charging |
| Rail station | 5 | Low confidence: the CPFPRTS was not accessed |
| HDB block, house, food centre, stadium, police or fire station | 4 each | HDB: town gas, domestic LPG (at most 30 kg), household mobility-device batteries, ground-level substation |
| Bus interchange, car park, electrical substation | 3 each | |
| Chemical process plant, military camp | 3 each | `restricted_generic`: category words only, no quantity, never auto-placed, no interaction rules |
| Place of worship, community centre, generic building | 2 each | Thin: only kitchens, sprinklers and switch rooms could be sourced |

All 21 of WS3's place classes map to a type. Bus interchange, food centre, data centre, electrical substation, chemical plant and military camp are reached by the trainer's choice only, as in WS9 5.19.

**Interaction rules.** 16 rules are carried from WS9 5.19's examples. 16 more were added, all triggered by fire exposure, ceiling temperature, power loss, flooding, structural damage or gas in its flammable range. No new overpressure threshold was added (D47).

## Confidence

| File | High | Medium | Low |
| --- | --- | --- | --- |
| Building types | 0 | 16 | 8 |
| Item kinds | 8 | 17 | 10 |
| Building items | 0 | 56 | 74 |
| Interaction rules | 0 | 6 | 26 |
| Release agents | 6 | 1 | 0 |

The physical properties are well sourced: flammable ranges, boiling points, vapour pressures, gas densities and AEGL tiers come from NIOSH, CAMEO, EPA and City Energy. The Singapore regulatory caps are also well sourced: LPG limits, the 700-litre generator-room diesel cap, the battery-room energy thresholds and caps, the petroleum classes and the occupant load factors. The weak points are the likelihoods and the rule timings:

- **Quantities.** Of the 64 items with a quantity band, 6 have both ends from a source and 21 have their upper end from a regulatory cap. The other 37 are Assumed. The remaining 66 items are `category_only`.
- **Likelihoods.** Every `likelihood_permille` is Assumed, because no public source gives the share of buildings holding an item.
- **Rule values.** Every rule threshold, delay and probability is Assumed, apart from fail-safe gas shut-off and the flammable ranges.

Nine sources were not accessed in this run: NFPA 855, NFPA 13, NFPA 30B, UL 9540A, CCPS 2010, SFPE Handbook, TNO Yellow Book, BRE BD 2552 and CPFPRTS. They are WS9 5.19's named references, listed with `accessed_on: null` and `access_status: "not_accessed_unverified"`. Rows citing them carry an Unverified flag, and the importer should refuse those sources until a reviewer checks the locators.

Six rows cite only these unaccessed sources, so they have no located source yet. A reviewer should source them or reject them:

- the `aerosol_stock` kind and its mall item;
- the rail station's sprinkler and smoke-control items;
- the `lpg_bank_blast_rupture` and `lpg_bank_fire_bleve` rules.

## Where the sources disagree with WS9 5.19's planning values

These items need a decision from the reviewer:

| Item | Spec 5.19 | Source | Seed uses |
| --- | --- | --- | --- |
| Mall oil-filled transformer location | basement | Fire Code Cl.3.2.5j(2): ground level against an external wall | `ground` |
| Generator diesel day tank | 500 to 2,000 L | Fire Code Cl.3.2.5j: at most 700 L in the generator room | 500 to 700 L; larger stocks moved to a `diesel_bulk_tank` kind |
| Data-centre lithium-ion UPS | 500 to 5,000 kWh | Fire Code Table 10.3.1: 20 kWh threshold, 600 kWh per compartment without prior SCDF approval | 20 to 600 kWh per compartment |
| Occupant densities | mall 3, HDB 25, school 2, station 0.5, stadium 0.5, data centre 50 | Table 1.4B: shop 5, apartment 15, classroom 1.5, station 1.5, grandstand 1.5, server room 30 | Table 1.4B design factors; peak-crowd figures are for the reviewer |
| Chlorine density ratio | 2.45 | NIOSH: 2.47 | 2.47 |
| `clinic` mapped to hospital | yes | Table 1.4A puts outpatient clinics and polyclinics in PG V (shop) | Kept; flagged |

## Gaps and open questions

- **Not seeded, by rule.** Concert pyrotechnics, ammunition quantities, process-plant inventories and military holdings are not seeded (WS9 9.8, D47). No document about a named site was used.
- **No values found.** The sources gave no values for storey heights (BCA codes not located), transformer kVA by type, hospital liquid-oxygen vessel sizes, cooking-oil flash point, sprinkler activation temperature (SS CP 52 not accessed), or station systems (CPFPRTS).
- **Flash points left null.** Diesel is Class III in Singapore: flash point above 60 °C and up to 93 °C (SCDF). `flash_point_c` is null for the diesel kinds because the source gives a band. CAMEO's 51.7 °C is US No. 2 fuel and was not used.
- **Exemption tables disagree.** The non-factory Class III exemption is 1,500 L on SCDF's page but 200 L on GoBusiness. Neither figure is used in a row, but a reviewer should confirm which is current.
- **Format questions for the spec owner.** WS9 does not say whether `building_tags` hold raw `building=*` values or `key=value` pairs, so they are left empty. It also does not fix the numeric scale for `structural_state` and `gas_in_flammable_range` thresholds. Here 2 means damaged, 3 means collapsed, and 1 means inside the range; these are Assumed.
- **Release agents.** `release-agents.json` is a subset of migration 258 so that the rules resolve. A full 258 agents run may supersede it.
- **Pipeline gaps.** `run_id` is generated locally because `fieldops_seed_runs` does not exist yet. `brief_hash` is null because the briefs folder does not exist yet.
