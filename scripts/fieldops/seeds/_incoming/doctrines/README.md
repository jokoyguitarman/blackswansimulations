---
cursor:
  subagentId: "bc-506688cd-4130-594d-bd1d-025e3166eb27"
---

# Doctrines and agency registers, Singapore: PENDING seeds

**Status: PENDING, unreviewed.** Drafted on 22 Nov 2026 by the research agent (`drafted_by: "agent"`, `run_id: ff05c013-b19a-4637-9e2d-3a120a489e9f`, which has no `fieldops_seed_runs` row because the table does not exist yet). Every file has `review.status: "pending"`. Nothing here may be imported or shown to a trainer until a person reviews it (02 sections 6.11.3, 6.11.5 and 6.11.8; 11 section 6.19).

Formats follow 02 (`02-teams-and-doctrines.md`) sections 5.4, 5.4.2, 6.3 and 6.11.2 on branch `cursor/no-research-knowledge-libraries-1b47` at `8948df1`. Only Singapore is covered; Malaysia and the other countries were not started.

## Files

| File | What it holds |
| --- | --- |
| `sg/agencies.json` | `fieldops_agency_register_v1`: 14 agencies, 22 units, with aliases and located sources |
| `sg/<agency_key>.<archetype>.json` | 17 `fieldops_doctrine_seed_v1` files (`provenance.kind: "official_public_source"`) |
| `playbook-review.pending.json` | D55 review of the six generic playbook seeds |
| `run.json` | Run manifest: counts and the 42 distinct source URLs |

The folder mirrors `scripts/fieldops/seeds/sea/SG/` (lower-case `sg/` here).

### Extra fields

The spec's zod schemas are `.strict()` and don't yet have the D39 fields that 6.11.6 and 11 section 6.19 require. The seeds carry them anyway, so `checkSeedFolder` will refuse the files until the schemas are amended (see the spec issues below):

- `provenance.drafted_by`, `run_id`, `confidence`, `assumed_fields`, and `claims`, which maps each step, never-do and hand-off id to its source index and locator. An index of `-1` means a register entry.
- `locator` and `quoted_phrase` on each source. Quotes are verbatim and at most 25 words.
- On the register: `drafted_by`, `verify` (`located` or `to verify`) and `verify_note` on each agency and unit, plus a top-level `provenance`.
- On every review block: `review.reviewer_role`, `required_reviewer_roles` and `history`.

## Coverage (Singapore)

