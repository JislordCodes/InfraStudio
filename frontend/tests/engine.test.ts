import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as WebIFC from 'web-ifc';
import { IfcEngine } from '../src/engine/ifcEngine.ts';
import { buildSchedule } from '../src/engine/schedule.ts';
import { runRules, DEFAULT_LIMITS } from '../src/engine/rules.ts';
import { parseQuestion, runQuery, validateQuery } from '../src/engine/query.ts';
import { findOverlaps } from '../src/engine/overlaps.ts';
import { layoutSheet, planLevels, sheetToSvg } from '../src/engine/drawings.ts';
import type { ModelTable } from '../src/engine/types.ts';

const FIXTURE = path.resolve(__dirname, 'fixtures/office.ifc');
let api: WebIFC.IfcAPI;

const load = (): { eng: IfcEngine; table: ModelTable } => {
  const eng = new IfcEngine(api);
  const table = eng.open(new Uint8Array(fs.readFileSync(FIXTURE)));
  return { eng, table };
};

beforeAll(async () => {
  api = new WebIFC.IfcAPI();
  api.SetWasmPath(path.resolve(__dirname, '../node_modules/web-ifc') + path.sep, true);
  await api.Init();
});

describe('engine: reading', () => {
  it('measures every element from its geometry', () => {
    const { table } = load();
    expect(table.elements.length).toBe(138);
    const wall = table.elements.find((e) => e.name === 'Reception_Wall_South')!;
    expect(wall.size.length).toBeCloseTo(8, 2);
    expect(wall.size.thickness).toBeCloseTo(0.2, 2);
    expect(wall.size.height).toBeCloseTo(3.2, 2);
    // 8 x 0.2 x 3.2 = 5.12 m3 less the door and window openings cut into it
    expect(wall.volume).toBeGreaterThan(4);
    expect(wall.volume).toBeLessThan(5.12);
    expect(wall.storey).toBe('Level 0');
    expect(wall.materials.length).toBeGreaterThan(0);
  });
});

