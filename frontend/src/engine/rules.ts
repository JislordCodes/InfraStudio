/**
 * Screening checks against common building-code values. Every check reads real measurements
 * from the model. These are screening results for early design, not a compliance certificate:
 * the values come from the International Building Code and the user can read and change them.
 */
import type { EditOp, ElementRecord, ModelTable } from './types.ts';

export interface RuleLimits {
  /** minimum overall door width, m (IBC 1010.1.1 asks for 32 in clear, about 0.90 m overall) */
  doorWidth: number;
  /** minimum door height, m (IBC 1010.1.1, 80 in) */
  doorHeight: number;
  /** doors wider than this are gates or openings, not checked */
  doorMaxChecked: number;
  /** minimum guard height, m (IBC 1015.3, 42 in) */
  guardHeight: number;
  /** minimum stair width, m (IBC 1011.2 allows 36 in for small occupant loads) */
  stairWidth: number;
  /** longest straight walk to a stair or exit door, m (IBC 1017, 200 ft) */
  travelDistance: number;
  /** glazing as a share of floor area (IBC 1205.2, 8 percent) */
  glazingShare: number;
}

export const DEFAULT_LIMITS: RuleLimits = {
  doorWidth: 0.9,
  doorHeight: 2.03,
  doorMaxChecked: 3.0,
  guardHeight: 1.07,
  stairWidth: 0.91,
  travelDistance: 61,
  glazingShare: 0.08,
};

export interface RuleInfo {
  id: string;
  title: string;
  source: string;
}

export const RULES: RuleInfo[] = [
  { id: 'door-width', title: 'Door width', source: 'IBC 1010.1.1' },
  { id: 'door-height', title: 'Door height', source: 'IBC 1010.1.1' },
  { id: 'guard-height', title: 'Guard and railing height', source: 'IBC 1015.3' },
  { id: 'stair-width', title: 'Stair width', source: 'IBC 1011.2' },
  { id: 'travel', title: 'Distance to nearest stair or exit', source: 'IBC 1017' },
  { id: 'daylight', title: 'Natural light (glazing share)', source: 'IBC 1205.2' },
];

export interface Finding {
  rule: string;
  severity: 'fail' | 'warn';
  /** the element to highlight, if the finding is about one */
  elementId?: number;
  /** more elements to highlight for a finding about a storey */
  extraIds?: number[];
  elementName: string;
  cls: string;
  storey: string | null;
  message: string;
  actual: number;
  required: number;
  fix?: { label: string; op: EditOp };
}

export interface RuleSummary {
  rule: RuleInfo;
  checked: number;
  failed: number;
}

export interface RuleReport {
  findings: Finding[];
  summaries: RuleSummary[];
}

const m = (n: number) => `${n.toFixed(2)} m`;

const isStairLike = (c: string) => c === 'IfcStair' || c === 'IfcStairFlight' || c === 'IfcRamp' || c === 'IfcRampFlight';

/** Rooms and plant doors that people do not walk through are not held to the door rule. */
const NOT_A_DOOR = /(hatch|riser|duct|shaft|cupboard|closet|plant|service|access panel|garage|vehicle|roller|shutter|gate|loading)/i;

function centre(r: ElementRecord): [number, number] {
  return [(r.bbox[0] + r.bbox[3]) / 2, (r.bbox[1] + r.bbox[4]) / 2];
}

export function runRules(table: ModelTable, limits: RuleLimits = DEFAULT_LIMITS): RuleReport {
  const findings: Finding[] = [];
  const checked: Record<string, number> = {};
  const bump = (id: string) => (checked[id] = (checked[id] ?? 0) + 1);

  for (const e of table.elements) {
    if (e.cls === 'IfcDoor' && !NOT_A_DOOR.test(e.name) && e.size.length <= limits.doorMaxChecked && e.size.length >= 0.3) {
      bump('door-width');
      if (e.size.length < limits.doorWidth - 0.005) {
        findings.push({
          rule: 'door-width', severity: 'fail', elementId: e.id, elementName: e.name || 'Door', cls: e.cls, storey: e.storey,
          message: `Door is ${m(e.size.length)} wide. The minimum is ${m(limits.doorWidth)}.`,
          actual: e.size.length, required: limits.doorWidth,
          fix: { label: `Widen to ${m(limits.doorWidth)}`, op: { kind: 'resizeBy', id: e.id, dim: 'length', size: limits.doorWidth, anchor: 'centre' } },
        });
      }
      bump('door-height');
      if (e.size.height < limits.doorHeight - 0.005) {
        findings.push({
          rule: 'door-height', severity: 'fail', elementId: e.id, elementName: e.name || 'Door', cls: e.cls, storey: e.storey,
          message: `Door is ${m(e.size.height)} high. The minimum is ${m(limits.doorHeight)}.`,
          actual: e.size.height, required: limits.doorHeight,
          fix: { label: `Raise to ${m(limits.doorHeight)}`, op: { kind: 'resizeBy', id: e.id, dim: 'height', size: limits.doorHeight, anchor: 'base' } },
        });
      }
    }

    if (e.cls === 'IfcRailing' && e.size.length >= 0.5 && e.size.height >= 0.3 && e.size.height <= 3) {
      bump('guard-height');
      if (e.size.height < limits.guardHeight - 0.005) {
        findings.push({
          rule: 'guard-height', severity: 'fail', elementId: e.id, elementName: e.name || 'Railing', cls: e.cls, storey: e.storey,
          message: `Railing is ${m(e.size.height)} high. The minimum is ${m(limits.guardHeight)}.`,
          actual: e.size.height, required: limits.guardHeight,
          fix: { label: `Raise to ${m(limits.guardHeight)}`, op: { kind: 'resizeBy', id: e.id, dim: 'height', size: limits.guardHeight, anchor: 'base' } },
        });
      }
    }

    if (isStairLike(e.cls) && e.cls !== 'IfcRamp' && e.cls !== 'IfcRampFlight') {
      bump('stair-width');
      const width = Math.min(e.size.length, e.size.thickness);
      if (width < limits.stairWidth - 0.005) {
        findings.push({
          rule: 'stair-width', severity: 'warn', elementId: e.id, elementName: e.name || 'Stair', cls: e.cls, storey: e.storey,
          message: `Stair is ${m(width)} wide. The minimum is ${m(limits.stairWidth)}.`,
          actual: width, required: limits.stairWidth,
        });
      }
    }
  }

  travelFindings(table, limits, findings, bump);
  daylightFindings(table, limits, findings, bump);

  const summaries: RuleSummary[] = RULES.map((rule) => ({
    rule,
    checked: checked[rule.id] ?? 0,
    failed: findings.filter((f) => f.rule === rule.id).length,
  }));
  return { findings, summaries };
}

