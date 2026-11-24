// A short text description of the open model, sent along with a chat question
// so the assistant can answer from the real model instead of guessing.

import type { ModelTable } from './types';
import { CURRENCY, formatMoney, formatQuantity, type Schedule } from './schedule';
import type { RuleReport } from './rules';

const MAX_CLASSES = 18;

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** Drawing priority: later entries are drawn over earlier ones. */
const GLYPHS: [string, string][] = [
  ['IfcRoof', 'r'],
  ['IfcSlab', 's'],
  ['IfcCovering', 'c'],
  ['IfcBeam', 'b'],
  ['IfcMember', 'm'],
  ['IfcFurnishingElement', 'f'],
  ['IfcFurniture', 'f'],
  ['IfcRailing', 'l'],
  ['IfcWall', 'W'],
  ['IfcWallStandardCase', 'W'],
  ['IfcCurtainWall', 'W'],
  ['IfcColumn', 'C'],
  ['IfcStair', 'T'],
  ['IfcStairFlight', 'T'],
  ['IfcWindow', 'N'],
  ['IfcDoor', 'D'],
];
const PRIORITY = new Map(GLYPHS.map(([cls], i) => [cls, i]));
const GLYPH = new Map(GLYPHS);

/** A text drawing of the model from above and from the side, so the chat
 *  assistant can reason about shape and layout, not just counts. */
export function sketchModel(table: ModelTable): string[] {
  const b = table.bbox;
  if (!b) return [];
  const s = table.unitScale || 1;
  const dx = Math.max(1e-6, b[3] - b[0]);
  const dy = Math.max(1e-6, b[4] - b[1]);
  const dz = Math.max(1e-6, b[5] - b[2]);

  type Grid = { prio: number; ch: string }[][];
  const blank = (rows: number, cols: number): Grid =>
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ prio: -1, ch: '.' })));
  const render = (g: Grid) => g.map((row) => row.map((c) => c.ch).join('')).join('\n');

  // Characters are about twice as tall as wide, so a row covers twice the length of a column.
  const colW = Math.max(dx / 48, dy / 48);
  const cols = Math.max(1, Math.ceil(dx / colW));
  const rows = Math.max(1, Math.ceil(dy / (2 * colW)));
  const plan = blank(rows, cols);
  const eRows = 14;
  const eColW = dx / 48;
  const eCols = Math.max(1, Math.ceil(dx / eColW));
  const eRowH = dz / eRows;
  const elev = blank(eRows, eCols);

  const paint = (g: Grid, r0: number, r1: number, c0: number, c1: number, prio: number, ch: string) => {
    for (let r = Math.max(0, r0); r <= Math.min(g.length - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(g[0].length - 1, c1); c++) {
        if (prio >= g[r][c].prio) g[r][c] = { prio, ch };
      }
    }
  };

  for (const e of table.elements) {
    const prio = PRIORITY.get(e.cls);
    if (prio === undefined) continue;
    const ch = GLYPH.get(e.cls)!;
    const c0 = Math.floor((e.bbox[0] - b[0]) / colW);
    const c1 = Math.floor((e.bbox[3] - b[0]) / colW - 1e-9);
    // North (larger y) is the top row.
    const r0 = Math.floor((b[4] - e.bbox[4]) / (2 * colW));
    const r1 = Math.floor((b[4] - e.bbox[1]) / (2 * colW) - 1e-9);
    paint(plan, r0, r1, c0, Math.max(c0, c1), prio, ch);
    const ec0 = Math.floor((e.bbox[0] - b[0]) / eColW);
    const ec1 = Math.floor((e.bbox[3] - b[0]) / eColW - 1e-9);
    const er0 = Math.floor((b[5] - e.bbox[5]) / eRowH);
    const er1 = Math.floor((b[5] - e.bbox[2]) / eRowH - 1e-9);
    paint(elev, er0, er1, ec0, Math.max(ec0, ec1), prio, ch);
  }

  return [
    'Legend: W wall, C column, D door, N window, T stair, s slab, r roof, b beam, m member, f furniture, l railing, c covering, . empty',
    `Plan view from above (north up, one column is about ${n1(colW * s)} m, one row about ${n1(2 * colW * s)} m):`,
    render(plan),
    `Side view from the south (left to right is west to east, ${n1(dz * s)} m high, one row is about ${n1(eRowH * s)} m):`,
    render(elev),
  ];
}