describe('engine: editing', () => {
  it('moves, resizes, renames and deletes, and the saved file shows the edits', () => {
    const { eng, table } = load();
    const wall = table.elements.find((e) => e.name === 'Reception_Wall_South')!;
    const door = table.elements.find((e) => e.cls === 'IfcDoor')!;

    let r = eng.apply({ kind: 'move', ids: [wall.id], delta: [1, 2, 0.5] });
    expect(r.ok).toBe(true);
    let w = r.table.elements.find((e) => e.id === wall.id)!;
    expect(w.bbox[0]).toBeCloseTo(wall.bbox[0] + 1, 2);
    expect(w.bbox[1]).toBeCloseTo(wall.bbox[1] + 2, 2);
    expect(w.bbox[2]).toBeCloseTo(wall.bbox[2] + 0.5, 2);

    // raising a wall keeps its base where it is
    const base = w.bbox[2];
    r = eng.apply({ kind: 'resizeBy', id: wall.id, dim: 'height', size: 4.2, anchor: 'base' });
    expect(r.ok).toBe(true);
    w = r.table.elements.find((e) => e.id === wall.id)!;
    expect(w.size.height).toBeCloseTo(4.2, 2);
    expect(w.bbox[2]).toBeCloseTo(base, 2);

    // widening a door keeps its centre where it is
    const cx = (door.bbox[0] + door.bbox[3]) / 2;
    r = eng.apply({ kind: 'resizeBy', id: door.id, dim: 'length', size: 1.2, anchor: 'centre' });
    expect(r.ok).toBe(true);
    const d = r.table.elements.find((e) => e.id === door.id)!;
    expect(d.size.length).toBeCloseTo(1.2, 2);
    expect((d.bbox[0] + d.bbox[3]) / 2).toBeCloseTo(cx, 1);

    r = eng.apply({ kind: 'rename', id: door.id, name: 'Main Entrance' });
    expect(r.table.elements.find((e) => e.id === door.id)!.name).toBe('Main Entrance');

    r = eng.apply({ kind: 'delete', ids: [door.id] });
    expect(r.ok).toBe(true);
    expect(r.table.elements.length).toBe(137);

    // a second engine reading the saved bytes sees the same model
    const again = new IfcEngine(api);
    const t2 = again.open(eng.save());
    expect(t2.elements.length).toBe(137);
    expect(t2.elements.find((e) => e.id === wall.id)!.size.height).toBeCloseTo(4.2, 2);
    expect(t2.elements.find((e) => e.id === door.id)).toBeUndefined();
  });

  it('refuses a resize it cannot do instead of corrupting the model', () => {
    const { eng, table } = load();
    const chair = table.elements.find((e) => e.cls === 'IfcFurniture')!;
    const info = eng.getEditInfo(chair.id)!;
    expect(info.movable).toBe(true);
    expect(info.resizable).toBe(false);
    const r = eng.apply({ kind: 'resizeBy', id: chair.id, dim: 'height', size: 2, anchor: 'base' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('schedule', () => {
  it('follows the geometry: a taller wall changes the quantities and cost', () => {
    const { eng, table } = load();
    const before = buildSchedule(table);
    const wall = table.elements.find((e) => e.cls === 'IfcWall')!;
    const res = eng.apply({ kind: 'resizeBy', id: wall.id, dim: 'height', size: wall.size.height * 2, anchor: 'base' });
    const after = buildSchedule(res.table);
    const rowB = before.rows.find((r) => r.cls === 'IfcWall')!;
    const rowA = after.rows.find((r) => r.cls === 'IfcWall')!;
    expect(rowA.count).toBe(rowB.count);
    expect(rowA.area).toBeGreaterThan(rowB.area);
    expect(after.totalCost).toBeGreaterThan(before.totalCost);
    expect(before.totalElements).toBe(138);
  });
});

describe('rules', () => {
  it('flags a narrow door and the fix clears it', () => {
    const { eng, table } = load();
    expect(runRules(table).findings.filter((f) => f.rule === 'door-width').length).toBe(0);
    const door = table.elements.find((e) => e.cls === 'IfcDoor')!;
    const narrowed = eng.apply({ kind: 'resizeBy', id: door.id, dim: 'length', size: 0.7, anchor: 'centre' });
    const report = runRules(narrowed.table);
    const hit = report.findings.find((f) => f.rule === 'door-width' && f.elementId === door.id)!;
    expect(hit).toBeTruthy();
    expect(hit.required).toBe(DEFAULT_LIMITS.doorWidth);
    const fixed = eng.apply(hit.fix!.op);
    expect(runRules(fixed.table).findings.some((f) => f.rule === 'door-width' && f.elementId === door.id)).toBe(false);
  });
});

describe('ask the model', () => {
  it('answers common questions on the device', () => {
    const { table } = load();
    const doors = table.elements.filter((e) => e.cls === 'IfcDoor').length;

    const q1 = parseQuestion('How many doors are there?', table)!;
    expect(q1.show).toBe('count');
    expect(runQuery(table, q1).ids.length).toBe(doors);

    const q2 = parseQuestion('total area of walls', table)!;
    expect(q2.show).toBe('sum');
    const a2 = runQuery(table, q2);
    expect(a2.text).toMatch(/Total area of 72 walls/);

    const q3 = parseQuestion('how many windows on Level 0', table)!;
    expect(runQuery(table, q3).ids.length).toBe(13);

    const q4 = parseQuestion('which levels have no fire doors', table)!;
    expect(q4.show).toBe('group');
    const a4 = runQuery(table, q4);
    expect(a4.rows.map((r) => r.label)).toContain('Level 0');
  });

  it('only accepts well-formed queries from the server', () => {
    expect(validateQuery({ filters: [{ field: 'class', op: 'is', value: 'IfcDoor' }], show: 'count' })).not.toBeNull();
    expect(validateQuery({ filters: [{ field: 'dropTable', op: 'is', value: 'x' }], show: 'count' })).toBeNull();
    expect(validateQuery({ filters: [], show: 'explode' })).toBeNull();
    expect(validateQuery('hello')).toBeNull();
  });
});

describe('overlaps and drawings', () => {
  it('finds overlaps without failing', () => {
    const { table } = load();
    expect(Array.isArray(findOverlaps(table.elements))).toBe(true);
  });

  it('cuts a plan and lays it out on an A3 sheet', () => {
    const { eng, table } = load();
    const lv = planLevels(table)[0];
    const cut = eng.slice({ kind: 'plan', z: lv.elevation + 1.2 });
    expect(cut.segments.length).toBeGreaterThan(50);
    const sheet = layoutSheet({ segments: cut.segments, kind: 'plan', title: 'Level 0 plan', project: table.project, number: 'A-101' });
    expect(sheet.scale).toMatch(/^1:\d+$/);
    expect(sheet.items.length).toBeGreaterThan(100);
    const svg = sheetToSvg(sheet);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Level 0 plan');
  });

  it('cuts a section through the model', () => {
    const { eng, table } = load();
    const mid = (table.bbox![1] + table.bbox![4]) / 2;
    const cut = eng.slice({ kind: 'sectionY', y: mid });
    expect(cut.segments.length).toBeGreaterThan(10);
  });
});

describe('pdf and bcf output', () => {
  it('writes a real PDF from the sheets', async () => {
    const { sheetsToPdf } = await import('../src/engine/drawings.ts');
    const { eng, table } = load();
    const lv = planLevels(table)[0];
    const cut = eng.slice({ kind: 'plan', z: lv.elevation + 1.2 });
    const sheet = layoutSheet({ segments: cut.segments, kind: 'plan', title: 'Level 0 plan', project: table.project, number: 'A-101' });
    const blob = await sheetsToPdf([sheet, sheet]);
    const head = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 5));
    expect(head).toBe('%PDF-');
    expect(blob.size).toBeGreaterThan(5000);
  });

  it('writes a BCF file with one topic per comment', async () => {
    const { buildBcf } = await import('../src/lib/review.ts');
    const { unzipSync, strFromU8 } = await import('fflate');
    const review = {
      id: 'abcdefghijkl', title: 'Test', project: 'Office', created: '2026-11-21T10:00:00.000Z', modelUrl: 'https://x',
      comments: [
        { id: 'c1', guid: '3WYZvcJmT7Xh_XA_dhMjJ_', elementName: 'Wall', cls: 'IfcWall', text: 'Make this <taller> & thicker', author: 'Ada', created: '2026-11-21T10:05:00.000Z', resolved: false },
      ],
    };
    const zip = unzipSync(buildBcf(review, new Map([['3WYZvcJmT7Xh_XA_dhMjJ_', [1, 2, 3]]])));
    const names = Object.keys(zip);
    expect(names).toContain('bcf.version');
    const markup = names.find((n) => n.endsWith('markup.bcf'))!;
    const xml = strFromU8(zip[markup]);
    expect(xml).toContain('Make this &lt;taller&gt; &amp; thicker');
    const vp = strFromU8(zip[names.find((n) => n.endsWith('.bcfv'))!]);
    expect(vp).toContain('IfcGuid="3WYZvcJmT7Xh_XA_dhMjJ_"');
  });
});

describe('summarizeModel', () => {
  it('describes the model in IFC terms for the chat', async () => {
    const { summarizeModel } = await import('../src/engine/summary.ts');
    const { buildSchedule } = await import('../src/engine/schedule.ts');
    const { runRules } = await import('../src/engine/rules.ts');
    const { eng, table } = load();
    const text = summarizeModel(table, buildSchedule(table), runRules(table), 0);
    expect(text).toContain('IFC entity types');
    expect(text).toContain('IfcWall');
    expect(text).toContain('Estimated construction cost');
    expect(text).toContain('Plan view from above');
    expect(text).toContain('Side view');
    if (process.env.SHOW_SUMMARY) fs.writeFileSync(process.env.SHOW_SUMMARY, text);
    expect(text).toMatch(/Elements: [0-9]+/);
    eng.dispose();
  });
});
