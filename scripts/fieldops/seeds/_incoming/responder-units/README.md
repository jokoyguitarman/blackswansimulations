---
cursor:
  subagentId: "bc-3f384388-df90-5e5a-b997-d94d793da8a7"
---

# Responder units and equipment, Singapore: PENDING seeds

**Status: PENDING, unreviewed.** Drafted on 22 Nov 2026 by the research agent (`drafted_by: "agent"`, `run_id: null`, because `fieldops_seed_runs` does not exist yet). Nothing here is reviewed. Every value is a planning value for the RTS layer until the W24 fire-service and police reviewers approve it (11 section 6.32).

## Files

| File | Rows | Table or format |
| --- | --- | --- |
| `unit-kinds.json` | 22 | `fieldops_unit_kinds` (migration 254, amended): SCDF road apparatus and the Changi airport foam tender |
| `unit-kinds-vessels.json` | 5 | Same shape, SCDF Marine Division. **Not importable**: `mode: "vessel"` fails 254's `CHECK (mode IN ('vehicle','foot'))` |
| `equipment.json` | 33 | `fieldops_equipment`: one stated capacity per row |
| `unit-equipment.json` | 34 | `fieldops_unit_equipment`: kind, equipment and quantity |
| `equipment-not-representable.json` | 6 | Evidence only: equipment the table cannot hold (robots, AED, drone, buggy, a duplicate monitor array) |
| `security-units.sg.json` | 18 | SPF and SAF units in the register `units` shape of 02 section 6.11.5 item 3 |
| `response-standards.sg.json` | 7 | `fieldops_response_standards` (11 section 6.33.1): published response targets, achieved shares and system size |
| `hospital-capacity.sg.json` | 24 | `fieldops_hospitals` with `fieldops_hospital_specialties` (15 rows with scope `hospital`) and `fieldops_capacity_aggregates` (9 rows), per 11 section 6.33.1 |
| `sources.sg.json` | 87 | `fieldops_knowledge_sources` rows (11 section 5.17) with access and review-due dates |

## Format

The branch defined the format during this task. Commit `932bf44` (D54, W56, task T9.50) added the tables `fieldops_unit_kinds`, `fieldops_equipment` and `fieldops_unit_equipment` to migration 254, and named the seed files `unit-kinds.json` and `equipment.json`. I pulled at the start (`8366b61`, no format yet), drafted against a proposed format, pulled again before finalising, found `932bf44`, and converted every file to the branch's format. The proposed format was dropped; none of it remains here.

- **File header** as in 11 section 5.12: `file`, `schema_version: 1`, `prepared_by`, `prepared_on`, `review_status: "unreviewed"`, plus `library`, `country` and `seed_status: "PENDING"`.
- **Row columns** are exactly 254's, without `status`, `row_version` or `updated_at`, as 11 section 5.12 requires. They include `source_keys`, `source_ref` (3 to 300 characters) and `source_note` (3 to 400 characters).
- **`provenance` on every row** is `SeedProvenance` (11 sections 5.18 and 5.19), with `drafted_by: "agent"` and located sources. It adds two lists: `unverified_fields` and `withheld_fields`.
- **`_review` on kind rows** holds the reviewer's evidence, which the importer drops:
  - `column_evidence`: for each NOT NULL column, its value and status, with its locator or its Assumed basis.
  - `context_values`: stated values with no column (mass, length, vehicle class, cage load, vessel speed, battery hours, decontamination cubicles).
  - The public role, the existing `UNIT_KINDS` value it maps to (`catalogue_kind`), and `proposed_kind` for kinds the catalogue lacks.
- **NOT NULL columns no source states** (`crew`, `default_count`, `turnout_s`, `observes_m`, `asset_type`) are filled from `UNIT_CATALOGUE` (11 section 5.10.1). This is the fallback AC9.119 already uses, and each fill is listed in `assumed_fields`; there are 127 fills in all.
  - Kinds the catalogue lacks (aerial appliances, the fire bike, vessels, industrial support, the airport tender) take `fire_engine`'s values and `default_count: 0`, so an unreviewed kind fields no unit by default.
  - These fills are placeholders, not estimates. The rescue jet ski's crew of 4 is the clearest example.