export function summarizeModel(
  table: ModelTable,
  schedule: Schedule,
  rules?: RuleReport | null,
  overlapCount = 0,
): string {
  const lines: string[] = [];
  lines.push(`Project: ${table.project || 'untitled'}`);
  lines.push(`Elements: ${schedule.totalElements}`);

  if (table.bbox) {
    const s = table.unitScale || 1;
    const b = table.bbox;
    lines.push(
      `Overall size: ${n1((b[3] - b[0]) * s)} m by ${n1((b[4] - b[1]) * s)} m on plan, ${n1((b[5] - b[2]) * s)} m high`,
    );
  }

  if (table.storeys.length > 0) {
    const names = table.storeys
      .slice()
      .sort((a, b) => a.elevation - b.elevation)
      .map((st) => `${st.name} at ${n1(st.elevation * (table.unitScale || 1))} m`)
      .join(', ');
    lines.push(`Storeys (${table.storeys.length}): ${names}`);
  }

  if (schedule.floorArea > 0) lines.push(`Floor slab area: ${Math.round(schedule.floorArea)} m2`);
  lines.push(`Total volume of all elements: ${Math.round(schedule.totalVolume)} m3`);

  lines.push('Elements by class (count, quantity, estimated cost):');
  for (const row of schedule.rows.slice(0, MAX_CLASSES)) {
    lines.push(`- ${row.label}: ${row.count}, ${formatQuantity(row.quantity, row.unit)}, ${formatMoney(row.cost)}`);
  }
  if (schedule.rows.length > MAX_CLASSES) lines.push(`- and ${schedule.rows.length - MAX_CLASSES} more classes`);

  if (schedule.storeys.length > 1) {
    lines.push('Elements by storey: ' + schedule.storeys.map((s) => `${s.storey} ${s.count}`).join(', '));
  }

  lines.push(
    `Estimated construction cost from the Quantities and cost panel: ${formatMoney(schedule.totalCost)} ${CURRENCY}` +
      (schedule.floorArea > 0 ? `, about ${formatMoney(schedule.totalCost / schedule.floorArea)} per m2 of floor slab` : '') +
      '. This uses indicative unit rates per element, so it is a rough order of magnitude, not a quote.',
  );

  // IFC level facts: exact entity names, materials and property sets.
  const ifcClasses = new Map<string, number>();
  const materials = new Map<string, number>();
  const psets = new Map<string, number>();
  let unnamed = 0;
  let noStorey = 0;
  for (const e of table.elements) {
    ifcClasses.set(e.cls, (ifcClasses.get(e.cls) ?? 0) + 1);
    for (const m of e.materials) materials.set(m, (materials.get(m) ?? 0) + 1);
    const seen = new Set<string>();
    for (const key of Object.keys(e.props)) {
      const set = key.split('.')[0];
      if (set && !seen.has(set)) {
        seen.add(set);
        psets.set(set, (psets.get(set) ?? 0) + 1);
      }
    }
    if (!e.name) unnamed += 1;
    if (!e.storey) noStorey += 1;
  }
  const top = (m: Map<string, number>, k: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, c]) => `${name} (${c})`).join(', ');
  lines.push(`IFC entity types (${ifcClasses.size}): ${top(ifcClasses, 24)}`);
  lines.push(materials.size > 0 ? `Materials (${materials.size}): ${top(materials, 14)}` : 'Materials: none assigned in the IFC file');
  lines.push(psets.size > 0 ? `Property sets in use: ${top(psets, 10)}` : 'Property sets: none in the IFC file');
  if (unnamed > 0) lines.push(`Elements without a Name attribute: ${unnamed}`);
  if (noStorey > 0) lines.push(`Elements not contained in a storey: ${noStorey}`);

  if (overlapCount > 0) lines.push(`Overlapping elements found: ${overlapCount}`);
  if (rules) {
    const fails = rules.findings.filter((f) => f.severity === 'fail').length;
    const warns = rules.findings.length - fails;
    lines.push(`Code check: ${fails} failures, ${warns} warnings`);
  }
  lines.push(...sketchModel(table));
  return lines.join('\n');
}
