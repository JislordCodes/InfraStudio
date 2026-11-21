/**
 * "Ask the model": questions about the elements in the model, answered from the measured data.
 *
 * A question becomes a small structured query. Common questions are understood on the device
 * with no network call. Harder ones are translated by the language model on the server into the
 * same query format, which is validated here before it runs, so the model can never run code.
 */
import { DEFAULT_RATES, humanClass, quantityOf, type RateCard } from './schedule.ts';
import type { ElementRecord, ModelTable } from './types.ts';

export type Field =
  | 'class' | 'name' | 'storey' | 'material' | 'prop'
  | 'length' | 'thickness' | 'height' | 'area' | 'volume' | 'near';
export type Op = 'is' | 'contains' | '>' | '<' | '>=' | '<=' | '=' | 'missing';

export interface Filter {
  field: Field;
  op: Op;
  value?: string | number;
  /** property key for "prop", or the class to look for nearby for "near" */
  arg?: string;
}

export interface Query {
  filters: Filter[];
  /** how to present the result */
  show: 'count' | 'list' | 'sum' | 'group';
  measure?: 'area' | 'volume' | 'length' | 'cost';
  groupBy?: 'class' | 'storey' | 'material';
  /** with groupBy: keep only groups whose count compares like this */
  having?: { op: '=' | '>' | '<' | '>=' | '<='; value: number };
}

export interface AnswerRow {
  label: string;
  value: string;
  ids: number[];
}

export interface Answer {
  text: string;
  ids: number[];
  rows: AnswerRow[];
}

const FIELDS: Field[] = ['class', 'name', 'storey', 'material', 'prop', 'length', 'thickness', 'height', 'area', 'volume', 'near'];
const OPS: Op[] = ['is', 'contains', '>', '<', '>=', '<=', '=', 'missing'];

/** Accepts only well-formed queries. Anything else returns null. */
export function validateQuery(raw: unknown): Query | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (!Array.isArray(q.filters) || q.filters.length > 8) return null;
  const filters: Filter[] = [];
  for (const f of q.filters) {
    if (!f || typeof f !== 'object') return null;
    const { field, op, value, arg } = f as Record<string, unknown>;
    if (!FIELDS.includes(field as Field) || !OPS.includes(op as Op)) return null;
    if (value != null && typeof value !== 'string' && typeof value !== 'number') return null;
    if (arg != null && typeof arg !== 'string') return null;
    filters.push({ field: field as Field, op: op as Op, value: value as string | number | undefined, arg: arg as string | undefined });
  }
  const show = q.show;
  if (show !== 'count' && show !== 'list' && show !== 'sum' && show !== 'group') return null;
  const measure = q.measure;
  if (measure != null && !['area', 'volume', 'length', 'cost'].includes(measure as string)) return null;
  const groupBy = q.groupBy;
  if (groupBy != null && !['class', 'storey', 'material'].includes(groupBy as string)) return null;
  let having: Query['having'];
  if (q.having && typeof q.having === 'object') {
    const h = q.having as Record<string, unknown>;
    if (!['=', '>', '<', '>=', '<='].includes(h.op as string) || typeof h.value !== 'number') return null;
    having = { op: h.op as '=' | '>' | '<' | '>=' | '<=', value: h.value };
  }
  return { filters, show, measure: measure as Query['measure'], groupBy: groupBy as Query['groupBy'], having };
}

