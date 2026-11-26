# Fire engine validation suite

`frontend/tests/fireValidation.test.ts` runs in `npm test`. `frontend/tests/fireValidationSlow.test.ts` skips itself unless `RUN_SLOW_TESTS` is set. It runs nightly (`.github/workflows/nightly-slow-tests.yml`) or locally with `npm run test:slow`.

The tolerances are Decision 5 of the realistic-fire roadmap:

- Upper-layer temperature rise within 20%.
- Interface height within 0.2 m or 15% of the ceiling, whichever is larger.
- Door mass flow within 25%.
- Time to flashover within 20%. Flashover is a 600 °C upper layer or 20 kW/m² on the floor.

A case outside its tolerance is an expected failure, listed under Known gaps below. Its test asserts two things: the case is still outside the tolerance, and the model still gives the recorded number within a pin. If a fix brings the case inside the tolerance, or a regression moves the number, the test fails. Then update this file.

The layer is compared with the measurement, not with a CFAST run. Measured rises are taken above the extract's first lower-layer temperature. The model's ambient is 293 K, so only rises are compared. Each value is a mean over the extract rows inside the case's window.

## Provenance

The measured layers are NIST's reduced layer files from [firemodels/exp](https://github.com/firemodels/exp) at commit `a9511fc4f56c3ae125d1d090e3be08e76959e856`. Each CSV here repeats its source, file and commit in its `#` header. The rows are unchanged; only whitespace was removed. The geometry, linings and fire curves in `cases.ts` are copied from the CFAST validation inputs in [firemodels/cfast](https://github.com/firemodels/cfast) at commit `b86959775ec32c5f3d95580cc0e3da2135da20ee`. Both repositories are NIST-developed, are not subject to US copyright, and are acknowledged here as the source.

| Extract                    | firemodels/exp file                         | CFAST input                          | Window                           |
| -------------------------- | ------------------------------------------- | ------------------------------------ | -------------------------------- |
| `nbs-mv100a-fire-room.csv` | `NBS_Multi-Room/NBS_MV100A_Tree1_layer.csv` | `Validation/NBS/MV100A.in`           | 300–880 s                        |
| `nbs-mv100a-corridor.csv`  | `NBS_Multi-Room/NBS_MV100A_Tree4_layer.csv` | `Validation/NBS/MV100A.in`           | 300–880 s                        |
| `nist-nrc-be3-test03.csv`  | `NIST_NRC/NIST_NRC_Test_03_layer.csv`       | `Validation/NIST_NRC/NIST_NRC_T3.in` | 600–1200 s (nightly: 300–1379 s) |
| `vtt-be2-case1.csv`        | `VTT/BE2_Case_1_layer.csv`                  | `Validation/VTT/VTT_C1.in`           | 180–420 s                        |
| `vtt-be2-case2.csv`        | `VTT/BE2_Case_2_layer.csv`                  | `Validation/VTT/VTT_C2.in` (nightly) | 180–360 s                        |

Steckler uses the published values already in `twoZone.test.ts`: Johansson and van Hees (IAFSS 2014, Table 3) for the interface and the rise, and NBSIR 82-2520 for the full-door centre run (outflow 0.571 kg/s, inflow 0.554 kg/s, neutral plane 1.027 m).

These parts of the setup differ from the tests:

- **Vents.** Single-room cases vent to ambient. The NBS fire room opens into the entry in `MV100A.in` (1.02 m × 1.03 m × 2.00 m, Marinite walls and ceiling, gypsum floor, a 0.81 m × 1.6 m door each way). The fire-room door uses that entry's layer as the other side of CFAST Eq. 4.1, and the leaving gas is the entry's door jet. The entry's other door opens to ambient. Continuing the jet into the corridor drops that corridor's interface to the floor, which is the receiver limit under FV-4, and the filled corridor then puts the fire-room interface at 0.619 m. The measured corridor interface is 1.32 m, so the fire-room case does not use that layer as the far side. The corridor comparison itself still runs on the stud plan (FV-4). That entry gauge is set only in `runNbsFireRoom`. `SpatialEffectsEngine` never sets `Vent.outside`, so FV-3 passes only with a coupling production does not use yet. A production door, including the Harbour shop into the mall, still vents against ambient. Once FV-4's receiver limit is fixed, check the fire room again with the corridor on the far side of the entry.
- **The target-room door.** The corridor's 0.79 m × 2.04 m door to the target-room entry is left out. In MV100A it is shut for the whole test (CFAST `WallVent_4` and `WallVent_5` have open fraction F = 0 at all times; the title is "No Target Room").
- **Burner position.** The NBS burner stands 0.1 m from a wall. The plume stays free. CFAST's technical reference does not apply a wall correction: McGrattan, NIST TN 1984, found no significant effect of a wall on entrainment. The VTT pan stands 1 m above the floor (the CFAST `HEIGHT`), and Heskestad's z is measured from the pan. Entraining from the floor instead puts Case 1 at 3.76 m and 34.7 K. From the pan it is 4.65 m and 36.0 K.
- **VTT geometry.** The hall's cross-section is the `CROSS_SECT` rows of `VTT_C1.in` and `VTT_C2.in`: 372.6 m² from the floor to the 12 m eaves, a pyramid to 51.3 m² at 17.1 m, and 51.3 m² up to the 19 m monitor (CFAST user's guide §4.4). The steel stays the hall's real surface. Carrying the floor area up to the ridge was 4.65 m and 36.0 K on Case 1, and 4.02 m and 57.2 K on Case 2.
- **VTT steel.** The shell is 1 mm and stores about 3.3 kJ/m²K. Against the two films that is on the order of two minutes, and both windows open while the shell is still warming. The sheet is one temperature, ρ c δ dT/dt, with the inside film and χQ/A warming it and CFAST's exterior film cooling the back. A heat-free sheet, the same films with no capacity, was 42.3 K and 67.2 K. A board keeps k/δ to ambient. The Biot gate that chooses a sheet is this engine's choice: CFAST applies the exterior film to every wall. The gate uses 4σT³ at ambient, the weakest film, so it is permissive. 6 mm glass crosses it. A glass-walled room is disclosed in Decision 10. The sheet temperature is stored by wall id. A sheet no layer is stepping cools toward ambient through both films. A partition two layers share is integrated once, from both gases. The fallout model keeps its own pane temperature: it is the local point source and it freezes at the crack, while the sheet is the wall-average χQ/A the gas is charged. One temperature would either drop that crack or count the flame's radiation twice. Glass is taken as opaque: short-wave radiation a real pane would transmit outdoors is absorbed with χQ/A, and that transmission is a known gap.

## Results

`fireValidation.test.ts` and `fireValidationSlow.test.ts` print each row as a `PASS` or `EXPECTED FAILURE` diagnostic.

| Case                                            | Metric                       | Model                   | Target                                        | Tolerance                | Result                         |
| ----------------------------------------------- | ---------------------------- | ----------------------- | --------------------------------------------- | ------------------------ | ------------------------------ |
| NUREG room                                      | Layer flashover heat release | 2353 kW                 | 1625–2366 kW (Thomas to MQH; Babrauskas 1909) | band                     | pass (nightly)                 |
| NUREG room                                      | Flashover latch              | 1000 kW                 | 1625–2366 kW                                  | band                     | FV-2                           |
| NUREG room, slow / medium / fast / ultrafast t² | Time to flashover            | 869 / 465 / 246 / 130 s | MQH clock 860 / 464 / 251 / 136 s             | ±20%                     | pass (fast in CI, all nightly) |
| Steckler                                        | Interface                    | 1.18 m                  | 0.985 m                                       | ±0.32 m                  | pass                           |
| Steckler                                        | Rise                         | 113 K                   | 98.2 K                                        | ±20%                     | pass                           |
| Steckler                                        | Neutral plane                | 1.23 m                  | 1.027 m                                       | ±0.32 m (interface band) | pass                           |
| Steckler                                        | Door outflow                 | 0.385 kg/s              | 0.571 kg/s                                    | ±25%                     | FV-1                           |
| NBS MV100A fire room                            | Interface                    | 0.745 m                 | 0.948 m                                       | ±0.32 m                  | pass                           |
| NBS MV100A fire room                            | Rise                         | 220 K                   | 242 K                                         | ±20%                     | pass                           |
| NBS MV100A corridor (engine plan)               | Interface                    | 1.13 m                  | 1.32 m                                        | ±0.37 m                  | pass                           |
| NBS MV100A corridor (engine plan)               | Rise                         | 33.4 K                  | 80.2 K                                        | ±20%                     | FV-4                           |
| BE#3 Test 3                                     | Interface                    | 1.11 m                  | 0.951 m                                       | ±0.57 m                  | pass                           |
| BE#3 Test 3                                     | Rise                         | 189 K                   | 192 K                                         | ±20%                     | pass                           |
| VTT Case 1                                      | Layer forms                  | yes                     | yes                                           | —                        | pass                           |
| VTT Case 1                                      | Interface                    | 4.50 m                  | 5.13 m                                        | ±2.85 m                  | pass                           |
| VTT Case 1                                      | Rise                         | 42.5 K                  | 48.2 K                                        | ±20%                     | pass                           |
| VTT Case 2                                      | Interface                    | 3.89 m                  | 4.60 m                                        | ±2.85 m                  | pass (nightly)                 |
| VTT Case 2                                      | Rise                         | 66.9 K                  | 77.6 K                                        | ±20%                     | pass (nightly)                 |