| Agency (register key) | Archetype seeded | Use of force | Confidence | Main sources |
| --- | --- | --- | --- | --- |
| SPF (`sg_spf`) | police_security | yes: presence, verbal, physical_control, lethal | medium | PFA 2004 ss. 4, 26; CPC 2010 ss. 57, 58, 63, 75, 76; POSSPA 2018 ss. 8, 11, 16 to 26; IPA 2017 ss. 22, 23; MHA PQ 26 Feb 2021 |
| SPF (`sg_spf`) | evacuation_crowd (`stampede_crush`) | no | high | MHA PQ on crowd surges, 28 Nov 2022 |
| SPF Special Operations Command (`sg_spf_soc`) | tactical_response | yes (the SPF block) | low (thin by design) | SPF Our People; CPC; POSSPA |
| SPF CID (`sg_spf_cid`) | pursuit_investigation | no | medium | SPF Our People |
| SCDF (`sg_scdf`) | fire_rescue, medical_triage, incident_command | no (none published) | medium | CDA 1986 s. 4; SCDF About; SCDF Training Directory; IFAS Plus |
| SAF (`sg_saf`) | military_support | yes: `military_rules_of_engagement`, civil_support | medium | SAF Act ss. 201B to 201G; CPC ss. 59 to 61; MINDEF IDTF and ADF factsheets |
| SAF (`sg_saf`, unit 36 SCE) | bomb_disposal_eod | no | low | Pioneer 2023; Singapore Army; Cyberpioneer 2003 (archived) |
| SAF (`sg_saf`, CBRE DG) | cbrn_defence | no | low | MINDEF factsheets 2003, 2015, 2023 |
| MOH (`sg_moh`) | hospital_ed | no | medium | MOH PQ 10 Jan 2018; MOH Ambulance Diversion |
| MHA (`sg_mha`) | ministry_liaison | no (legal authorities only) | medium | MHA Ministerial Statement 7 Apr 2026; POSSPA s. 8; IPA s. 58 |
| LTA (`sg_lta`) | transport_operator | no | high | LTA rail framework; LTA Exercise Greyhound 2026 |
| PUB (`sg_pub`) | utilities | no | high | PUB Flood Response; Flood Forecasting |
| NEA (`sg_nea`) | utilities (Assumed) | no | low | NEA EPD Report 2013; NEA Safety Audit Guidelines |
| Changi Airport Group AES (`sg_cag_aes`), site-specific | fire_rescue (`aircraft_impact`): aircraft rescue and firefighting, crash response, Airport Emergency Plan, sea rescue, SPF and SCDF interface | no | medium | CAG Airport Safety & Security; ANR-139 (S 10/2023) regs. 35, 36, 46, 47; AIP AD 2 WSSS 2.6; CAG release 17 Oct 2024; SPF APD |
| CAAS (`sg_caas`) | transport_operator (Assumed; `aircraft_impact`) | no | medium | CAAS Act 2009 s. 7(1); CAAS aerodrome safety page |

**Register-only entries (no doctrine seed):** SMRT and SBS Transit.

**Units recorded:**

- SPF: ERT, IRT, ProCom, TransCom, Gurkha Contingent, PCG, Airport Police Division and SOG.
- SPF Special Operations Command: PTU, STAR, K-9 and CNU.
- SCDF: DART, HazMat specialists and EMS.
- SAF: IDTF, ADF, SOTF, CBRE DG, 36 SCE, 39 SCE and MRF.

Units hold only a public name, archetypes, a one-sentence public role and sources. Strengths, locations, equipment, call signs and tactics are left out (6.11.5 item 3). SPF and SAF unit keys match the sibling file `../responder-units/security-units.sg.json`.

**6.11.1 exit rule:**

| Archetype | Status |
| --- | --- |
| police_security | Seeded |
| fire_rescue | Seeded |
| medical_triage | Seeded |
| bomb_disposal_eod | Seeded, but cordon, communications discipline and all clear are recorded as gaps |

So Singapore meets the exit rule once the files are reviewed.

## Gaps (recorded, never filled)

| Gap | Sources searched | Note |
| --- | --- | --- |
| SCDF fire-ground powers (entry, cordon at a fire) | FSA 1993 Parts 2 to 7 headings; CDA 1986 Parts 2, 5, 6 | Provision not located; FSA ss. 29, 30 headings seen but not read |
| SPF `less_lethal` level | SSO (PFA, CPC, POSSPA); MHA PQ 2021 | No official statement located; see spec issue 7 |
| EOD cordon, communications discipline, all clear | MINDEF, Army, Pioneer, SPF | The 2023 sources that state "SPF enforces the cordon determined by the EOD team" are about one named site; excluded under WS9 6.19 |
| SCDF escalation tiers (basic and enhanced task force, Ops CE) | SCDF publications | Only located in a case study of one named incident; excluded |
| MOH on-site medical command (DSMC) and P1 to P3 triage | MOH newsroom | Only in journals, which can't stand as a source (6.11.3 rule 3) |
| Media & Communications (SG) | POSSPA s. 2, s. 30 headings; SGSecure | s. 30 communications stop orders not read in full; no seed drafted |
| AES to SCDF command transfer; SPF role at a crash site | CAG, CAAS, SPF, SCDF | Not stated publicly; the AES seed's hand-off triggers are Assumed |
| Aircraft impact into a building away from the airport | SCDF, CAAS | Falls to SCDF's seeds; no aviation-specific SCDF source located |
| Phase 1 agencies of 6.11.7 not covered | not searched | HDB and town councils, Energy Market Authority and the town gas operator, MOM, SP Group, BCA, RSAF, venue operators |
| Public Order Act notification provision | MHA PQ 2022 (names the Act only) | Provision field left null, "to verify" |
| SCDF alias "995" | SCDF pages | Not stated in any official page read; "to verify" |
| Malaysia and the rest of ASEAN | not started | Out of time; Malaysia is next per `SEA_SEED_COUNTRIES` |