/** Floor footprint of a storey: its slab boxes. */
function storeySlabs(table: ModelTable, storey: string): ElementRecord[] {
  return table.elements.filter((e) => e.cls === 'IfcSlab' && e.storey === storey && e.size.height <= 1.2);
}

function travelFindings(table: ModelTable, limits: RuleLimits, out: Finding[], bump: (id: string) => void): void {
  for (const s of table.storeys) {
    const slabs = storeySlabs(table, s.name);
    const area = slabs.reduce((a, r) => a + r.area, 0);
    if (area < 100) continue;
    const top = s.elevation + 4;
    const exits: [number, number][] = [];
    for (const e of table.elements) {
      if (isStairLike(e.cls) && e.bbox[2] <= top && e.bbox[5] >= s.elevation - 0.2) exits.push(centre(e));
    }
    const ground = s.elevation <= 0.5;
    if (ground) {
      // At ground level a door on the building's edge leads outside.
      const foot = slabs.reduce((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[3]), Math.max(b[3], r.bbox[4])], [Infinity, Infinity, -Infinity, -Infinity]);
      for (const e of table.elements) {
        if (e.cls !== 'IfcDoor' || e.storey !== s.name) continue;
        const [cx, cy] = centre(e);
        const edge = Math.min(cx - foot[0], foot[2] - cx, cy - foot[1], foot[3] - cy);
        if (edge < 1.5) exits.push([cx, cy]);
      }
    }
    bump('travel');
    if (!exits.length) {
      out.push({
        rule: 'travel', severity: 'warn', extraIds: slabs.map((r) => r.id), elementName: s.name, cls: 'IfcBuildingStorey', storey: s.name,
        message: `No stair or exit door found on ${s.name}.`, actual: Infinity, required: limits.travelDistance,
      });
      continue;
    }
    // Sample the floor on a grid and find the point farthest from any exit.
    let worst = 0;
    const step = Math.max(4, Math.sqrt(area) / 12);
    for (const sl of slabs) {
      for (let x = sl.bbox[0] + step / 2; x < sl.bbox[3]; x += step) {
        for (let y = sl.bbox[1] + step / 2; y < sl.bbox[4]; y += step) {
          let best = Infinity;
          for (const [ex, ey] of exits) best = Math.min(best, Math.hypot(x - ex, y - ey));
          if (best > worst) worst = best;
        }
      }
    }
    if (worst > limits.travelDistance) {
      out.push({
        rule: 'travel', severity: 'warn', extraIds: slabs.map((r) => r.id), elementName: s.name, cls: 'IfcBuildingStorey', storey: s.name,
        message: `Part of ${s.name} is ${worst.toFixed(0)} m in a straight line from the nearest stair or exit. The limit is ${limits.travelDistance} m.`,
        actual: worst, required: limits.travelDistance,
      });
    }
  }
}

function daylightFindings(table: ModelTable, limits: RuleLimits, out: Finding[], bump: (id: string) => void): void {
  for (const s of table.storeys) {
    const slabs = storeySlabs(table, s.name);
    const floor = slabs.reduce((a, r) => a + r.area, 0);
    if (floor < 40) continue;
    const windows = table.elements.filter((e) => (e.cls === 'IfcWindow' || e.cls === 'IfcCurtainWall') && e.storey === s.name);
    const glazing = windows.reduce((a, w) => a + (w.cls === 'IfcWindow' ? w.size.length * w.size.height : w.area), 0);
    bump('daylight');
    const share = glazing / floor;
    if (share < limits.glazingShare) {
      out.push({
        rule: 'daylight', severity: 'warn', extraIds: windows.map((w) => w.id), elementName: s.name, cls: 'IfcBuildingStorey', storey: s.name,
        message: `Glazing on ${s.name} is ${(share * 100).toFixed(1)} percent of the floor area. The minimum is ${(limits.glazingShare * 100).toFixed(0)} percent.`,
        actual: share, required: limits.glazingShare,
      });
    }
  }
}