- **Equipment**: one capacity per row, using 254's categories and units.
  - A capacity no source states gets **no row**. A gap is never written as a number.
  - Platform monitor flows use category `pump`.
  - Aerial reach uses `aerial_platform`, except the AL56, which uses `ladder`.
  - Patients use `stretcher` (lying) and `patient_capacity` (seated or carried). MDV throughput uses `decontamination` in `p_h`.
- **Status of a stated value**:
  - `sourced`: an official SCDF, MHA, HTX, MOH, MINDEF, SPF, CAAS, Changi Airport Group or National Archives document states it.
  - `unverified`: only news, a builder's sheet or a third-party mirror states it.
  - `assumed`: a catalogue fill or a unit conversion.
- **Confidence** is per row, over the values it states:
  - `high`: every stated value is official.
  - `medium`: official and unofficial values are mixed.
  - `low`: nothing official is stated.

  Assumed fills do not lower confidence. Read `assumed_fields` for those.

Decisions for the owner: a water mode for vessels, and whether `responder_units` and `responder_equipment` join `KNOWLEDGE_LIBRARIES`.

## Coverage

| Subject | Kinds | Sourced values (official unless marked Unverified) |
| --- | --- | --- |
| Fire engines | Pump Ladder, Electric Pump Ladder, Red Rhino (5th and 6th generation), Fire Medical Vehicle, fire bike | Pump Ladder: 2,400 L water, 1,200 L foam, 4,000 L/min pump. E-PL: 2,000 L water, 400 L foam. LF6G: crew of 3. LF5G: 100 L foam, 2,000 L/min. FMV: 600 L water, 150 L foam, 2,000 L/min, 2 lying or 3 seated patients |
| Aerial | CPL34, CPL60, AL56, HLA90 | Reach 34, 60, 56 and 90 m. CPL60: 3,800 L/min monitor, 500 kg cage. HLA90 monitor (Unverified) |
| HazMat | HazMat Mitigation, HazMat Control, Mass Decontamination vehicles | Roles official. HCV crew of 3 and 5 km detector; MDV 24 carried and 80 per hour (all Unverified) |
| Rescue | Rescue Tender, FROST, DART Rescue Vehicle | Roles only. DRV crew of 8 (Unverified) |
| EMS | SCDF and private ambulances, Medical Support Vehicle | Ambulance crew of 3 (paramedic and two EMTs); Traffic Priority System saves up to 1 min 57 s |
| Marine | Red Sailfish, Red Manta, Red Dolphin, Rapid Response Fire Vessels, rescue jet ski | Sailfish: 240,000 L/min. Manta: 300 passengers, 35 kn. Dolphin: 30 kn. RFV: 40 kn, 7,083 L/min pump, 1,365 L foam |
| Industrial | Large Monitor Vehicle, Pod Carrier; MOTFS | 2,000 and 6,000 GPM monitors (litres per minute converted, Assumed US gallons); MOTFS 100,000 L/min foam |
| Airport | Changi AES foam tender | Respond in 2 minutes, never more than 3; fire under control within 1 minute; ICAO category 10 |
| Response times | 995 answering, fire/rescue, ambulance, airport | 10 s for 95% of calls; 8 min for 90%; 11 min for 80%; achieved ambulance shares 2014 to 2017; life-threatening cases within 8 min 82% (2018) and 82.1% (2019); 2023 "80%" (Unverified) |
| SPF | ERT, GRF, RDT, IRT, ProCom, PTU, STAR, K-9, CNU, PCG ERF, Gurkha Contingent | Public roles only |
| SAF | IDTF, CBRE DG, 36 SCE, 39 SCE, MRF, ADF, SOTF | Public roles only |
| Hospitals | Public acute beds (national 2023 to 2025; by region 2025); 11 public hospitals, 9 acute general, 8 public A&E (2020); 15 named hospitals (see Hospitals) | Bed complement, not surge |

