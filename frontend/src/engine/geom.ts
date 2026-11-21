import type { Box6, SlicePlane, Vec3 } from './types.ts';

/** 4x4 matrix, column-major like three.js and web-ifc (translation in 12, 13, 14). */
export type M4 = number[];

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Inverse of a rotation plus translation (no scale), which is all an IFC placement is. */
export function invertRigid(m: M4): M4 {
  // transpose the 3x3 rotation
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[12], m[13], m[14]];
  const nt = [
    -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]),
    -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]),
    -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]),
  ];
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, nt[0], nt[1], nt[2], 1];
}

export function applyPoint(m: M4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Rotation only (no translation). */
export function applyDir(m: M4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** IfcAxis2Placement3D -> matrix. axis is local Z, ref is local X (both optional). */
export function placementMatrix(loc: Vec3, axis?: Vec3 | null, ref?: Vec3 | null): M4 {
  let z: Vec3 = axis && Math.hypot(...axis) > 1e-12 ? norm(axis) : [0, 0, 1];
  let x: Vec3 = ref && Math.hypot(...ref) > 1e-12 ? ref : Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  // make X perpendicular to Z
  const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = norm([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
  if (Math.hypot(...x) < 1e-12) {
    x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  }
  const y = norm(cross(z, x));
  z = norm(cross(x, y));
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, loc[0], loc[1], loc[2], 1];
}

export interface MeshData {
  /** x, y, z triples in IFC world coordinates, metres */
  pos: Float32Array;
  idx: Uint32Array;
}

export interface MeshStats {
  bbox: Box6;
  volume: number;
  surface: number;
}

export function emptyBox(): Box6 {
  return [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
}

export function unionBox(a: Box6, b: Box6): Box6 {
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ];
}

export function meshStats(mesh: MeshData): MeshStats {
  const p = mesh.pos;
  const bbox = emptyBox();
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < bbox[0]) bbox[0] = p[i];
    if (p[i + 1] < bbox[1]) bbox[1] = p[i + 1];
    if (p[i + 2] < bbox[2]) bbox[2] = p[i + 2];
    if (p[i] > bbox[3]) bbox[3] = p[i];
    if (p[i + 1] > bbox[4]) bbox[4] = p[i + 1];
    if (p[i + 2] > bbox[5]) bbox[5] = p[i + 2];
  }
  let vol = 0;
  let surface = 0;
  const ix = mesh.idx;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    // signed tetrahedron volume against the origin
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    surface += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return { bbox, volume: Math.abs(vol), surface };
}

/** Bounding box of the mesh expressed in a placement's local axes (placement = local to world). */
export function localBox(mesh: MeshData, placement: M4): Box6 {
  const inv = invertRigid(placement);
  const box = emptyBox();
  const p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) {
    const l = applyPoint(inv, p[i], p[i + 1], p[i + 2]);
    if (l[0] < box[0]) box[0] = l[0];
    if (l[1] < box[1]) box[1] = l[1];
    if (l[2] < box[2]) box[2] = l[2];
    if (l[0] > box[3]) box[3] = l[0];
    if (l[1] > box[4]) box[4] = l[1];
    if (l[2] > box[5]) box[5] = l[2];
  }
  return box;
}

/**
 * Cuts a mesh with a plane and returns the cut lines in the plane's own 2D coordinates.
 * The plane is nudged by a hair so a face lying exactly on it never produces double lines.
 */
export function sliceMesh(mesh: MeshData, plane: SlicePlane): [number, number, number, number][] {
  const eps = 1e-6;
  // axis index of the cutting coordinate and the two output axes
  let cutAxis: 0 | 1 | 2;
  let u: 0 | 1 | 2;
  let v: 0 | 1 | 2;
  let level: number;
  if (plane.kind === 'plan') {
    cutAxis = 2; u = 0; v = 1; level = plane.z;
  } else if (plane.kind === 'sectionX') {
    cutAxis = 0; u = 1; v = 2; level = plane.x;
  } else {
    cutAxis = 1; u = 0; v = 2; level = plane.y;
  }
  level += eps;
  const p = mesh.pos;
  const ix = mesh.idx;
  const out: [number, number, number, number][] = [];
  const pts: [number, number][] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const i0 = ix[t] * 3, i1 = ix[t + 1] * 3, i2 = ix[t + 2] * 3;
    const d0 = p[i0 + cutAxis] - level;
    const d1 = p[i1 + cutAxis] - level;
    const d2 = p[i2 + cutAxis] - level;
    if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;
    pts.length = 0;
    const edge = (ia: number, da: number, ib: number, db: number) => {
      if ((da > 0) === (db > 0)) return;
      const k = da / (da - db);
      pts.push([p[ia + u] + k * (p[ib + u] - p[ia + u]), p[ia + v] + k * (p[ib + v] - p[ia + v])]);
    };
    edge(i0, d0, i1, d1);
    edge(i1, d1, i2, d2);
    edge(i2, d2, i0, d0);
    if (pts.length === 2) out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
  }
  return out;
}

export function boxesOverlap(a: Box6, b: Box6, pad = 0): boolean {
  return (
    a[0] - pad <= b[3] && a[3] + pad >= b[0] &&
    a[1] - pad <= b[4] && a[4] + pad >= b[1] &&
    a[2] - pad <= b[5] && a[5] + pad >= b[2]
  );
}
