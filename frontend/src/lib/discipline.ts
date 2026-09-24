import type * as FRAGS from '@thatopen/fragments';

export type DisciplineBucket = 'structure' | 'envelope' | 'mep' | 'other';

export const DISCIPLINE_LABELS: Record<DisciplineBucket, string> = {
  structure: 'Structure',
  envelope: 'Envelope',
  mep: 'MEP',
  other: 'Other',
};

/** Load-bearing / primary structure - columns, beams, slabs, foundations,
 *  generic structural members and connections. */
const STRUCTURE_CATEGORIES = new Set([
  'IFCCOLUMN', 'IFCBEAM', 'IFCSLAB', 'IFCFOOTING', 'IFCPILE', 'IFCMEMBER',
  'IFCPLATE', 'IFCREINFORCINGBAR', 'IFCREINFORCINGMESH', 'IFCREINFORCINGELEMENT',
  'IFCTENDON', 'IFCTENDONANCHOR', 'IFCWALLSTANDARDCASE', 'IFCMECHANICALFASTENER',
]);

/** Envelope / architecture - the enclosure and fit-out a person actually sees
 *  and moves through: walls, openings, roof, finishes, circulation. */
const ENVELOPE_CATEGORIES = new Set([
  'IFCWALL', 'IFCCURTAINWALL', 'IFCWINDOW', 'IFCDOOR', 'IFCROOF', 'IFCCOVERING',
  'IFCRAILING', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT',
  'IFCFURNISHINGELEMENT', 'IFCSPACE', 'IFCBUILDINGELEMENTPART', 'IFCSHADINGDEVICE',
]);

/** Mechanical, electrical & plumbing - ductwork, piping, cabling and the
 *  equipment/terminals hanging off them. Only ever populated for models
 *  whose generation pipeline actually produced MEP systems. */
const MEP_CATEGORIES = new Set([
  'IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCDUCTSILENCER', 'IFCPIPESEGMENT', 'IFCPIPEFITTING',
  'IFCCABLECARRIERSEGMENT', 'IFCCABLECARRIERFITTING', 'IFCCABLESEGMENT', 'IFCCABLEFITTING',
  'IFCFLOWTERMINAL', 'IFCFLOWCONTROLLER', 'IFCFLOWFITTING', 'IFCFLOWMOVINGDEVICE',
  'IFCFLOWSTORAGEDEVICE', 'IFCFLOWTREATMENTDEVICE', 'IFCAIRTERMINAL', 'IFCAIRTERMINALBOX',
  'IFCBOILER', 'IFCCHILLER', 'IFCCOIL', 'IFCCOMPRESSOR', 'IFCCONDENSER', 'IFCCOOLINGTOWER',
  'IFCPUMP', 'IFCFAN', 'IFCFILTER', 'IFCHEATEXCHANGER', 'IFCHUMIDIFIER', 'IFCTANK',
  'IFCSANITARYTERMINAL', 'IFCELECTRICAPPLIANCE', 'IFCLIGHTFIXTURE', 'IFCOUTLET',
  'IFCSWITCHINGDEVICE', 'IFCTRANSFORMER', 'IFCMOTORCONNECTION', 'IFCALARM', 'IFCSENSOR',
  'IFCCONTROLLER', 'IFCDISTRIBUTIONCHAMBERELEMENT', 'IFCDISTRIBUTIONBOARD',
  'IFCELECTRICDISTRIBUTIONBOARD', 'IFCELECTRICFLOWSTORAGEDEVICE', 'IFCELECTRICGENERATOR',
  'IFCELECTRICMOTOR', 'IFCELECTRICTIMECONTROL', 'IFCJUNCTIONBOX', 'IFCPROTECTIVEDEVICE',
  'IFCUNITARYEQUIPMENT', 'IFCVALVE', 'IFCVIBRATIONISOLATOR', 'IFCWASTETERMINAL',
]);

/** Everything else - unclassified/custom proxies and anything not covered above.
 *  Deliberately a catch-all rather than dropped, so no element goes untoggleable. */
export function classifyDiscipline(category: string): DisciplineBucket {
  const c = category.toUpperCase();
  if (STRUCTURE_CATEGORIES.has(c)) return 'structure';
  if (ENVELOPE_CATEGORIES.has(c)) return 'envelope';
  if (MEP_CATEGORIES.has(c)) return 'mep';
  return 'other';
}

export interface DisciplineGroup {
  model: FRAGS.FragmentsModel;
  ids: number[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Buckets every element with geometry, across all currently loaded models,
 *  by discipline - the layer-isolation counterpart to computeModelSummary's
 *  per-class tally. Only buckets that end up with at least one element are
 *  present in the result, so the UI can show pills only for disciplines that
 *  actually exist in THIS model (e.g. a bridge never gets an "MEP" pill). */
export async function computeDisciplineGroups(
  models: FRAGS.FragmentsModel[],
): Promise<Partial<Record<DisciplineBucket, DisciplineGroup[]>>> {
  const groups: Partial<Record<DisciplineBucket, DisciplineGroup[]>> = {};

  for (const model of models) {
    try {
      const categories = await model.getCategories();
      if (!categories.length) continue;
      const geometryIds = new Set(await model.getItemsIdsWithGeometry());
      const patterns = categories.map((c) => new RegExp(`^${escapeRegExp(c)}$`));
      const grouped = await model.getItemsOfCategories(patterns);

      const byBucket = new Map<DisciplineBucket, number[]>();
      for (const [category, localIds] of Object.entries(grouped)) {
        if (!localIds || !localIds.length) continue;
        const withGeometry = localIds.filter((id) => geometryIds.has(id));
        if (!withGeometry.length) continue;
        const bucket = classifyDiscipline(category);
        const existing = byBucket.get(bucket);
        if (existing) existing.push(...withGeometry);
        else byBucket.set(bucket, [...withGeometry]);
      }

      for (const [bucket, ids] of byBucket) {
        const list = groups[bucket] ?? (groups[bucket] = []);
        list.push({ model, ids });
      }
    } catch (e) {
      console.warn('[discipline] classification failed:', e);
    }
  }

  return groups;
}