Evidence totals, counted before the catalogue fills: 92 values `sourced`, 30 `unverified`, 2 `assumed` (unit conversions) and 93 `gap`.

## Gaps

- **Turnout times**: none published for any appliance; the catalogue's 60 to 120 s stay Assumed. Only the area-wide targets of 8 and 11 minutes are published.
- **Road speeds**: none published. `fieldops_unit_kinds` has no speed column, and WS9's road-speed classes apply.
- **Crew sizes** are Assumed for the diesel Pump Ladder, FMV, aerial appliances, Rescue Tender, FROST, HazMat Mitigation Vehicle, MDV, private ambulance, Medical Support Vehicle, the industrial kinds, the airport tender and four of the five vessels.
- **Sight range (`observes_m`)** is never published, so it is Assumed on every row.
- **Missing equipment rows**:
  - LF6G water and pump; E-PL pump.
  - Ambulance stretchers.
  - Airport tender water, foam and pump.
  - MDV lying-casualty rate.
  - Breathing apparatus, hose, cutting, thermal camera, lighting and shoring for every kind. The sources name them only generically.
- **Facility kinds**: `FACILITY_KINDS` has no marine base or airport fire station, so vessels and the airport tender start from `fire_station`, which is Assumed.
- **Values found only on Wikipedia or fan sites**: these are not recorded, only noted in `_review.notes`:
  - Pump Ladder hasty decontamination (4-minute set-up; 36 walking or 6 lying casualties per lane per hour)
  - DART crane 7.9 t
  - Red Rhino robot coverage 15 m²
  - Pumper Firefighting Machine 250 °C
  - FROST manpower
  - FMV crew of 4
  - A 2,200 L/min older Pump Ladder pump
- **Hospitals**: emergency department resuscitation bays, surge capacity and decontamination throughput are gaps everywhere. The 40 per-hospital "to verify" values are listed in each row's `assumed_fields`. Mount Alvernia and Farrer Park hospitals' 24-hour services appear only in a listicle, so they are not added.
- **Not covered**:
  - SCDF Command Vehicle and Forward Command Vehicle (found only on Wikipedia).
  - HazMat Support Vehicle, Chemical Tender, Lighting Tender, Foam Tender and Hose Laying Truck: they appear in station appliance lists with no public specification.
  - Unmanned Firefighting Machine variants.
  - The Changi airport hovercraft and sea rescue fleet.
  - Private-hospital emergency capacity.
  - Other countries.
- **Conflicts for the reviewer**:
  - Red Sailfish: SCDF says 240,000 L/min; the builder's total monitor capacity of 16,200 m³/h is 270,000 L/min.
  - Rapid Response Fire Vessel: 5,000 L/min (two monitors, annual report) against a 7,083 L/min pump (fact sheet). Both rows are kept; they measure different things.
  - MDV: 80 to 120 walking casualties an hour in one article, 80 walking and 18 incapacitated in another. Only the low end is kept, as Unverified.

## Hospitals

Added on 22 Nov 2026 at the user's request: real Singapore hospitals, named, with their specialties. D56 (11 section 6.33, commit `6108b37`) now allows named hospitals: "Real hospitals are named: they are public facilities". The rows follow the hospital shape of section 6.33.1.

**Scope.** Every public acute hospital with a 24-hour emergency department or urgent care centre:

| Cluster | Hospitals |
| --- | --- |
| SingHealth | SGH, CGH, SKH, KKH |
| NUHS | NUH, NTFGH, Alexandra (urgent care centre only) |
| NHG Health | TTSH, KTPH, Woodlands |

Plus the private hospitals whose 24-hour emergency or urgent care service an operator page states: Raffles (an emergency department), and Mount Elizabeth, Mount Elizabeth Novena, Gleneagles and Parkway East (urgent care centres).

**File header.** `library: "hospitals"`. `response-standards.sg.json` now carries `library: "units"`, as section 6.33.1 requires.

**Rows with `scope: "hospital"`** (15 rows; they map to `fieldops_hospitals` and `fieldops_hospital_specialties`):