## Known gaps

### FV-1

**Steckler doorway flow.** The coupled steady outflow is 0.385 kg/s against the measured 0.571 kg/s, which is −33%. The 25% band runs from 0.428 to 0.714 kg/s. The test pins the outflow at 0.392 ± 0.03 kg/s. The same root is an interface of 1.18 m and a rise of 113 K, both inside their bands, and a neutral plane of 1.23 m against the measured 1.027 m. That plane is 0.20 m high. Decision 5 has no band for the neutral plane, so the pass borrows the interface height band, ±0.32 m. The regression pin is 1.229 ± 0.02 m. Roadmap: Decision 7, "Known gap: the Steckler doorway flow".

The three numbers are one mass-flow deficit. Heskestad at the measured 0.985 m entrains 0.301 kg/s. The orifice held at that height is 0.539 kg/s when the layer is at the model's 133 K rise for that height, and 0.498 kg/s when the layer is at the measured 98.2 K rise. The neutral plane on those two holds is 1.09 m and 1.10 m. Both flows are inside 25% of 0.571 kg/s, and both planes are within 0.08 m of 1.027 m. The coupled root is the height where the plume and the door are equal, at 0.385 kg/s and 1.18 m. A smaller mass flow is a hotter layer, which is the 113 K.

Inflow between the interface and the neutral plane is 0.010 kg/s at the coupled root and 0.037 kg/s at 0.985 m. That is the band a slice beside the upper layer would join (CFAST TN 1889v1 Fig. 4.1). It leaves the door about 0.2 kg/s short. McCaffrey's three-region plume, coupled the same way, is about 0.42 kg/s. The inverse door jet (CFAST Eq. 4.7, Cm = 0.44) entrains about 0.005 kg/s at this interface and moves the outflow from 0.385 kg/s to 0.381 kg/s. NBSIR 83-2801 gives opening coefficients of about 0.68 in and 0.73 out. This orifice uses CFAST's 0.7. The held-interface flow is already inside 25%, so the coefficient is not the remaining third.

NBSIR 82-2520 measured the entrainment directly. Fires near a wall agree with a free plume. For a corner the report notes some interference by the walls. Fires away from the walls, except the smallest openings, entrain two to three times a free plume, because the doorway inflow tilts the plume the way a cross wind does. Quintiere, Rinkinen and Jones (Combustion Science and Technology 26, 1981, 193–201) recover a tilted plume by using an entrainment length Z/sin θ, with θ the angle from the horizontal. Steckler did not measure θ on these runs. A factor chosen so this centre burner hits 0.571 kg/s would be a fit to one row, and the same report's wall fires match the free plume. The plume stays Heskestad. The gap stays this pin.

### FV-2

**The 1 MW flashover latch.** `FLASHOVER_ROOM_KW` lights every fuelled stud in a room once the burning fuel sums to 1000 kW. In the NUREG room that is below all three correlations: Thomas 1625 kW, Babrauskas 1909 kW and MQH 2366 kW. The layer alone reaches the flashover definition at 2353 kW, which is inside the band. Pinned at 1000 kW. Roadmap: Decision 8, where the 1 MW latch still ignites the fuel and is described as a stand-in.

### FV-4

**Corridor rise from a door jet.** The upper-layer gas that leaves a vent is deposited in the next room: mass at the source temperature, so the enthalpy is m cp (T_jet − T) and the interface falls by m / (ρ(T_jet) A). That is the vent flow changing rooms. A room with no fire of its own can hold a layer. A room that already has a fire keeps its own vent balance and does not take a second copy of the neighbour's jet.

The measured corridor layer is 1.32 m with an 80.2 K rise. On the engine plan the interface is 1.13 m, inside ±0.37 m, and the rise is 33.4 K, −58%, outside 20%. The rise is pinned at 33.4 ± 1 K. Roadmap: "What to reproduce", the two-room case.

