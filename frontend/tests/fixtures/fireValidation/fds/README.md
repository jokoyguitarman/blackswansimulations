# Offline FDS comparison

Roadmap item 9. FDS is a regime check on the zone model, run offline, and it is not part of `npm test`. Decision 5's bands are a scale for the tables below. A difference from FDS is not a pass/fail. The zone series below is the engine with the expansion term in the pressure balance.

The cases use the same gas volumes, linings, radiative fraction, and prescribed heat-release curve on both sides. FDS 6.11.2 (`FDS-6.11.2-0-g8e4c2c4-release`) ran as one mesh on 4 OpenMP threads. The two-room case took 584 s of wall clock. The shop and mall took 624 s. Field files stayed in a scratch directory. The CSVs here are the 1 Hz device record joined to the zone series.

```bash
bash frontend/tests/fixtures/fireValidation/fds/run-fds.sh two-room /tmp/fds-compare
bash frontend/tests/fixtures/fireValidation/fds/run-fds.sh harbour /tmp/fds-compare
node --import tsx frontend/tests/fixtures/fireValidation/fds/engineSeries.ts /tmp/fds-engine
node --import tsx frontend/tests/fixtures/fireValidation/fds/reduce.ts two-room \
  /tmp/fds-compare/two-room /tmp/fds-engine/two-room-engine.csv /tmp/two-room-series.csv
node --import tsx frontend/tests/fixtures/fireValidation/fds/reduce.ts harbour \
  /tmp/fds-compare/harbour /tmp/fds-engine/harbour-engine.csv /tmp/harbour-series.csv
```

`run-fds.sh` sources `~/FDS/FDS6/bin/FDS6VARS.sh` when that file is present. FDS layer height and upper and lower temperature are the two-layer reduction of a vertical column. Upper temperature in the device file is °C. Rise in the series is that value minus the 20 °C ambient. `MASS FLOW +` is the positive coordinate direction. `MASS FLOW -` is stored negative in the device file, and the series carries its magnitude. On the fire-room door, +x leaves the fire room.

The zone series steps once per second. A burning room solves its doors against the neighbour's layer. A room with no fire of its own takes the previous second's upper outflow as a door jet, which is the product's coupling. The door flows in the tables are the last substep of that second. The pressure solution carries that step's change in layer mass out through the openings. The interface itself still follows the exchange, where inflow equals outflow, so a steady room is unchanged. The engine keeps the lower layer at ambient, so its lower rise is 0.

## Two rooms

The mesh is 0.1 m, `IJK=35,24,22`, 18,480 cells. The fire-room gas is 2.4 m × 2.4 m × 2.2 m and the entry gas is 1.0 m × 1.0 m × 2.0 m. The published NBS MV100A rooms are 2.34 m × 2.34 m × 2.16 m and 1.02 m × 1.03 m × 2.00 m. The door and the far opening are 0.8 m × 1.6 m. The test opening is 0.81 m × 1.6 m. The partition is one cell and is in neither gas volume.

The burner is 0.12 m² (the test area is 0.1156 m²), ramped from 0 to 110 kW over 10 s, methane, radiative fraction 0.2. Linings are the NBS rows in `cases.ts`: firebrick floor, ceramic ceiling and walls in the fire room, gypsum floor and marinite walls and ceiling in the entry. The back face is insulated. Both boards are still thick at 180 s, so the back face has not been reached.

Means over 60–180 s, 121 samples. The interface band for a 2.2 m ceiling is 0.33 m.

| Quantity | Engine | FDS | FDS − engine |
| --- | ---: | ---: | ---: |
| Fire interface | 0.85 m | 0.60 m | −0.25 m |
| Fire rise | 162 K | 167 K | +5 K |
| Fire lower rise | 0 K | 2 K | +2 K |
| Entry interface | 1.01 m | 0.97 m | −0.04 m |
| Entry rise | 123 K | 164 K | +41 K |
| Entry lower rise | 0 K | 0.4 K | +0.4 K |
| Heat release | 110 kW | 110 kW | 0 |
| Door, fire to entry | 0.36 kg/s | 0.40 kg/s | +0.04 kg/s |
| Door, entry to fire | 0.36 kg/s | 0.40 kg/s | +0.03 kg/s |
| Far door, out of the entry | 0.36 kg/s | 0.47 kg/s | +0.11 kg/s |

Both rooms form a layer, and the lower gas stays near ambient, so the columns are real two-layer profiles. The fire-room rise, both interfaces, the heat release, and both directions of the connecting door sit inside the Decision 5 scale. The far-door outflow is 23% higher in FDS, inside the 25% flow scale. The entry is the gap: FDS is 41 K hotter, a quarter of its own rise, which is outside the 20% rise scale. At 180 s the same split is still there. The fire room is 0.86 m and 171 K in the engine and 0.61 m and 172 K in FDS. The entry is 1.01 m and 129 K in the engine and 0.95 m and 168 K in FDS. Over this window both models are steady. The engine's two rooms together lose 0.002 kg/s of layer mass, and the far door stays at 0.36 kg/s against FDS at 0.47 kg/s. Expansion is not that gap.

The far opening in the input is an OPEN vent on the mesh boundary. Moving that boundary 1 m out, past a real wall, changes the far-door outflow from 0.471 kg/s to 0.459 kg/s. The 0.1 m mesh is about D*/dx of 4 for 110 kW.

## Harbour shop and mall