- `key`, `label`, `country`.
- `name`.
- `ownership`: `public` or `private`.
- `cluster`: `SingHealth`, `NUHS`, `NHG Health`, or null for private hospitals. The source is HealthHub (`healthhub_clusters`).
- `acute`: always true. Private hospitals' value is Assumed.
- `emergency_department`: true for a 24-hour ED, including KKH's Children's Emergency and Raffles24 (Unverified). False for an urgent care centre only: Alexandra and the four Parkway hospitals.
- `location`: `[lat, lng]`, the OneMap building point (Singapore Land Authority), not the ED entrance.
- `osm_id`: null, to match against WS3's saved facilities at import.
- `specialties`: `[{ role, level, status, source_key, locator, note }]`.
  - Only stated specialties are listed. Negatives and gaps never appear here.
  - There is one entry per role, matching the table's primary key. Where two facts give one role, the sourced, higher-level one is kept and the other is named in `note`.
  - `level` is `national_centre`, `regional`, `service` or null. A self-described "Level 1" trauma centre gets level null, with the claim in `note`.
- `values`: `[{ param, value, unit, as_of, status, source_key, locator, quoted_phrase, note }]`, where `status` is `sourced`, `unverified`, `assumed` or `gap`.
  - Beds are `beds_{yyyy}`. A page with no date takes the access year, 2026, labelled Assumed in the note.
  - Woodlands' combined count is `acute_and_community_beds_2024`, so it does not fill `beds`. Unknown beds are `beds_latest` with status `gap`.
  - Other values: address, ED status, the location point, stated negatives (for example `maternity_delivery: false`), the "to verify" gaps, and the capacity figures (ED critical care and observation beds, burns ICU and high-dependency beds, PICU and paediatric high-dependency beds, delivery rooms, operating theatres, the hyperbaric chamber, ED attendances, NCID beds).
- `review_notes`, `seed_status: "PENDING"`, `provenance` (`SeedProvenance`).

**Roles stated:**

| Hospital | Specialties |
| --- | --- |
| SGH | burns_centre (national centre), trauma_centre (self-described Level 1), hyperbaric, decontamination, toxicology (Drug and Poison Information Centre, Unverified), obstetric, paediatric, neurosurgery |
| KKH | paediatric_emergency, obstetric, paediatric, neurosurgery |
| NUH | paediatric_emergency, trauma_centre (regional), toxicology, obstetric, paediatric |
| NTFGH | decontamination, toxicology |
| TTSH | trauma_centre (self-described Level 1), infectious_isolation (NCID, national centre), neurosurgery |
| CGH, SKH, KTPH, Woodlands | neurosurgery (National Neuroscience Institute sites) |
| Alexandra and the private hospitals | none stated |

No source located for any hospital's `cardiothoracic`, `spinal`, `ophthalmology` or `psychiatric` role. All four are to verify.

**Other rows.** The five aggregate rows and four network facts keep their own scopes (`hospital_ed`, `national_network`), so the importer stores them as `fieldops_capacity_aggregates`:
- 24/7 toxicology consultations across public hospitals.
- Inpatient obstetrics, gynaecology and paediatrics centralised at KKH, NUH and SGH.
- MOH's minimum trauma standards.
- The National Neuroscience Institute's sites.

**Status values.**
- `sourced`: an official page states it.
- `unverified`: only an operator page, a 2005 article or the news states it.
- `assumed`: inferred, with the basis in `note`; for example "no burns centre" elsewhere, because SGH's is the only one.
- `gap`: not found ("to verify"); the value is null.

Every stated value carries a `quoted_phrase` of at most 25 words.

A value given as "over N" is recorded as N and flagged as a lower bound in its note.

**Key findings:**

- **Burns:** SGH's Burn Centre is the only specialised burns facility, with 6 critical-care and 10 high-dependency beds.
- **Hyperbaric:** SGH's Hyperbaric & Diving Medicine Centre, run with the Navy, gives 24-hour diving-emergency care.
- **Decontamination:**
  - SGH says it has the only semi-automatic decontamination centre in Singapore.
  - NTFGH says its ED is decontamination-ready.
  - A 2026 *Singapore Medical Journal* review speaks of semi-automated decontamination facilities, plural.
  - Other hospitals are "to verify".