/* ───────────────────────── running a query ───────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ');

function classMatches(rec: ElementRecord, value: string): boolean {
  const v = value.toLowerCase().replace(/^ifc/, '').replace(/\s+/g, '');
  const c = rec.cls.toLowerCase().replace(/^ifc/, '');
  return c === v || c === `${v}s` || `${c}s` === v;
}

function numeric(rec: ElementRecord, field: Field): number | null {
  switch (field) {
    case 'length': return rec.size.length;
    case 'thickness': return rec.size.thickness;
    case 'height': return rec.size.height;
    case 'area': return rec.area;
    case 'volume': return rec.volume;
    default: return null;
  }
}

function compare(a: number, op: Op, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '=': return Math.abs(a - b) < 1e-6 || a === b;
    default: return false;
  }
}

/** Elements that satisfy every filter. */
export function selectElements(table: ModelTable, filters: Filter[]): ElementRecord[] {
  const all = table.elements;
  const nearCache = new Map<string, ElementRecord[]>();
  const pad = 0.6;
  const byClass = (cls: string) => {
    let list = nearCache.get(cls);
    if (!list) {
      list = all.filter((e) => classMatches(e, cls));
      nearCache.set(cls, list);
    }
    return list;
  };
  return all.filter((rec) =>
    filters.every((f) => {
      switch (f.field) {
        case 'class':
          return f.op === 'missing' ? false : classMatches(rec, String(f.value ?? ''));
        case 'name':
          return norm(rec.name).includes(norm(String(f.value ?? '')));
        case 'storey': {
          const want = norm(String(f.value ?? ''));
          const have = norm(rec.storey ?? '');
          return f.op === 'is' ? have === want : have.includes(want);
        }
        case 'material': {
          if (f.op === 'missing') return rec.materials.length === 0;
          const want = norm(String(f.value ?? ''));
          return rec.materials.some((x) => norm(x).includes(want));
        }
        case 'prop': {
          const key = norm(f.arg ?? '');
          const hit = Object.entries(rec.props).filter(([k]) => norm(k).includes(key));
          if (f.op === 'missing') return hit.length === 0;
          if (!hit.length) return false;
          if (f.value == null) return true;
          return hit.some(([, v]) => norm(v).includes(norm(String(f.value))));
        }
        case 'near': {
          const others = byClass(f.arg ?? '');
          let n = 0;
          for (const o of others) {
            if (o.id === rec.id) continue;
            const a = rec.bbox, b = o.bbox;
            if (a[0] - pad <= b[3] && a[3] + pad >= b[0] && a[1] - pad <= b[4] && a[4] + pad >= b[1] && a[2] - pad <= b[5] && a[5] + pad >= b[2]) n++;
          }
          return compare(n, f.op, Number(f.value ?? 0));
        }
        default: {
          const v = numeric(rec, f.field);
          return v != null && compare(v, f.op, Number(f.value));
        }
      }
    }),
  );
}

function measureOf(rec: ElementRecord, measure: Query['measure'], rates: RateCard): number {
  switch (measure) {
    case 'area': return rec.area;
    case 'volume': return rec.volume;
    case 'length': return rec.size.length;
    case 'cost': {
      const r = rates[rec.cls];
      return r ? quantityOf(rec, r.unit) * r.rate : 0;
    }
    default: return 0;
  }
}

const unitOf = (m: Query['measure']) => (m === 'area' ? 'm²' : m === 'volume' ? 'm³' : m === 'length' ? 'm' : '');
const fmt = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 100 ? n.toFixed(1) : n.toFixed(2));

/** What the matched elements are, in words, for the answer sentence. */
function describe(q: Query): string {
  const cls = q.filters.find((f) => f.field === 'class');
  const name = q.filters.find((f) => f.field === 'name');
  const storey = q.filters.find((f) => f.field === 'storey');
  const mat = q.filters.find((f) => f.field === 'material' && f.op !== 'missing');
  const noMat = q.filters.find((f) => f.field === 'material' && f.op === 'missing');
  const parts: string[] = [];
  if (name) parts.push(String(name.value));
  if (mat) parts.push(String(mat.value));
  parts.push(cls ? humanClass(`Ifc${String(cls.value).replace(/^ifc/i, '')}`) : 'elements');
  let text = parts.join(' ');
  if (noMat) text += ' with no material';
  if (storey) text += ` on ${storey.value}`;
  return text;
}

