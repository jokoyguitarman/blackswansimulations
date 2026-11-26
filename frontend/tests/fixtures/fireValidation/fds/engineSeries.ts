/**
 * Zone-model series for the offline FDS comparison.
 *
 * The geometry is the gas inside the FDS meshes, not the published NBS
 * millimetres and not the production 1.6 m door shifted off a cell face.
 * A burning room solves its doors against the neighbour's layer. A room
 * with no fire of its own takes that room's upper outflow from the previous
 * step as a door jet, which is the product's coupling. The door flows in
 * the CSV are the last substep of that second. While the layer is warming,
 * that pressure solution carries the weight of the volume the upper mass
 * needs at the new temperature, including the plume's own heating, and the
 * interface then drops by the part beyond the exchange. A second root takes
 * the extra hot gas out of that volume. The lower layer is clear, so the
 * upper gas still radiates to the floor and the wall below the interface.
 * Convection on those faces is charged to the lower layer, which keeps its
 * own temperature, and the door uses that density.
 *
 *   node --import tsx frontend/tests/fixtures/fireValidation/fds/engineSeries.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AMBIENT_K,
  freshLayer,
  formsSustainedLayer,
  hasSmokeReservoir,
  liningForMaterial,
  oxygenLimitedBurn,
  oxygenMassFraction,
  spillOriginM,
  stepZone,
  type DoorJetInflow,
  type LayerSpec,
  type Lining,
  type Vent,
  type VentedHotGas,
  type ZoneState,
} from '../../../../src/lib/rts/twoZone.ts';

const DT = 1;

interface Gauge {
  zone: ZoneState;
  pressurePa: number;
}

interface HotParcel {
  gas: VentedHotGas;
  interfaceM: number;
  neutralM: number;
  vent: Vent;
}

function lining(material: string): Lining {
  return liningForMaterial(material);
}

function ramp(tS: number, fullAtS: number, fullKw: number): number {
  if (tS <= 0) return 0;
  if (tS >= fullAtS) return fullKw;
  return (fullKw * tS) / fullAtS;
}

function circle(areaM2: number): number {
  return Math.sqrt((4 * areaM2) / Math.PI);
}

function outsideOf(gauge: Gauge): Vent['outside'] {
  return {
    interfaceM: gauge.zone.interfaceM,
    upperK: gauge.zone.upperK,
    floorPressurePa: gauge.pressurePa,
    ...(gauge.zone.lowerK != null ? { lowerK: gauge.zone.lowerK } : {}),
  };
}

function withOutside(vent: Vent, gauge: Gauge | null): Vent {
  if (!gauge) return vent;
  return { ...vent, outside: outsideOf(gauge) };
}

function jetFrom(parcel: HotParcel | null): DoorJetInflow | null {
  if (!parcel || !(parcel.gas.kg > 0)) return null;
  const sill = parcel.vent.sillM;
  return {
    kgS: parcel.gas.kg / DT,
    tempK: parcel.gas.tempK,
    oxygenY: parcel.gas.oxygenY,
    fuelY: parcel.gas.fuelY,
    widthM: parcel.vent.widthM,
    soffitM: parcel.vent.soffitM,
    originM: spillOriginM(sill, parcel.interfaceM),
    lowEdgeM: Math.max(sill, parcel.interfaceM, parcel.neutralM),
  };
}

function layerFlag(state: ZoneState, spec: LayerSpec): number {
  const depth = spec.ceilingM - state.interfaceM;
  const rise = state.upperK - AMBIENT_K;
  return formsSustainedLayer(depth, spec.ceilingM, rise, hasSmokeReservoir(spec.vents, spec.ceilingM))
    ? 1
    : 0;
}

interface OpeningFlows {
  inKgS: number;
  outByVentKgS: number[];
  hotOutByVentKgS: number[];
  upperLossKw?: number;
  lowerLossKw?: number;
}

function flowOf(spec: LayerSpec, state: ZoneState) {
  return oxygenLimitedBurn(
    spec,
    state.interfaceM,
    state.upperK,
    oxygenMassFraction(state.lowerO2),
    oxygenMassFraction(state.upperO2),
    0.1,
    false,
    undefined,
    state.lowerK ?? AMBIENT_K,
  );
}

function neutralOf(step: { neutralM?: number }, state: ZoneState): number {
  return step.neutralM != null && Number.isFinite(step.neutralM) ? step.neutralM : state.interfaceM;
}

function num(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(digits);
}

const nbsBrick: Lining = { name: 'firebrick', kKwMK: 0.00036, rhoKgM3: 750, cKjKgK: 1.04, thicknessM: 0.113 };
const nbsCeramic: Lining = { name: 'ceramic', kKwMK: 0.00009, rhoKgM3: 128, cKjKgK: 1.04, thicknessM: 0.05 };
const nbsMarinite: Lining = { name: 'marinite', kKwMK: 0.00012, rhoKgM3: 720, cKjKgK: 1.25, thicknessM: 0.0127 };
const nbsGypsum: Lining = { name: 'gypsum', kKwMK: 0.00017, rhoKgM3: 930, cKjKgK: 1.09, thicknessM: 0.0127 };

function twoRoomSpecs(qKw: number, fire: Gauge, entry: Gauge): { fire: LayerSpec; entry: LayerSpec } {
  const door: Vent = { widthM: 0.8, sillM: 0, soffitM: 1.6 };
  const far: Vent = { widthM: 0.8, sillM: 0, soffitM: 1.6 };
  const fireArea = 2.4 * 2.4;
  const entryArea = 1;
  const fireWall = 2 * (2.4 + 2.4) * 2.2 - door.widthM * door.soffitM;
  const entryWall = 2 * (1 + 1) * 2 - 2 * door.widthM * door.soffitM;
  return {
    fire: {
      areaM2: fireArea,
      ceilingM: 2.2,
      chi: 0.2,
      vents: [withOutside(door, entry)],
      boundaries: [
        { areaM2: fireArea, lining: nbsBrick, place: 'floor' },
        { areaM2: fireArea, lining: nbsCeramic, place: 'ceiling' },
        { areaM2: fireWall, lining: nbsCeramic, place: 'wall' },
      ],
      fires: qKw > 0 ? [{ heatKw: qKw, diameterM: circle(0.12) }] : [],
    },
    entry: {
      areaM2: entryArea,
      ceilingM: 2,
      chi: 0.2,
      vents: [withOutside(door, fire), far],
      boundaries: [
        { areaM2: entryArea, lining: nbsGypsum, place: 'floor' },
        { areaM2: entryArea, lining: nbsMarinite, place: 'ceiling' },
        { areaM2: entryWall, lining: nbsMarinite, place: 'wall' },
      ],
      fires: [],
    },
  };
}

function twoRoomCsv(): string {
  let fire: Gauge = { zone: freshLayer(2.2), pressurePa: 0 };
  let entry: Gauge = { zone: freshLayer(2), pressurePa: 0 };
  let pending: HotParcel | null = null;
  const lines = [
    't_s,fire_z_m,fire_Tu_C,fire_rise_K,fire_lower_rise_K,entry_z_m,entry_Tu_C,entry_rise_K,entry_lower_rise_K,hrr_kW,prescribed_kW,door_out_kg_s,door_hot_kg_s,door_in_kg_s,return_out_kg_s,far_out_kg_s,fire_layer,entry_layer',
  ];
  const push = (
    t: number,
    qKw: number,
    fireFlows?: OpeningFlows,
    entryFlows?: OpeningFlows,
  ) => {
    const specs = twoRoomSpecs(qKw, fire, entry);
    const burned = flowOf(specs.fire, fire.zone);
    const fireFlow = fireFlows ?? burned;
    const entryFlow = entryFlows ?? flowOf(specs.entry, entry.zone);
    lines.push(
      [
        num(t, 0),
        num(fire.zone.interfaceM, 4),
        num(fire.zone.upperK - 273.15, 2),
        num(fire.zone.upperK - AMBIENT_K, 2),
        num((fire.zone.lowerK ?? AMBIENT_K) - AMBIENT_K, 2),
        num(entry.zone.interfaceM, 4),
        num(entry.zone.upperK - 273.15, 2),
        num(entry.zone.upperK - AMBIENT_K, 2),
        num((entry.zone.lowerK ?? AMBIENT_K) - AMBIENT_K, 2),
        num(burned.burn.burnedKw, 2),
        num(qKw, 2),
        num(fireFlow.outByVentKgS[0] ?? 0, 4),
        num(fireFlow.hotOutByVentKgS[0] ?? 0, 4),
        num(fireFlow.inKgS, 4),
        num(entryFlow.outByVentKgS[0] ?? 0, 4),
        num(entryFlow.outByVentKgS[1] ?? 0, 4),
        String(layerFlag(fire.zone, specs.fire)),
        String(layerFlag(entry.zone, specs.entry)),
      ].join(','),
    );
  };
  push(0, 0);
  for (let t = 1; t <= 180; t++) {
    const qKw = ramp(t - 0.5, 10, 110);
    const specs = twoRoomSpecs(qKw, fire, entry);
    const fireStep = stepZone(fire.zone, specs.fire, DT);
    const entryStep = stepZone(entry.zone, specs.entry, DT, 0, jetFrom(pending));
    const door = specs.fire.vents[0];
    if (!door) throw new Error('two-room door missing');
    pending = {
      gas: fireStep.hotByVent[0] ?? { kg: 0, tempK: AMBIENT_K, oxygenY: 0.23, fuelY: 0 },
      interfaceM: fireStep.state.interfaceM,
      neutralM: neutralOf(fireStep as { neutralM?: number }, fireStep.state),
      vent: door,
    };
    fire = { zone: fireStep.state, pressurePa: fireStep.floorPressurePa };
    entry = { zone: entryStep.state, pressurePa: entryStep.floorPressurePa };
    push(t, ramp(t, 10, 110), fireStep, entryStep);
  }
  return lines.join('\n') + '\n';
}

function harbourSpecs(qKw: number, shop: Gauge, mall: Gauge): { shop: LayerSpec; mall: LayerSpec } {
  const concrete = lining('concrete');
  const gypsum = lining('drywall');
  const door: Vent = { widthM: 1.6, sillM: 0, soffitM: 2 };
  const exit: Vent = { widthM: 2, sillM: 0, soffitM: 2 };
  const shopArea = 21.6 * 32;
  const mallArea = 18 * 40;
  return {
    shop: {
      areaM2: shopArea,
      ceilingM: 4,
      chi: 0.35,
      vents: [exit, withOutside(door, mall)],
      boundaries: [
        { areaM2: shopArea, lining: concrete, place: 'floor' },
        { areaM2: shopArea, lining: concrete, place: 'ceiling' },
        { areaM2: 32 * 4 - 4, lining: concrete, place: 'wall' },
        { areaM2: 21.6 * 4, lining: concrete, place: 'wall' },
        { areaM2: 21.6 * 4, lining: gypsum, place: 'wall' },
        { areaM2: 32 * 4 - 3.2, lining: gypsum, place: 'wall' },
      ],
      fires: qKw > 0 ? [{ heatKw: qKw, diameterM: circle(16) }] : [],
    },
    mall: {
      areaM2: mallArea,
      ceilingM: 4,
      chi: 0.35,
      vents: [withOutside(door, shop), exit],
      boundaries: [
        { areaM2: mallArea, lining: concrete, place: 'floor' },
        { areaM2: mallArea, lining: concrete, place: 'ceiling' },
        // East wall, 40 m, no opening. South wall, 18 m. North wall, 18 m minus the 2 × 2 m exit.
        { areaM2: 40 * 4, lining: concrete, place: 'wall' },
        { areaM2: 18 * 4, lining: concrete, place: 'wall' },
        { areaM2: 18 * 4 - 4, lining: concrete, place: 'wall' },
        { areaM2: 8 * 4, lining: gypsum, place: 'wall' },
        { areaM2: 32 * 4 - 3.2, lining: gypsum, place: 'wall' },
      ],
      fires: [],
    },
  };
}

function harbourCsv(): string {
  let shop: Gauge = { zone: freshLayer(4), pressurePa: 0 };
  let mall: Gauge = { zone: freshLayer(4), pressurePa: 0 };
  let pending: HotParcel | null = null;
  const lines = [
    't_s,shop_z_m,shop_Tu_C,shop_rise_K,mall_z_m,mall_Tu_C,mall_rise_K,hrr_kW,prescribed_kW,door_out_kg_s,door_hot_kg_s,return_out_kg_s,return_hot_kg_s,west_out_kg_s,west_hot_kg_s,north_out_kg_s,north_hot_kg_s,shop_layer,mall_layer,shop_Tl_C,shop_lower_rise_K,mall_lower_rise_K,shop_upper_loss_kW,shop_lower_loss_kW',
  ];
  const push = (t: number, qKw: number, shopFlows?: OpeningFlows, mallFlows?: OpeningFlows) => {
    const specs = harbourSpecs(qKw, shop, mall);
    const burned = flowOf(specs.shop, shop.zone);
    const shopFlow = shopFlows ?? burned;
    const mallFlow = mallFlows ?? flowOf(specs.mall, mall.zone);
    lines.push(
      [
        num(t, 0),
        num(shop.zone.interfaceM, 4),
        num(shop.zone.upperK - 273.15, 2),
        num(shop.zone.upperK - AMBIENT_K, 2),
        num(mall.zone.interfaceM, 4),
        num(mall.zone.upperK - 273.15, 2),
        num(mall.zone.upperK - AMBIENT_K, 2),
        num(burned.burn.burnedKw, 1),
        num(qKw, 1),
        num(shopFlow.outByVentKgS[1] ?? 0, 4),
        num(shopFlow.hotOutByVentKgS[1] ?? 0, 4),
        num(mallFlow.outByVentKgS[0] ?? 0, 4),
        num(mallFlow.hotOutByVentKgS[0] ?? 0, 4),
        num(shopFlow.outByVentKgS[0] ?? 0, 4),
        num(shopFlow.hotOutByVentKgS[0] ?? 0, 4),
        num(mallFlow.outByVentKgS[1] ?? 0, 4),
        num(mallFlow.hotOutByVentKgS[1] ?? 0, 4),
        String(layerFlag(shop.zone, specs.shop)),
        String(layerFlag(mall.zone, specs.mall)),
        num((shop.zone.lowerK ?? AMBIENT_K) - 273.15, 2),
        num((shop.zone.lowerK ?? AMBIENT_K) - AMBIENT_K, 2),
        num((mall.zone.lowerK ?? AMBIENT_K) - AMBIENT_K, 2),
        num(shopFlows?.upperLossKw ?? 0, 1),
        num(shopFlows?.lowerLossKw ?? 0, 1),
      ].join(','),
    );
  };
  push(0, 0);
  for (let t = 1; t <= 120; t++) {
    const qKw = ramp(t - 0.5, 30, 5000);
    const specs = harbourSpecs(qKw, shop, mall);
    const shopStep = stepZone(shop.zone, specs.shop, DT);
    const mallStep = stepZone(mall.zone, specs.mall, DT, 0, jetFrom(pending));
    const door = specs.shop.vents[1];
    if (!door) throw new Error('harbour door missing');
    pending = {
      gas: shopStep.hotByVent[1] ?? { kg: 0, tempK: AMBIENT_K, oxygenY: 0.23, fuelY: 0 },
      interfaceM: shopStep.state.interfaceM,
      neutralM: neutralOf(shopStep as { neutralM?: number }, shopStep.state),
      vent: door,
    };
    shop = { zone: shopStep.state, pressurePa: shopStep.floorPressurePa };
    mall = { zone: mallStep.state, pressurePa: mallStep.floorPressurePa };
    push(t, ramp(t, 30, 5000), shopStep, mallStep);
  }
  return lines.join('\n') + '\n';
}

function checkLinings(): void {
  const gypsum = lining('drywall');
  const concrete = lining('concrete');
  const expect = (name: string, got: number, want: number) => {
    const scale = Math.max(Math.abs(want), 1e-6);
    if (Math.abs(got - want) / scale > 0.002) {
      throw new Error(`${name} is ${got}, and the FDS input was written for ${want}`);
    }
  };
  expect('gypsum k', gypsum.kKwMK * 1000, 0.17);
  expect('gypsum rho', gypsum.rhoKgM3, 962.57);
  expect('gypsum c', gypsum.cKjKgK, 1.1);
  expect('gypsum thickness', gypsum.thicknessM, 0.016);
  expect('concrete k', concrete.kKwMK * 1000, 1.6);
  expect('concrete rho', concrete.rhoKgM3, 2416.67);
  expect('concrete c', concrete.cKjKgK, 0.75);
  expect('concrete thickness', concrete.thicknessM, 0.15);
}

const outDir = process.argv[2] ?? 'frontend/tests/fixtures/fireValidation/fds';
checkLinings();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'two-room-engine.csv'), twoRoomCsv());
writeFileSync(join(outDir, 'harbour-engine.csv'), harbourCsv());
console.log(`wrote engine series to ${outDir}`);