The rise is low because the jet is cool and the walls take most of it, not because an entry room cools it on the way. The entry is not its own room. A diagonal stud link meets the end of the corridor-entry wall, so the entry stud is part of the corridor and the jet enters one 45 m² room (`c0`–`c3` and `entry`). The steady balance is jet·cp·(T_jet − T) = wall loss. The jet leaves the plan's fire room at about a 91 K rise (90.7 K at 880 s; the 300–880 s mean is 88.6 K). The test's fire room is 242 K. With the corridor walls made adiabatic the corridor reaches that same 90 K. Concrete takes 61% of the jet enthalpy (27.2 MJ of 44.9 MJ over 0–880 s), and the rise that remains is 34.2 K at 880 s, 33.4 K as the mean over the window. The corridor keeps about 38% of its source's rise (34/91), against 33% in the test (80.2/242). The deficit against 80.2 K is the plan fire room being about 2.7× cooler than the measured one (88.6 K; the validation fire room with the entry on the door is 220 K, and the old door-to-ambient room was 183 K), concrete standing in for ceramic fibre and Marinite, and the extra wall area of the merged room. Gas that leaves at the layer temperature does not cool what stays.

The test runs `nbsPlan.ts` through `SpatialEffectsEngine`: the fire room, entry and corridor on the stud grid, joined by the two 0.81 m doors, with the corridor's 0.76 m outside door as the building exit and a 110 kW pool stud in the fire room. The plan keeps the test's topology, not its dimensions:

- The studs are whole 9 m² cells: the fire room one, the entry one, the corridor four. The engine then merges the entry into the corridor.
- There is one 2.44 m storey.
- The linings are concrete.
- Each door has a 2.0 m head.
- The burner's radiative fraction is 0.35.

In the same plan the fire room is unchanged, at 1.08 m with an 88.6 K rise. Over 300–880 s the corridor has a layer in 59 of 59 samples, at 1.13 m and 33.4 K. The mean corridor extinction is 0.2766 ± 0.02 /m.

**Receiver limits, recorded and not changed.** The receiving room still solves its doors against ambient air.

- About 23% of the corridor's jet enthalpy (10.4 MJ of 44.9 MJ over 0–880 s) flows back out through the door it arrived by. The fire room discards that jet, because a room with its own fire does not take one.
- The hot outflow is not limited by the mass received. The corridor lets out 614 kg after receiving 519 kg: the layer mass is ρ(T)·A·depth, and the vent does not draw that volume down. The enthalpy residual is −4.7 MJ, −10.5% of the jet (−25.8% with adiabatic walls). The temperature is unchanged, because the loss term is the walls. The interface, and what a jet-fed room passes on, do feel the extra outflow. The Harbour mall has no outflow by T+300; its interface is still above the door heads.

**Head height is a switch.** While the interface is above 1.7 m the head reads the lower layer. For a jet-formed layer that is the soot already there at activation, decaying at the column leak (0.002/s), not the layer. When the interface crosses 1.7 m the stud is set to the layer's extinction, capped at the smoke scale (6.1 /m). In the Harbour mall the layer is already on the order of 100 /m by the crossing near T+500, so the reading steps to the cap in one frame. A sharp interface into a layer that thick is opaque over a few centimetres. A blend width would be an assumed thickness this model does not have. Fire-driven layers still clear the column when they form: they form within seconds, before that soot is there.

## Closed

**FV-3, the NBS fire room.** A door straight to ambient gave 183 K against 242 K, with the interface at 0.986 m. χ = 0 moved the rise to 181 K. An adiabatic lining reached the 1500 K ceiling. Gas radiation set to zero reached 195 K and took BE#3 from 189 K to 233 K. A free plume at 0.7 of Heskestad reached 215 K. The door opens into the entry, and that entry on Eq. 4.1 puts the window at 0.745 m and 220 K. Both are inside the band in this fixture only. The scene engine does not set the neighbour gauge, so production fire rooms still solve their doors against ambient. Wiring the neighbour layer into the scene engine's doors is still open. The corridor is not the entry's far side, for the reason in the vent note above.

**FV-5, the VTT hall.** The box of floor area up to the ridge was 4.65 m and 36.0 K, and on the nightly Case 2 it was 4.02 m and 57.2 K. The cross-section in the geometry note puts Case 1 at 4.50 m and 42.5 K (−12%) and Case 2 at 3.89 m and 66.9 K (−14%). Both pass. The steel still stores ρ c δ. A heat-free sheet on the old box was 42.3 K and 67.2 K; that pass was the missing capacity, and the coldness that remained was the extra volume above the eaves. The two cases still start from ambient. A temperature left on the shared sheet is not the case.
