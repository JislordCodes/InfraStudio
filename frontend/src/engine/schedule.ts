/**
 * Quantity schedule and indicative cost, computed from the measured elements. Every number
 * comes from the model's own geometry, so editing an element changes the schedule at once.
 */
import type { ElementRecord, ModelTable } from './types.ts';

export type Unit = 'm3' | 'm2' | 'm' | 'each';

export interface Rate {
  /** how the class is measured and priced */
  unit: Unit;
  /** currency units per `unit` */
  rate: number;
}

export type RateCard = Record<string, Rate>;

/**
 * Indicative mid-range building rates in US dollars. They exist so the schedule shows a cost
 * that moves when the model moves. They are not a quotation. The panel lets the user edit them.
 */
export const DEFAULT_RATES: RateCard = {
  IfcWall: { unit: 'm2', rate: 85 },
  IfcCurtainWall: { unit: 'm2', rate: 780 },
  IfcSlab: { unit: 'm3', rate: 650 },
  IfcRoof: { unit: 'm2', rate: 130 },
  IfcColumn: { unit: 'm3', rate: 1100 },
  IfcBeam: { unit: 'm3', rate: 1000 },
  IfcFooting: { unit: 'm3', rate: 450 },
  IfcMember: { unit: 'm3', rate: 900 },
  IfcPlate: { unit: 'm2', rate: 95 },
  IfcCovering: { unit: 'm2', rate: 45 },
  IfcDoor: { unit: 'each', rate: 650 },
  IfcWindow: { unit: 'm2', rate: 420 },
  IfcStair: { unit: 'each', rate: 4500 },
  IfcRailing: { unit: 'm', rate: 210 },
  IfcFurniture: { unit: 'each', rate: 400 },
  IfcShadingDevice: { unit: 'each', rate: 300 },
  IfcBuildingElementProxy: { unit: 'each', rate: 150 },
};

export const CURRENCY = 'USD';

/** "IFCWALL" or "IfcWall" as a short readable name, for places that get the class from the viewer. */
export function niceClass(cls: string): string {
  if (/^IFC[A-Z0-9]+$/.test(cls)) {
    const t = cls.slice(3).toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return humanClass(cls, false);
}

export function humanClass(cls: string, plural = true): string {
  const base = cls.replace(/^Ifc/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const lower = base.toLowerCase();
  if (!plural) return lower;
  if (lower === 'building element proxy') return 'generic elements';
  if (lower === 'furniture') return 'furniture';
  if (lower.endsWith('s') || lower.endsWith('x')) return lower;
  return `${lower}s`;
}

/** Quantity of one element in the unit its class is priced in. */
export function quantityOf(rec: ElementRecord, unit: Unit): number {
  switch (unit) {
    case 'm3':
      return rec.volume;
    case 'm2':
      return rec.area;
    case 'm':
      return rec.size.length;
    case 'each':
      return 1;
  }
}

export interface ScheduleRow {
  cls: string;
  label: string;
  count: number;
  unit: Unit;
  quantity: number;
  volume: number;
  area: number;
  cost: number;
  ids: number[];
}

export interface StoreyRow {
  storey: string;
  count: number;
  cost: number;
}

export interface Schedule {
  rows: ScheduleRow[];
  storeys: StoreyRow[];
  totalCost: number;
  totalElements: number;
  /** Sum of slab plan area, a stand-in for gross floor area. */
  floorArea: number;
  totalVolume: number;
}

const FLOOR_SLAB_MAX_THICKNESS = 1.2;

export function buildSchedule(table: ModelTable, rates: RateCard = DEFAULT_RATES): Schedule {
  const byClass = new Map<string, ScheduleRow>();
  const byStorey = new Map<string, StoreyRow>();
  let totalCost = 0;
  let floorArea = 0;
  let totalVolume = 0;

  for (const rec of table.elements) {
    const rate = rates[rec.cls];
    const unit: Unit = rate?.unit ?? 'each';
    const qty = quantityOf(rec, unit);
    const cost = rate ? qty * rate.rate : 0;
    let row = byClass.get(rec.cls);
    if (!row) {
      row = { cls: rec.cls, label: humanClass(rec.cls), count: 0, unit, quantity: 0, volume: 0, area: 0, cost: 0, ids: [] };
      byClass.set(rec.cls, row);
    }
    row.count += 1;
    row.quantity += qty;
    row.volume += rec.volume;
    row.area += rec.area;
    row.cost += cost;
    row.ids.push(rec.id);
    totalCost += cost;
    totalVolume += rec.volume;

    const sName = rec.storey ?? 'No level';
    const s = byStorey.get(sName) ?? { storey: sName, count: 0, cost: 0 };
    s.count += 1;
    s.cost += cost;
    byStorey.set(sName, s);

    if (rec.cls === 'IfcSlab' && rec.size.height <= FLOOR_SLAB_MAX_THICKNESS) floorArea += rec.area;
  }

  const order = new Map(table.storeys.map((s, i) => [s.name, i]));
  return {
    rows: [...byClass.values()].sort((a, b) => b.cost - a.cost || b.count - a.count),
    storeys: [...byStorey.values()].sort((a, b) => (order.get(a.storey) ?? 99) - (order.get(b.storey) ?? 99)),
    totalCost,
    totalElements: table.elements.length,
    floorArea,
    totalVolume,
  };
}

export function formatQuantity(q: number, unit: Unit): string {
  const n = q >= 1000 ? q.toFixed(0) : q >= 100 ? q.toFixed(1) : q.toFixed(2);
  switch (unit) {
    case 'm3':
      return `${n} m³`;
    case 'm2':
      return `${n} m²`;
    case 'm':
      return `${n} m`;
    case 'each':
      return `${Math.round(q)}`;
  }
}

export function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