export function runQuery(table: ModelTable, q: Query, rates: RateCard = DEFAULT_RATES): Answer {
  const hits = selectElements(table, q.filters);
  const what = describe(q);
  const ids = hits.map((h) => h.id);

  if (q.show === 'count') {
    return { text: `${hits.length} ${what}.`, ids, rows: [] };
  }
  if (q.show === 'sum') {
    const measure = q.measure ?? 'area';
    const total = hits.reduce((a, r) => a + measureOf(r, measure, rates), 0);
    const value = measure === 'cost' ? `$${fmt(total)}` : `${fmt(total)} ${unitOf(measure)}`;
    return { text: `Total ${measure} of ${hits.length} ${what}: ${value}.`, ids, rows: [] };
  }
  if (q.show === 'group') {
    const by = q.groupBy ?? 'class';
    const groups = new Map<string, ElementRecord[]>();
    // Storeys with nothing in them still count, so "which levels have no X" can answer.
    if (by === 'storey') for (const s of table.storeys) if (!groups.has(s.name)) groups.set(s.name, []);
    for (const r of hits) {
      const keys = by === 'class' ? [humanClass(r.cls)] : by === 'storey' ? [r.storey ?? 'No level'] : r.materials.length ? r.materials : ['No material'];
      for (const k of keys) {
        const g = groups.get(k);
        if (g) g.push(r);
        else groups.set(k, [r]);
      }
    }
    let rows = [...groups.entries()].map(([label, list]) => ({
      label,
      value: q.measure ? (q.measure === 'cost' ? `$${fmt(list.reduce((a, r) => a + measureOf(r, 'cost', rates), 0))}` : `${fmt(list.reduce((a, r) => a + measureOf(r, q.measure, rates), 0))} ${unitOf(q.measure)}`) : String(list.length),
      ids: list.map((r) => r.id),
      n: list.length,
    }));
    if (q.having) rows = rows.filter((r) => compare(r.n, q.having!.op as Op, q.having!.value));
    rows.sort((a, b) => b.n - a.n);
    const text = rows.length ? `${rows.length} ${by === 'storey' ? 'levels' : by === 'class' ? 'classes' : 'materials'} for ${what}.` : `Nothing matches for ${what}.`;
    return { text, ids: rows.flatMap((r) => r.ids), rows: rows.map(({ label, value, ids: rid }) => ({ label, value, ids: rid })) };
  }
  // list
  const shown = hits.slice(0, 40);
  return {
    text: hits.length ? `${hits.length} ${what}${hits.length > shown.length ? ', showing the first 40' : ''}.` : `No ${what} found.`,
    ids,
    rows: shown.map((h) => ({ label: h.name || humanClass(h.cls, false), value: h.storey ?? '', ids: [h.id] })),
  };
}

/* ───────────────────────── understanding a question on the device ───────────────────────── */

const CLASS_WORDS: [RegExp, string][] = [
  [/\bcurtain\s*walls?\b/, 'IfcCurtainWall'],
  [/\b(walls?)\b/, 'IfcWall'],
  [/\b(doors?)\b/, 'IfcDoor'],
  [/\b(windows?)\b/, 'IfcWindow'],
  [/\b(columns?|pillars?)\b/, 'IfcColumn'],
  [/\b(beams?|girders?)\b/, 'IfcBeam'],
  [/\b(slabs?|floor slabs?)\b/, 'IfcSlab'],
  [/\b(stairs?|staircases?|stairways?)\b/, 'IfcStair'],
  [/\b(roofs?|domes?)\b/, 'IfcRoof'],
  [/\b(railings?|handrails?|guardrails?|balustrades?)\b/, 'IfcRailing'],
  [/\b(furniture|chairs?|tables?|desks?|sofas?|beds?)\b/, 'IfcFurniture'],
  [/\b(footings?|foundations?)\b/, 'IfcFooting'],
  [/\b(members?)\b/, 'IfcMember'],
  [/\b(plates?|panels?)\b/, 'IfcPlate'],
  [/\b(ceilings?|coverings?|claddings?)\b/, 'IfcCovering'],
  [/\b(shading devices?|louvers?|louvres?|brise soleil)\b/, 'IfcShadingDevice'],
  [/\b(generic elements?|proxies|proxy)\b/, 'IfcBuildingElementProxy'],
];