- **Maternity and inpatient paediatrics:** public services are only at KKH, NUH and SGH (MOH, 2023).
- **Paediatric emergencies:** 24-hour departments at KKH and NUH. NTFGH transfers children under 12 to NUH.
- **Trauma:**
  - MOH publishes no designation of trauma-centre levels.
  - SGH and TTSH describe themselves as Level 1.
  - NUH leads the western regional trauma system and handled 29% of national trauma in 2024.
  - TTSH and NUH both claim the highest trauma load.
  - All public hospitals open in 2016 met MOH's minimum trauma standards.
- **Neurosurgery:** the National Neuroscience Institute operates at SGH, CGH, SKH, KKH, TTSH, KTPH and Woodlands. NUH's neurosurgery is "to verify".
- **Infectious diseases:** the National Centre for Infectious Diseases (330 beds) is at TTSH.
- **Beds (official pages, with dates):**
  - SGH 1,931; TTSH over 2,000; NUH 1,289.
  - CGH over 1,000; SKH 1,000 (planned in 2018).
  - KKH 830; KTPH 795; NTFGH 700; Alexandra 326 (2018).
  - Woodlands 430, acute and community combined (May 2024).

**Conflicts for the reviewer:**

- SGH's hyperbaric chamber: 14 patients (MINDEF, 2009) against over 20 (Navy).
- KKH beds: 830 (official) against 864 (seen only through Wikipedia).
- The trauma-load claims of TTSH and NUH.
- The Drug and Poison Information Centre at SGH (2005 article): current status to verify.

## Policy applied

- **SPF and SAF**: names, archetypes, public roles and public sources only, under 02 section 6.11.5 item 3 and 11 section 6.19's agent rules. No strength, crew, location, vehicle, equipment, call sign or tactic is recorded, even where a public page states one (the PTU's size; the tactical vehicles at NDP 2017). These appear in `withheld_by_policy`, not as gaps, and the file holds no `fieldops_unit_kinds` rows for police or military units. The catalogue's `patrol_car`, `tactical_team`, `military_section`, `cbrn_team` and `eod_team` stay Assumed.
- **SCDF and airport rows**: public specifications only. Per-station appliance counts, commanders' names and station names are left out. The SCDF Departments & Units page is cited only to show that an appliance type exists.
- **News and builders' sheets**: never the sole basis of a `sourced` value (02 section 6.11.3 rule 3). Wikipedia and Reddit were used only to find official documents.
- **De-identification**: the NDP 2017 fact sheet carries a press contact's name and mobile number. Neither was copied.
- **Review dates**: `next_review_due` is 365 days after access, and 180 days for SPF and SAF sources (treated like doctrine sources).

## Confidence

| File | High | Medium | Low |
| --- | --- | --- | --- |
| `unit-kinds.json` | 7 | 5 | 10 |
| `unit-kinds-vessels.json` | 2 | 2 | 1 |
| `equipment.json` | 25 | 1 | 7 |
| `security-units.sg.json` | 17 | 1 | 0 |
| `response-standards.sg.json` | 4 | 3 | 0 |
| `hospital-capacity.sg.json` | 17 | 2 | 5 |

Low kind rows are those whose only figures come from news or builders, or whose row rests on a role alone (Rescue Tender, FROST, HazMat Mitigation Vehicle, MDV, DART Rescue Vehicle, private ambulance, Medical Support Vehicle, industrial kinds, jet ski).

## For the reviewer

1. Check each `sourced` value at its locator. The NDP fact sheet's page numbers are PDF page indices.
2. Decide on each `unverified` value: find an official source, keep it labelled Unverified, or reject it.
3. Replace or accept every catalogue fill in `assumed_fields`, the placeholders for new kinds above all.
4. Decide on a water mode for vessels.
5. Match each hospital to WS3's `osm_id`, confirm the access-year bed dates, and confirm the trauma, toxicology and decontamination roles.
