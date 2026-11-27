/**
 * The office fire as the RTS page's Preview Hazard Effects button sees it
 * after "Load office tower": the same studs, building, fuel, walls and blast.
 */
import { projectPolygon } from '../../src/lib/evacuation/geometry.ts';
import type { ExitDef } from '../../src/lib/evacuation/types.ts';
import { defaultCharge } from '../../src/lib/rts/blast/blastModel.ts';
import { storeyId } from '../../src/lib/rts/effectsBuilding.ts';
import type { PreviewInput } from '../../src/lib/rts/effectsPreview.ts';
import {
  officeTowerFuelObjects,
  officeTowerSample,
  officeTowerStuds,
} from '../../src/lib/rts/officeTowerFire.ts';
import { projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import type { InteriorWall, LevelDef } from '../../src/lib/rts/types.ts';

export function officePreviewInput(): { input: PreviewInput; walls: InteriorWall[] } {
  const scene = officeTowerSample.scene;
  const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
  const projected = projectSceneStuds(polygon, officeTowerStuds(polygon));
  const studs = projected.map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext,
    level: storeyId(stud.floor),
  }));
  const radius = scene.blastSite.manualRadiusM;
  return {
    input: {
      studs,
      building: {
        stairwells: scene.stairwells,
        levels: scene.levels as LevelDef[],
        vertices: projectPolygon(polygon),
        exits: scene.exits as unknown as ExitDef[],
      },
      objects: officeTowerFuelObjects(
        projected.map((stud) => ({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor,
        })),
      ),
      hazardZones: [],
      charge: defaultCharge(),
      blast: {
        pos: { x: scene.blastSite.x, y: scene.blastSite.y },
        level: 'G',
        spreadRadius: radius,
        affectRadius: radius,
      },
      hoodFanWhen: scene.hoodFanWhen,
    },
    walls: scene.interiorWalls.map((wall) => ({ ...wall })),
  };
}
