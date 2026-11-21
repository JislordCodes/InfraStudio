/**
 * Finds structural elements that sit inside each other. A real overlap is deeper than a joint:
 * elements that only touch, or lap by a few centimetres at a corner, are not reported.
 */
import type { Box6, ElementRecord } from './types.ts';

export interface Overlap {
  a: number;
  b: number;
  /** shallowest of the three overlap depths, metres */
  depth: number;
}

const SOLID = new Set(['IfcWall', 'IfcColumn', 'IfcBeam', 'IfcSlab', 'IfcMember', 'IfcFooting', 'IfcRoof', 'IfcCurtainWall']);

/** Pairs that are meant to overlap or cannot be told apart by box alone. */
function ignoredPair(x: ElementRecord, y: ElementRecord): boolean {
  const pair = [x.cls, y.cls].sort().join('|');
  // walls sit in or on slabs and footings, and wall-to-wall corners lap
  return pair === 'IfcSlab|IfcWall' || pair === 'IfcFooting|IfcWall' || pair === 'IfcWall|IfcWall' || pair === 'IfcSlab|IfcSlab';
}

function depth(a: Box6, b: Box6): number {
  const dx = Math.min(a[3], b[3]) - Math.max(a[0], b[0]);
  const dy = Math.min(a[4], b[4]) - Math.max(a[1], b[1]);
  const dz = Math.min(a[5], b[5]) - Math.max(a[2], b[2]);
  return Math.min(dx, dy, dz);
}

export function findOverlaps(elements: ElementRecord[], minDepth = 0.15): Overlap[] {
  const solids = elements.filter((e) => SOLID.has(e.cls));
  // Uniform grid so large models do not compare every pair.
  const cell = 6;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  solids.forEach((e, i) => {
    const b = e.bbox;
    for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[3] / cell); x++) {
      for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[4] / cell); y++) {
        for (let z = Math.floor(b[2] / cell); z <= Math.floor(b[5] / cell); z++) {
          const k = key(x, y, z);
          const list = grid.get(k);
          if (list) list.push(i);
          else grid.set(k, [i]);
        }
      }
    }
  });
  const seen = new Set<number>();
  const out: Overlap[] = [];
  const n = solids.length;
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = Math.min(list[p], list[q]);
        const j = Math.max(list[p], list[q]);
        const code = i * n + j;
        if (seen.has(code)) continue;
        seen.add(code);
        const a = solids[i];
        const b = solids[j];
        if (ignoredPair(a, b)) continue;
        const d = depth(a.bbox, b.bbox);
        if (d > minDepth) out.push({ a: a.id, b: b.id, depth: d });
      }
    }
  }
  return out;
}
