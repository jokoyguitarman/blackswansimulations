/** Food-court plan from the approved environment note.
 * Walls, exits, and the blast marker only. The old hazard circles were stand-ins
 * for fuel the editor could not name. This sample leaves them out so a blast on
 * the tile has no confirmed fuel until a trainer places an object.
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
    "locationDescription": "Single-storey food court. North side is five kitchen stalls and a concrete service corridor. The open court to the south is bare tile. The blast marker sits on that tile. Furniture is placed as objects, not hazard circles.",
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