The mesh is 0.4 m over x 0–40 m, y 0–40 m, z 0–4 m, 100,000 cells. The shop gas is 21.6 m × 32 m × 4 m. The mall gas is 18 m × 40 m × 4 m. The 0.4 m partition is in neither volume. The kitchen is a solid block from y = 0 to 8 m, with no door. The east shop and the sealed concrete room are outside the domain.

The interior door is the production 1.6 m × 2.0 m opening, on cell faces, centered at y = 20. The exits are 2.0 m × 2.0 m. Their edges are shifted 0.2 m along the wall so they sit on faces: the west exit is y 19.2–21.2 and the north exit is x 29.2–31.2. The zone model sees the width and the soffit. Floor, ceiling, and exterior walls use the engine's concrete row. The partition and the kitchen face use the drywall row, which conducts as gypsum. The radiative fraction is 0.35.

The burner is 4 m × 4 m, ramped from 0 to 5 MW over 30 s. The west exit alone can relieve about 8.5 MW on the 1500 A√H formula, so the prescribed fire stays under that vent. This is a controlled box. The production Harbour scene at T+90 is a different fire: about 2.8 MW, interface 2.3 m, rise 10 K.

At 0.4 m, D*/dx is about 4.6 for 5 MW, and the door is 4 cells wide by 5 tall. The split of the outflow between the door and the west exit, and the 36 K lower-layer warming, can move on a finer mesh. The total outflow does not. It is the expansion volume below, and that balance does not depend on the mesh, the door shape, or the open boundary.

Means over 60–120 s, 61 samples. The interface band for a 4 m ceiling is 0.60 m.

| Quantity | Engine | FDS | FDS − engine |
| --- | ---: | ---: | ---: |
| Shop interface | 1.66 m | 1.43 m | −0.23 m |
| Shop rise | 83 K | 89 K | +6 K |
| Shop lower rise | 0 K | 36 K | +36 K |
| Mall-center rise | 1.0 K | 3.9 K | +2.9 K |
| Heat release | 5000 kW | 5000 kW | +0.4 kW |
| Door, shop to mall | 1.47 kg/s | 2.33 kg/s | +0.86 kg/s |
| Door, mall to shop | 0.00 kg/s | 0.44 kg/s | +0.44 kg/s |
| West exit, outward | 2.51 kg/s | 4.72 kg/s | +2.2 kg/s |
| North exit, outward | 1.59 kg/s | 2.26 kg/s | +0.68 kg/s |
| Rise 2 m into the mall | 1.0 K | 21 K | +20 K |

The shop layer forms on both sides. The interface and the upper rise over this window sit inside the Decision 5 scale, and the heat release matches. FDS also warms the shop's lower gas by 36 K. The zone model has no warm lower layer. At 120 s the interfaces meet, 1.27 m in the engine and 1.21 m in FDS, and the rises are 92 K and 114 K. The FDS lower gas is then 66 °C.

FDS's outflow is the expansion of the heat left in the gas. Over 60–120 s `Q_TOTAL` is 2,056 kW. At constant pressure an open volume expels Q·R/(cp·P). That predicts 5.79 m³/s, and the devices measure 5.67 m³/s at ambient density. Over 30–60 s the same check is 8.51 m³/s predicted and 8.36 m³/s measured. The openings, from `MASS FLOW`, `MASS FLOW +` and `MASS FLOW -`:

| Opening, 60–120 s | FDS out | FDS in | Engine out | Engine in |
| --- | ---: | ---: | ---: | ---: |
| West exit | 4.72 kg/s | 0.15 kg/s | 2.51 kg/s | 0 |
| Door | 2.33 kg/s | 0.44 kg/s | 1.47 kg/s | 0 |
| North exit | 2.26 kg/s | 0.00 kg/s | 1.59 kg/s | 0 |

The shop's FDS openings are nearly one-way, 6.45 kg/s net. The mall passes that on: 1.89 kg/s net in through the door and 2.26 kg/s out the north exit.

The engine pressure balance is in − out − fans = dM/dt. dM/dt is the mass change of the exchange step, the layer move at inflow = outflow, including a deposited jet. The vents then carry that mass. The interface is not moved a second time by the expansion outflow. Over 60–120 s the shop's layer mass falls at 3.97 kg/s and the door plus the west exit carry 3.98 kg/s out, with nothing coming back. Over 30–60 s the layer falls at 5.90 kg/s and those two openings carry 5.91 kg/s. The mall sends 1.59 kg/s out the north exit over 60–120 s.

FDS still moves more gas. The engine west flow is 2.51 kg/s against 4.72, and the door is 1.47 kg/s against 2.33. FDS retains more of the fire in the gas than this zone step does, which is the Q_TOTAL check above. The engine door is one-way over this window. One floor pressure high enough to expel the shop's expansion pushes the neutral plane out of the opening, while FDS still draws 0.44 kg/s back in. Door coefficients are unchanged. The two-room far door, above, is the steady shortfall and is not this term.

## The mall layer

A hall layer does not form. The FDS column at the mall center stays within 8 K of ambient for the whole 120 s, and the highest center rise in the window is 7 K. The engine's mall rise is 3.1 K at 120 s, under the 20 K line `formsSustainedLayer` uses, so the layer gate stays off. The north exit is carrying the shop's expansion out, and the one mall temperature does not climb into a layer.

FDS does warm the gas just inside the door. A column 2.2 m into the mall averages a 21 K rise over 60–120 s, and its peak on that window is 30 K. The zone model has one temperature for the whole 720 m² mall, and that average is the center of the hall rather than the doorway. The hall in this box stays on the flame front.