## Changi AES and CAAS (site-specific, added 22 Nov 2026)

- **AES seed:** seven steps. The two time targets (arrive within 3 minutes, fire under control within a minute of arrival) are CAG's own published targets and also appear in `good_looks_like`. The 4-minute figure for fire control is derived (3 + 1) and listed as Assumed.
- **Command:** the AES manages the Airport Emergency Plan and takes charge of rescue, firefighting and crash-site operations. ANR-139 reg. 46 requires a crisis management operations centre and a mobile command post.
- **Hand-offs:** to the SPF Airport Police Division (now a unit in the register), SAF EOD, the SCDF Incident Manager and MOH. Their triggers are Assumed: no public source states when AES hands command to SCDF.
- **Scope:** Changi aerodrome and its vicinity only. AES also serves Seletar and RSAF airbases, but RSAF airbases are Government aerodromes outside ANR-139.
- **CAAS seed:** restates its statutory functions only (search and rescue coordination, cooperation with TSIB, aerodrome oversight).
- **Reviewers:** the AES seed asks for an aviation rescue and firefighting reviewer as well as the country reviewer.

## Confidence and what to check first

- **High:** SPF crowd, LTA and PUB. Each restates a single recent official page step by step.
- **Medium:** SPF police_security, SAF military_support, SCDF, MOH, Changi AES and CAAS. The law was read at the provision itself, but step order and hand-offs are partly Assumed (listed in `assumed_fields`).
- **Low:** SOC tactical_response (thin by policy), SAF EOD and CBRE DG (the step source dates from 2003 and is an archived copy), and NEA (2013 source, Assumed archetype).
- **Use-of-force blocks:** three seeds have them (SPF, SPF SOC, SAF). Each needs a `legal`, `police_service` or `military_service` reviewer (AC1.59). Bomb-disposal seeds also need the D22 reviewer.
- **Terms of use:** not checked for any source. Every `terms_note` says so (open question 12).
- **Quotes:** none is about tactics or device construction. Equipment named in MINDEF and SPF pages (vehicles, weapons, robots, disruptors) was read but not transcribed.

## Playbook review findings (D55)

Details are in `playbook-review.pending.json`. All six seeds are generic and US- or UK-flavoured, and cite no source. I propose amending each and retiring none.

1. **Evacuation & Crowd.**
   - The worked example uses Sydney coordinates `[-33.889, 151.274]`; remove them.
   - The 60 people/min exit flow and the 1:20 marshal ratio are unsourced.
   - In Singapore, cordons and access control are police powers (PFA s. 26, POSSPA s. 18).
   - "Stop the evacuation if stampede risk" contradicts MHA's published guidance, which is to give space and clear exit instructions.
2. **Fire & Rescue.**
   - The PPE Levels A to D are the US EPA/OSHA scheme, and "Class C = electrical" is the US NFPA scheme. Singapore follows the European classes, to verify.
   - The ERG is a North American guidebook.
   - "Only fire and rescue enter the hot zone" is wrong for a bombing, where SAF EOD and police tactical units also have roles. The same line is in 02's own example seed (`nv_hotzn1`).