const STOPWORDS = new Set([
  'how', 'many', 'much', 'are', 'there', 'is', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'all', 'me', 'show', 'list', 'find',
  'highlight', 'which', 'what', 'give', 'total', 'sum', 'count', 'number', 'do', 'we', 'have', 'has', 'with', 'and', 'for', 'this',
  'that', 'model', 'building', 'any', 'tell', 'about', 'can', 'you', 'please', 'whats', "what's", 'where', 'get', 'area', 'volume', 'cost',
]);

function parseStorey(text: string, table: ModelTable): { value: string; rest: string } | null {
  // "on level 3", "in storey 2", "on the ground floor", or a storey name that appears verbatim
  const names = table.storeys.map((s) => s.name).sort((a, b) => b.length - a.length);
  for (const n of names) {
    const i = text.indexOf(n.toLowerCase());
    if (i >= 0) return { value: n, rest: text.slice(0, i) + ' ' + text.slice(i + n.length) };
  }
  const m = text.match(/\b(?:on|in|at|of)?\s*(?:the\s+)?(?:level|storey|story|floor)\s*(-?\d+|ground|first|second|third|fourth|fifth|roof|basement)\b/);
  if (m) {
    const words: Record<string, string> = { ground: '0', first: '1', second: '2', third: '3', fourth: '4', fifth: '5' };
    const key = words[m[1]] ?? m[1];
    const cand = table.storeys.find((s) => {
      const n = norm(s.name);
      if (key === 'roof' || key === 'basement') return n.includes(key);
      if (key === '0') return /(^|\s)(0|ground)(\s|$)/.test(n) || n.includes('ground');
      return new RegExp(`(^|\\s|l)${key}(\\s|$)`).test(n) || n.includes(`level ${key}`) || n.includes(`l${key}`);
    });
    if (cand) return { value: cand.name, rest: text.replace(m[0], ' ') };
    return { value: key, rest: text.replace(m[0], ' ') };
  }
  return null;
}

