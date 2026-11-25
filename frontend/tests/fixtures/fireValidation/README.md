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

Steckler uses the published values already in `twoZone.test.ts`: Johansson and van Hees (IAFSS 2014, Table 3) for the interface and the rise, and NBSIR 82-2520 for the 0.571 kg/s outflow.

These parts of the setup differ from the tests:

- **Vents.** The layer vents to ambient air. The NBS fire-room door actually opens to an entry and then the corridor.
- **Burner position.** The NBS burner stands 0.1 m from a wall, and the VTT pan stands 1 m above the floor. Both plumes are entrained as free plumes from the floor.
- **VTT geometry.** The VTT hall has a pitched roof. It is modelled as its 372.6 m² floor up to the 19 m ridge, with the steel at the hall's real surface area.

## Results

`fireValidation.test.ts` and `fireValidationSlow.test.ts` print each row as a `PASS` or `EXPECTED FAILURE` diagnostic.

| Case                                            | Metric                       | Model                   | Target                                        | Tolerance | Result                         |
| ----------------------------------------------- | ---------------------------- | ----------------------- | --------------------------------------------- | --------- | ------------------------------ |
| NUREG room                                      | Layer flashover heat release | 2353 kW                 | 1625–2366 kW (Thomas to MQH; Babrauskas 1909) | band      | pass (nightly)                 |
| NUREG room                                      | Flashover latch              | 1000 kW                 | 1625–2366 kW                                  | band      | FV-2                           |
| NUREG room, slow / medium / fast / ultrafast t² | Time to flashover            | 869 / 465 / 246 / 130 s | MQH clock 860 / 464 / 251 / 136 s             | ±20%      | pass (fast in CI, all nightly) |
| Steckler                                        | Interface                    | 1.18 m                  | 0.985 m                                       | ±0.32 m   | pass                           |
| Steckler                                        | Rise                         | 113 K                   | 98.2 K                                        | ±20%      | pass                           |
| Steckler                                        | Door outflow                 | 0.385 kg/s              | 0.571 kg/s                                    | ±25%      | FV-1                           |
| NBS MV100A fire room                            | Interface                    | 0.986 m                 | 0.948 m                                       | ±0.32 m   | pass                           |
| NBS MV100A fire room                            | Rise                         | 183 K                   | 242 K                                         | ±20%      | FV-3                           |
| NBS MV100A corridor                             | Interface                    | no layer (2.44 m)       | 1.32 m                                        | ±0.37 m   | FV-4                           |
| NBS MV100A corridor                             | Rise                         | 0 K                     | 80.2 K                                        | ±20%      | FV-4                           |
| BE#3 Test 3                                     | Interface                    | 1.11 m                  | 0.951 m                                       | ±0.57 m   | pass                           |
| BE#3 Test 3                                     | Rise                         | 189 K                   | 192 K                                         | ±20%      | pass                           |
| VTT Case 1                                      | Layer forms                  | yes                     | yes                                           | —         | pass                           |
| VTT Case 1                                      | Interface                    | 3.71 m                  | 5.13 m                                        | ±2.85 m   | pass                           |
| VTT Case 1                                      | Rise                         | 27.6 K                  | 48.2 K                                        | ±20%      | FV-5                           |
| VTT Case 2                                      | Interface                    | 3.08 m                  | 4.60 m                                        | ±2.85 m   | pass (nightly)                 |
| VTT Case 2                                      | Rise                         | 44.1 K                  | 77.6 K                                        | ±20%      | FV-5 (nightly)                 |

## Known gaps

### FV-1

**Steckler doorway flow.** The coupled steady outflow is 0.385 kg/s against the measured 0.571 kg/s, which is −33%. The 25% band runs from 0.428 to 0.714 kg/s. The test pins the outflow at 0.392 ± 0.03 kg/s. Roadmap: Decision 7, "Known gap: the Steckler doorway flow".

### FV-2

**The 1 MW flashover latch.** `FLASHOVER_ROOM_KW` lights every fuelled stud in a room once the burning fuel sums to 1000 kW. In the NUREG room that is below all three correlations: Thomas 1625 kW, Babrauskas 1909 kW and MQH 2366 kW. The layer alone reaches the flashover definition at 2353 kW, which is inside the band. Pinned at 1000 kW. Roadmap: Decision 8, where the 1 MW latch still ignites the fuel and is described as a stand-in.

### FV-3

**NBS fire-room rise.** 183 K against the measured 242 K, −24%, just outside 20%. The interface (0.99 m against 0.95 m) passes. Pinned at 183.3 ± 5 K. Roadmap: "What to reproduce", the two-room case.

### FV-4

**No layer in a room without its own fire.** The NBS corridor gets the fire room's hot outflow through the entry. The engine's layer takes mass only from a plume in its own enclosure, and soot crosses a door onto the studs but heat does not. So the corridor has no layer: the interface stays at the 2.44 m ceiling and the rise is 0 K. The measured corridor has a layer at 1.32 m and an 80 K rise. Pinned at 2.44 m and 0 K. Roadmap: "What to reproduce", the two-room case ("so a door between rooms is tested").

### FV-5

**Large-hall rise.** VTT Case 1 rises 27.6 K against 48.2 K (−43%), and Case 2 rises 44.1 K against 77.6 K (−43%). In both cases a layer forms, as it does in the hall, and the interface is inside 2.85 m. The roof monitor is modelled at the full floor area, which over-sizes the volume above the eaves. Pinned at 27.6 ± 1.5 K and 44.1 ± 2 K. Roadmap: Decision 5 (rise within 20%). This bears on the open food-court decision (Decision 1).