3. **Medical Triage.**
   - The START algorithm is incomplete: the "breathes after airway repositioning, so Immediate" branch is missing.
   - It includes clinical dosing (Parkland formula, crush drugs) and nerve-agent antidotes. Warfare agents are barred by WS9 6.27.10, so remove these.
   - The triage team chooses hospitals itself, whereas in Singapore MOH coordinates casualty distribution.
4. **Media & Communications.**
   - "Never omit numbers" contradicts "don't speculate on casualties"; it is a validator rule.
   - It misses Singapore's POSSPA s. 30 communications stop orders.
5. **Pursuit & Investigation.**
   - It merges investigation with tactical and negotiation work, which in Singapore sit with STAR and the CNU.
   - It calls EOD a "forensic team", but EOD is the SAF's 36 SCE.
6. **Bomb Disposal / EOD.**
   - The responder in Singapore is the SAF (36 SCE, "the only national responder to any explosive threat"), not a police bomb squad.
   - The source text gives render-safe technique selection by container type, the reason for the communications blackout, and tool lists. These are device-defeat detail. Don't transcribe or quote them, even in review packs.
   - The 150 m staging distance and the 2-minute detonation are unsourced or game mechanics.

## Spec issues found while drafting (for the coordinator)

1. **Strict schemas.** `SeedSourceSchema`, `DoctrineSeedFileSchema` and `AgencyRegisterFileSchema` (02 section 6.3) are `.strict()` and lack `locator`, `quoted_phrase`, `drafted_by`, `run_id`, `confidence`, `assumed_fields` and `review.reviewer_role`. AC1.59 and 6.11.6 require these fields, and 6.11.8 also requires `review.history`. As written, the schema refuses every agent-drafted file.
2. **Missing labels.** `ARCHETYPE_LABELS` (02 section 5.1) has no labels for `tactical_response`, `military_support` or `cbrn_defence`, so the title rule "{agency}: {archetype label} response" is undefined for them. These files use "Tactical Response", "Military Support" and "CBRN Defence" (Assumed).
3. **Incident type keys.** `INCIDENT_TYPE_KEYS` in 5.1 still lists only the bombing and stopped types, while AC1.63 expects `applies_to: ["stampede_crush"]` to validate. The two seeds that use D46 keys (`stampede_crush`, `chemical_release`) will fail until 5.1 is updated.
4. **Bomb disposal register row.** The Singapore row ("SPF or the SAF EOD units") resolves to the SAF on MINDEF's own statement. The spec models CBRE DG and SOTF as separate register rows; here they are units of `sg_saf` (Choice 25).
5. **Archetype limit.** `archetype_keys` allows at most 3 per agency, so SPF is split into `sg_spf`, `sg_spf_soc` and `sg_spf_cid`, as the 6.11.1 table already does.
6. **No utilities agency type.** `AGENCY_TYPES` has no utilities type, so PUB and NEA are typed `other`. No archetype fits an environmental regulator such as NEA.
7. **Omitted force levels.** Under 5.4.1, an omitted level projects as not authorised, which would tell AI agencies that SPF may not use less-lethal force. Suggest a distinct "not stated" projection, or a required review sign-off, before any police block is imported without `less_lethal`.
8. **Named-site rule (resolved for Changi).** The user approved site-specific doctrines on 22 Nov 2026, so `sg_cag_aes.fire_rescue.json` uses CAG's own pages. WS9 6.19 and AC9.81 still refuse site-named rows, so the spec needs an exception before `validateAgentRows` will accept this file. The exclusions recorded in the gaps above (SCDF escalation tiers, EOD cordon) were not revisited.

## Provenance

Statutes were read on Singapore Statutes Online at the provision itself, with every locator checked against the text. Agency pages were read on the agencies' own sites. News articles, encyclopaedias and journals were used only to find sources, never as sources. Fetching SSO was throttled for some Acts, so CDA Parts 3, 4, 7 and 8 and FSA Parts 1, 8 and 9 were not read; this is the reason for the fire-ground powers gap.