/** Understands the common question shapes. Returns null when it cannot, so the server can help. */
export function parseQuestion(question: string, table: ModelTable): Query | null {
  let text = ` ${question.toLowerCase().replace(/[?!.]/g, ' ')} `;
  const filters: Filter[] = [];

  if (/\bhow many (levels|storeys|stories|floors)\b/.test(text)) {
    return { filters: [], show: 'group', groupBy: 'storey' };
  }

  // numeric limits first: "taller than 3 m", "wider than 1.2", "thicker than 300 mm"
  const num = text.match(/\b(taller|higher|longer|wider|thicker|deeper|bigger|larger|shorter|lower|narrower|thinner|smaller)\s+than\s+(\d+(?:\.\d+)?)\s*(mm|cm|m|m2|m²|sqm)?/);
  if (num) {
    const dim: Record<string, Field> = { taller: 'height', higher: 'height', shorter: 'height', lower: 'height', longer: 'length', wider: 'length', narrower: 'length', thicker: 'thickness', thinner: 'thickness', deeper: 'thickness', bigger: 'area', larger: 'area', smaller: 'area' };
    const less = /shorter|lower|narrower|thinner|smaller/.test(num[1]);
    let v = Number(num[2]);
    if (num[3] === 'mm') v /= 1000;
    if (num[3] === 'cm') v /= 100;
    filters.push({ field: dim[num[1]], op: less ? '<' : '>', value: v });
    text = text.replace(num[0], ' ');
  }

  const storey = parseStorey(text, table);
  if (storey) {
    filters.push({ field: 'storey', op: 'contains', value: storey.value });
    text = storey.rest;
  }

  const noWindowRoom = text.match(/\b(?:with|having)\s+no\s+(windows?|doors?)\b/) ?? text.match(/\bwithout\s+(?:any\s+)?(windows?|doors?)\b/);
  let near: Filter | null = null;
  if (noWindowRoom) {
    near = { field: 'near', op: '=', value: 0, arg: /door/.test(noWindowRoom[1]) ? 'IfcDoor' : 'IfcWindow' };
    text = text.replace(noWindowRoom[0], ' ');
  }

  const material = text.match(/\b(?:made of|made from|in|of)\s+(concrete|steel|timber|wood|glass|brick|stone|marble|granite|aluminium|aluminum|gypsum|plaster)\b/) ?? text.match(/\b(concrete|steel|timber|wood|glass|brick|stone|marble|granite|aluminium|aluminum|gypsum|plaster)\s+(?=\w)/);
  if (material) {
    filters.push({ field: 'material', op: 'contains', value: material[1] });
    text = text.replace(material[0], ' ');
  }
  const noMaterial = /\b(?:with|having)\s+no\s+materials?\b|\bwithout\s+(?:a\s+)?materials?\b|\bunassigned\b/.test(text);
  if (noMaterial) {
    filters.push({ field: 'material', op: 'missing' });
    text = text.replace(/\b(?:with|having)\s+no\s+materials?\b|\bwithout\s+(?:a\s+)?materials?\b|\bunassigned\b/, ' ');
  }

  let cls: string | null = null;
  for (const [re, name] of CLASS_WORDS) {
    const hit = text.match(re);
    if (hit) {
      cls = name;
      text = text.replace(re, ' ');
      break;
    }
  }
  if (cls) filters.unshift({ field: 'class', op: 'is', value: cls });

  // whatever word is left that is not a filler is taken as part of the element name ("fire", "exit")
  const leftover = text.split(/\s+/).filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w) && w.length > 2);
  if (cls && leftover.length) filters.push({ field: 'name', op: 'contains', value: leftover.join(' ') });
  else if (!cls && leftover.length && !near && !noMaterial && !material && !num) {
    // a bare word such as "fire" or "kaaba": search names
    if (leftover.length > 3) return null;
    filters.push({ field: 'name', op: 'contains', value: leftover.join(' ') });
  }
  if (near) filters.push(near);

  if (!filters.length) return null;

  const asked = question.toLowerCase();
  const isSum = /\b(total|sum)\b/.test(asked) || /\bhow much\b/.test(asked);
  const wantsCost = /\b(cost|price|budget)\b/.test(asked);
  const wantsArea = /\barea\b/.test(asked);
  const wantsVol = /\bvolume\b|\bconcrete\b.*\bneeded\b/.test(asked);
  if (isSum || wantsCost || wantsArea || wantsVol) {
    const measure = wantsCost ? 'cost' : wantsVol ? 'volume' : 'area';
    if (/\b(which|by|per|each)\b.*\b(level|storey|floor)s?\b|\bper (level|storey|floor)\b/.test(asked)) {
      return { filters, show: 'group', groupBy: 'storey', measure };
    }
    return { filters, show: 'sum', measure };
  }
  if (/\b(which|what)\s+(levels?|storeys?|floors?)\b/.test(asked)) {
    const noX = /\b(no|without|none|missing|lack)\b/.test(asked);
    return { filters, show: 'group', groupBy: 'storey', ...(noX ? { having: { op: '=' as const, value: 0 } } : {}) };
  }
  if (/\bhow many\b|\bnumber of\b|\bcount\b/.test(asked)) {
    if (/\b(by|per|each)\s+(level|storey|floor)\b/.test(asked)) return { filters, show: 'group', groupBy: 'storey' };
    return { filters, show: 'count' };
  }
  return { filters, show: 'list' };
}
