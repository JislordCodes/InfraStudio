import * as FRAGS from '@thatopen/fragments';
import type * as OBC from '@thatopen/components';
import type { DisciplineBucket, DisciplineGroup } from './discipline';

/** Order used both for the x-ray pills and here: index in this array becomes
 *  the vertical rank when exploded - structure (index 0) never moves, each
 *  further discipline present stacks one step higher above it. */
const EXPLODE_ORDER: DisciplineBucket[] = ['structure', 'envelope', 'mep', 'other'];

interface TransformEntry {
  transformId: number;
  position: number[];
  xDirection: number[];
  yDirection: number[];
}

/** itemId -> its global transform record. Edits address the TRANSFORM's own
 *  id, a separate id space from the item's local id (confirmed live against
 *  a real model - getGlobalTransformsIds() and getLocalIds() don't overlap
 *  at all), so this index has to be built before any item can be moved. */
async function buildTransformIndex(model: FRAGS.FragmentsModel): Promise<Map<number, TransformEntry>> {
  const transformIds = await model.getGlobalTransformsIds();
  const raw = await model.getGlobalTransforms(transformIds);
  const index = new Map<number, TransformEntry>();
  for (const [transformId, data] of raw.entries()) {
    const itemId = data.itemId;
    if (typeof itemId !== 'number') continue;
    index.set(itemId, {
      transformId: transformId as number,
      position: data.position,
      xDirection: data.xDirection,
      yDirection: data.yDirection,
    });
  }
  return index;
}

/** Vertically separates every discipline bucket PRESENT in `groups` by
 *  `step` metres, in EXPLODE_ORDER - the base layer stays put, each bucket
 *  after it stacks one step higher. Purely a live, in-memory geometry edit
 *  (Editor.edit / UPDATE_GLOBAL_TRANSFORM); the "Download IFC" button links
 *  straight to the original S3 file, so this never touches the source IFC. */
export async function applyExplode(
  fragments: OBC.FragmentsManager,
  groups: Partial<Record<DisciplineBucket, DisciplineGroup[]>>,
  step: number,
): Promise<void> {
  const present = EXPLODE_ORDER.filter((bucket) => (groups[bucket]?.length ?? 0) > 0);
  const editor = fragments.core.editor;
  const indexCache = new Map<FRAGS.FragmentsModel, Map<number, TransformEntry>>();

  for (let rank = 0; rank < present.length; rank++) {
    const offset = rank * step;
    if (offset === 0) continue; // base layer - left exactly where it was generated
    const bucket = present[rank];

    for (const { model, ids } of groups[bucket] || []) {
      let index = indexCache.get(model);
      if (!index) {
        index = await buildTransformIndex(model);
        indexCache.set(model, index);
      }

      const requests: FRAGS.UpdateGlobalTransformRequest[] = [];
      for (const id of ids) {
        const entry = index.get(id);
        if (!entry) continue;
        const [x, y, z] = entry.position;
        requests.push({
          type: FRAGS.EditRequestType.UPDATE_GLOBAL_TRANSFORM,
          localId: entry.transformId,
          data: {
            position: [x, y + offset, z],
            xDirection: entry.xDirection,
            yDirection: entry.yDirection,
            itemId: id,
          },
        });
      }
      if (requests.length) await editor.edit(model.modelId, requests);
    }
  }
}

/** Reverts every edit applyExplode made, per model. editor.reset() restores
 *  each model's pristine loaded state in one call regardless of how many
 *  items were moved - safe here because nothing else in this app ever
 *  calls into the Editor, so there's no other edit history to lose. */
export async function resetExplode(fragments: OBC.FragmentsManager, models: FRAGS.FragmentsModel[]): Promise<void> {
  const editor = fragments.core.editor;
  for (const model of models) {
    try {
      await editor.reset(model.modelId);
    } catch (e) {
      console.warn('[explode] reset failed:', e);
    }
  }
}
