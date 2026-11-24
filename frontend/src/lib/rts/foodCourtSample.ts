import {
  absorbLegacyFuelCircles,
  entryById,
  matchFromEntry,
  type PlacedObject,
} from './materialLibrary';

/** Food-court plan from the approved environment note.
 * Walls, exits, and the blast marker. The old combustible and ignitable circles
 * ship as confirmed objects (see foodCourtPlacedObjects). Bare tile has none.
 */
export const foodCourtSample = {
  "scene": {
    "name": "Food court",
    "buildingName": "Food court, ground floor",
    "buildingPolygon": [
      [
        1.30012576,
        103.79982029
      ],
      [
        1.30012576,
        103.80017971
      ],
      [
        1.29987424,
        103.80017971
      ],
      [
        1.29987424,
        103.79982029
      ]
    ],
    "centerLat": 1.3,
    "centerLng": 103.8,
    "locationDescription": "Single-storey food court. North side is five kitchen stalls and a concrete service corridor. The open court to the south is bare tile. The blast marker sits on that tile. Tables and the fryer oil are confirmed objects. Gas lines are confirmed and do not burn until a blast opens one. Each stall has an electrical appliance. It is not fuel, and it does not arc until a blast faults it. A wooden table sits one stud from the noodle gas line, and another one stud from the pizza gas line. The pizza fridge is the next stud, not under that table. Each cooking stall has a wet-chemical hood over its gas line. The drinks stall has no gas line, so its hood is on the back wall. A hood does not discharge until a fire heats its link. A discharge shuts off the gas and power under that hood, and the floor under the spray is wet. Smoke from a burning object carries that material's gases. While the irritant fraction is at least 1 the person stops, and they move again in cleaner air. The asphyxiant dose stays, and at 1 they go down.",
    "pedestrianCount": 0,
    "levels": [
      {
        "id": "G",
        "name": "Ground",
        "index": 0,
        "heightM": 4,
        "designed": true,
        "pedestrianCount": 0
      }
    ],
    "exits": [
      {
        "id": "exit-south-west",
        "center": {
          "x": -8.5,
          "y": 14
        },
        "width": 4,
        "edgeIndex": 2,
        "description": "Main public exit to the mall concourse, west leaf.",
        "status": "open",
        "photos": [],
        "level": "G",
        "exitType": "public"
      },
      {
        "id": "exit-south-east",
        "center": {
          "x": 8.5,
          "y": 14
        },
        "width": 4,
        "edgeIndex": 2,
        "description": "Main public exit to the mall concourse, east leaf.",
        "status": "open",
        "photos": [],
        "level": "G",
        "exitType": "public"
      },
      {
        "id": "exit-east",
        "center": {
          "x": 20,
          "y": 0.5
        },
        "width": 3,
        "edgeIndex": 1,
        "description": "Secondary public opening to the mall.",
        "status": "open",
        "photos": [],
        "level": "G",
        "exitType": "public"
      },
      {
        "id": "exit-service",
        "center": {
          "x": -20,
          "y": -8.5
        },
        "width": 1.5,
        "edgeIndex": 3,
        "description": "Kitchen receiving door. Staff only. The RTS exit button does not offer a service type; the War Room scene editor does, and the evacuation type supports it.",
        "status": "open",
        "photos": [],
        "level": "G",
        "exitType": "service"
      }
    ],
    "interiorWalls": [
      {
        "id": "iw-corridor-kitchen",
        "start": {
          "x": -14.5,
          "y": -11.5
        },
        "end": {
          "x": -14.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Service corridor wall. Door into the kitchen run. Concrete, so today's fire rule would not burn through it.",
        "material": "concrete",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-corridor-seating",
        "start": {
          "x": -14.5,
          "y": -5.5
        },
        "end": {
          "x": -14.5,
          "y": 3.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Service corridor beside the seating. No opening.",
        "material": "concrete",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-corridor-tile",
        "start": {
          "x": -14.5,
          "y": 3.5
        },
        "end": {
          "x": -14.5,
          "y": 12.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Service corridor beside the open tiled court. Staff door onto the tile.",
        "material": "concrete",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-part-1",
        "start": {
          "x": -8.5,
          "y": -11.5
        },
        "end": {
          "x": -8.5,
          "y": -5.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Plywood partition between the noodle stall and the grill. Stored as wood, the closest fire-table material to plywood.",
        "material": "wood",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-part-2",
        "start": {
          "x": -2.5,
          "y": -11.5
        },
        "end": {
          "x": -2.5,
          "y": -5.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Plywood partition between the grill and the fryer.",
        "material": "wood",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-part-3",
        "start": {
          "x": 3.5,
          "y": -11.5
        },
        "end": {
          "x": 3.5,
          "y": -5.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Plywood partition between the fryer and the pizza oven.",
        "material": "wood",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-part-4",
        "start": {
          "x": 9.5,
          "y": -11.5
        },
        "end": {
          "x": 9.5,
          "y": -5.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Plywood partition between the pizza oven and the drinks stall.",
        "material": "wood",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-kitchen-end",
        "start": {
          "x": 15.5,
          "y": -11.5
        },
        "end": {
          "x": 15.5,
          "y": -5.5
        },
        "hasDoor": false,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Plywood end of the kitchen run.",
        "material": "wood",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-counter-noodle",
        "start": {
          "x": -14.5,
          "y": -5.5
        },
        "end": {
          "x": -8.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Noodle stall serving counter. The 1.5 m opening is the only door width the draw tool stores.",
        "material": "drywall",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-counter-grill",
        "start": {
          "x": -8.5,
          "y": -5.5
        },
        "end": {
          "x": -2.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Grill serving counter, 1.5 m opening in the centre.",
        "material": "drywall",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-counter-fryer",
        "start": {
          "x": -2.5,
          "y": -5.5
        },
        "end": {
          "x": 3.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Fryer serving counter, 1.5 m opening in the centre.",
        "material": "drywall",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-counter-pizza",
        "start": {
          "x": 3.5,
          "y": -5.5
        },
        "end": {
          "x": 9.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Pizza stall serving counter, 1.5 m opening in the centre.",
        "material": "drywall",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      },
      {
        "id": "iw-counter-drinks",
        "start": {
          "x": 9.5,
          "y": -5.5
        },
        "end": {
          "x": 15.5,
          "y": -5.5
        },
        "hasDoor": true,
        "doorWidth": 1.5,
        "doorPosition": 0.5,
        "description": "Drinks stall serving counter, 1.5 m opening in the centre. No gas in this stall.",
        "material": "drywall",
        "photos": [],
        "insideBuilding": true,
        "spatialContext": "inside_building",
        "level": "G"
      }
    ],
    "hazardZones": [],
    "stairwells": [],
    "blastSite": {
      "x": 0.5,
      "y": 9.5,
      "radius": 8,
      "manualRadius": true,
      "manualRadiusM": 8,
      "level": "G",
      "locationDescription": "Blast marker on the open tiled court, away from the kitchens and the tables."
    },
    "casualtyPins": [],
    "plantedItems": [],
    "wallInspectionPoints": []
  }
} as const;

/** Combustible and ignitable circles from the drawn food court, before they became objects. */
export const foodCourtLegacyCircles = [
  {
    id: 'hz-gas-noodle',
    pos: { x: -11.5, y: -11.5 },
    radius: 2,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Ignitable',
    description:
      'Noodle stall. Gas line and gas hob against the back wall. The editor can only store this as a circle, not a pipe.',
    level: 'G',
  },
  {
    id: 'hz-gas-grill',
    pos: { x: -5.5, y: -11.5 },
    radius: 2,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Ignitable',
    description: 'Grill stall. Gas line and chargrill.',
    level: 'G',
  },
  {
    id: 'hz-gas-fryer',
    pos: { x: 0.5, y: -11.5 },
    radius: 2,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Ignitable',
    description:
      'Fryer stall. Gas line and hot cooking oil. Oil is fuel. There is no fryer object, so the oil is named in this circle.',
    level: 'G',
  },
  {
    id: 'hz-gas-pizza',
    pos: { x: 6.5, y: -11.5 },
    radius: 2,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Ignitable',
    description: 'Pizza stall. Gas line and gas deck oven.',
    level: 'G',
  },
  {
    id: 'hz-tables-west',
    pos: { x: -8.5, y: -2.5 },
    radius: 3,
    hazardType: 'combustible',
    severity: 'medium',
    label: 'Combustible',
    description:
      'Seating. Wooden table tops can burn. Frames are steel and cannot. The editor has no table, so this circle stands in for the tops. People can still walk through it.',
    level: 'G',
  },
  {
    id: 'hz-tables-mid',
    pos: { x: 0.5, y: 0.5 },
    radius: 3,
    hazardType: 'combustible',
    severity: 'medium',
    label: 'Combustible',
    description: 'Seating. Wooden table tops, steel frames. Same stand-in as the other table circles.',
    level: 'G',
  },
  {
    id: 'hz-tables-east',
    pos: { x: 9.5, y: -2.5 },
    radius: 3,
    hazardType: 'combustible',
    severity: 'medium',
    label: 'Combustible',
    description: 'Seating. Wooden table tops, steel frames.',
    level: 'G',
  },
] as const;

function confirmedPoint(
  id: string,
  x: number,
  y: number,
  entryId: string,
  description: string,
): PlacedObject {
  const entry = entryById(entryId);
  if (!entry) throw new Error(`missing library entry ${entryId}`);
  return {
    id,
    studId: '',
    pos: { x, y },
    level: 'G',
    description,
    matches: [matchFromEntry(entry, 'chosen')],
    confirmed: true,
  };
}

/**
 * The old circles, already confirmed, plus a wooden table one stud from the
 * noodle and pizza gas lines, and one electrical appliance in each stall.
 * The pizza fridge is the next stud east of that table, not on it, so the
 * jet can light the table on its own. The drinks text does not say "gas
 * line": that appliance is electrical only, so it is not a pipe.
 * Each cooking stall has a wet-chemical hood on the gas-line stud, over the
 * appliance it protects. The drinks stall has no gas line, so that hood
 * stays on the back wall. A hood does not discharge until a fire heats its
 * link. The link is at hood height, not at the storey ceiling.
 */
export function foodCourtPlacedObjects(): PlacedObject[] {
  return [
    ...absorbLegacyFuelCircles(foodCourtLegacyCircles, [], { confirmed: true }).objects,
    confirmedPoint('noodle-table', -11.5, -8.5, 'wood', 'Wooden table in the noodle stall.'),
    confirmedPoint('pizza-table', 6.5, -8.5, 'wood', 'Wooden table in the pizza stall.'),
    confirmedPoint('elec-noodle', -14.5, -8.5, 'electrical', 'Noodle stall. Fridge.'),
    confirmedPoint('elec-grill', -5.5, -8.5, 'electrical', 'Grill stall. Fridge.'),
    confirmedPoint('elec-fryer', 0.5, -8.5, 'electrical', 'Fryer stall. Fridge.'),
    confirmedPoint('elec-pizza', 8.5, -8.5, 'electrical', 'Pizza stall. Fridge beside the table.'),
    confirmedPoint(
      'elec-drinks',
      12.5,
      -8.5,
      'electrical',
      'Drinks stall. Fridges and a hot-water urn.',
    ),
    confirmedPoint('hood-noodle', -12.5, -11.5, 'wet_chemical', 'Wet-chemical system over the noodle gas line.'),
    confirmedPoint('hood-grill', -6.5, -11.5, 'wet_chemical', 'Wet-chemical system over the grill gas line.'),
    confirmedPoint('hood-fryer', -0.5, -11.5, 'wet_chemical', 'Wet-chemical system over the fryer.'),
    confirmedPoint('hood-pizza', 5.5, -11.5, 'wet_chemical', 'Wet-chemical system over the pizza gas line.'),
    confirmedPoint('hood-drinks', 11.5, -11.5, 'wet_chemical', 'Wet-chemical system on the drinks-stall back wall.'),
  ];
}
