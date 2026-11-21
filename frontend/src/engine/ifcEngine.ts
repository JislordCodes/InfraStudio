/**
 * In-browser IFC engine: reads a model with web-ifc, measures every element from its real
 * geometry, applies hand edits (move, resize, delete, rename) to the IFC file itself, and
 * cuts plans and sections for drawings.
 *
 * It runs inside a Web Worker in the app (see worker.ts) and directly under Node in tests.
 * It never touches the DOM. The caller creates and initialises the web-ifc API object.
 *
 * Editing model: each edit rewrites IFC lines, saves the file, reopens it, and re-measures
 * only the elements that changed. web-ifc keeps stale geometry for an open model, so the
 * save-and-reopen step is what guarantees the numbers match the file.
 */
import * as WebIFC from 'web-ifc';
import {
  IDENTITY,
  applyDir,
  boxesOverlap,
  invertRigid,
  localBox,
  meshStats,
  mul,
  placementMatrix,
  sliceMesh,
  unionBox,
  type M4,
  type MeshData,
} from './geom.ts';
import type {
  Box6,
  CutSegment,
  EditAxis,
  EditInfo,
  EditOp,
  EditResult,
  ElementRecord,
  ModelTable,
  SlicePlane,
  SliceResult,
  StoreyRecord,
  Vec3,
} from './types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Api = any;

/** Relationship lines that can point at an element, with the attributes that hold the reference. */
const RELATION_TYPES = [
  WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE,
  WebIFC.IFCRELDEFINESBYPROPERTIES,
  WebIFC.IFCRELDEFINESBYTYPE,
  WebIFC.IFCRELASSOCIATESMATERIAL,
  WebIFC.IFCRELASSOCIATESCLASSIFICATION,
  WebIFC.IFCRELAGGREGATES,
  WebIFC.IFCRELNESTS,
  WebIFC.IFCRELVOIDSELEMENT,
  WebIFC.IFCRELFILLSELEMENT,
  WebIFC.IFCRELSPACEBOUNDARY,
  WebIFC.IFCRELASSIGNSTOGROUP,
  WebIFC.IFCRELCONNECTSELEMENTS,
];

/** Natural names for the three sizes of an element: larger plan side, smaller plan side, vertical side. */
function axisLabels(cls: string): [string, string, string] {
  if (/^Ifc(Slab|Roof|Covering|Plate|Footing)$/.test(cls)) return ['Length', 'Width', 'Thickness'];
  if (/^Ifc(Door|Window)$/.test(cls)) return ['Width', 'Thickness', 'Height'];
  if (/^Ifc(Column|Member|Pile)$/.test(cls)) return ['Width', 'Depth', 'Height'];
  if (/^Ifc(Beam)$/.test(cls)) return ['Length', 'Width', 'Depth'];
  return ['Length', 'Thickness', 'Height'];
}

/** "IFCWALL" -> "IfcWall". Built from the schema's own class names, which survive minification. */
const PASCAL = new Map<string, string>(Object.keys(WebIFC.IFC4).filter((k) => /^Ifc/.test(k)).map((k) => [k.toUpperCase(), k]));

const val = (x: any): any => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const isHandle = (x: any): boolean => !!x && typeof x === 'object' && x.type === 5 && typeof x.value === 'number';

export class IfcEngine {
  private api: Api;
  private mid = -1;
  private nextId = 0;
  private unit = 1;
  private project = '';

  private placementCache = new Map<number, M4>();
  private meshes = new Map<number, MeshData>();
  private records = new Map<number, ElementRecord>();
  private storeys: StoreyRecord[] = [];
  private storeyOf = new Map<number, number>();

  constructor(api: Api) {
    this.api = api;
  }

  /* ───────────────────────── small helpers ───────────────────────── */

  /** The IFC class name of a line, such as "IfcWall". Reads the type code, never the JavaScript class name. */
  private tn(line: any): string {
    if (!line || typeof line.type !== 'number') return '';
    const raw = String(this.api.GetNameFromTypeCode(line.type) ?? '');
    return PASCAL.get(raw.toUpperCase()) ?? raw;
  }

  private L(id: number): any {
    return this.api.GetLine(this.mid, id, false);
  }

  private allIds(type: number): number[] {
    const v = this.api.GetLineIDsWithType(this.mid, type);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  }

  private newId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private write(line: any): void {
    this.api.WriteLine(this.mid, line);
  }

  private handle(id: number): any {
    return new WebIFC.Handle(id);
  }

  private len(v: number): any {
    return new WebIFC.IFC4.IfcLengthMeasure(v);
  }

  private coords(pointId: number): number[] {
    return (this.L(pointId).Coordinates as any[]).map((c) => c.value as number);
  }

  /** Writes a copy of a line under a fresh id (after applying `mutate`) and returns the new id. */
  private cloneLine(id: number, mutate: (line: any) => void): number {
    const line = this.L(id);
    const nid = this.newId();
    line.expressID = nid;
    mutate(line);
    this.write(line);
    return nid;
  }

  /** Axis placement (3D) as a metre-based matrix, rotation and translation. */
  private axisMatrix(id: number): M4 {
    const a = this.L(id);
    if (!a || !a.Location) return IDENTITY;
    const loc = this.coords(a.Location.value);
    const locM: Vec3 = [(loc[0] ?? 0) * this.unit, (loc[1] ?? 0) * this.unit, (loc[2] ?? 0) * this.unit];
    const dir = (h: any): Vec3 | null =>
      h && h.value != null ? ((this.L(h.value).DirectionRatios as any[]).map((r) => r.value) as Vec3) : null;
    // IfcAxis2Placement2D has RefDirection only
    return placementMatrix(locM, a.Axis ? dir(a.Axis) : null, dir(a.RefDirection));
  }

  private placementWorld(placementId: number | null | undefined): M4 {
    if (placementId == null) return IDENTITY;
    const hit = this.placementCache.get(placementId);
    if (hit) return hit;
    const lp = this.L(placementId);
    let m: M4 = IDENTITY;
    if (lp) {
      const rel = lp.RelativePlacement ? this.axisMatrix(lp.RelativePlacement.value) : IDENTITY;
      const parent = lp.PlacementRelTo ? this.placementWorld(lp.PlacementRelTo.value) : IDENTITY;
      m = mul(parent, rel);
    }
    this.placementCache.set(placementId, m);
    return m;
  }

  private elementPlacement(line: any): M4 {
    return this.placementWorld(line?.ObjectPlacement ? line.ObjectPlacement.value : null);
  }

  /* ───────────────────────── reading a model ───────────────────────── */

  /** Opens an IFC file and measures every element. Replaces any model open before. */
  open(bytes: Uint8Array): ModelTable {
    this.closeModel();
    this.mid = this.api.OpenModel(bytes);
    this.nextId = this.api.GetMaxExpressID(this.mid);
    this.unit = this.readUnitScale();
    this.placementCache.clear();
    this.meshes.clear();
    this.records.clear();
    this.storeyOf.clear();

    const projectIds = this.allIds(WebIFC.IFCPROJECT);
    this.project = projectIds.length ? String(val(this.L(projectIds[0]).Name) ?? '') : '';

    this.readStoreys();
    const containment = this.readContainment();

    const ids: number[] = [];
    this.api.StreamAllMeshes(this.mid, (flat: any) => {
      const mesh = this.readFlatMesh(flat);
      if (mesh) {
        this.meshes.set(flat.expressID, mesh);
        ids.push(flat.expressID);
      }
    });

    const materials = this.readMaterials();
    const props = this.readProperties();
    for (const id of ids) this.buildRecord(id, containment, materials, props);
    this.assignStoreysByHeight();
    return this.table();
  }

  private closeModel(): void {
    if (this.mid >= 0) {
      try {
        this.api.CloseModel(this.mid);
      } catch {
        /* already closed */
      }
    }
    this.mid = -1;
  }

  private readUnitScale(): number {
    try {
      const units = this.allIds(WebIFC.IFCSIUNIT);
      for (const id of units) {
        const u = this.L(id);
        if (String(val(u.UnitType)) !== 'LENGTHUNIT') continue;
        const prefix = String(val(u.Prefix) ?? '');
        const table: Record<string, number> = { MILLI: 0.001, CENTI: 0.01, DECI: 0.1, KILO: 1000 };
        return table[prefix] ?? 1;
      }
      // Imperial or other conversion based units are rare in this app's models.
      const conv = this.allIds(WebIFC.IFCCONVERSIONBASEDUNIT);
      for (const id of conv) {
        const u = this.L(id);
        if (String(val(u.UnitType)) === 'LENGTHUNIT') {
          const name = String(val(u.Name) ?? '').toUpperCase();
          if (name.includes('FOOT')) return 0.3048;
          if (name.includes('INCH')) return 0.0254;
        }
      }
    } catch {
      /* fall through to metres */
    }
    return 1;
  }

  private readStoreys(): void {
    this.storeys = [];
    for (const id of this.allIds(WebIFC.IFCBUILDINGSTOREY)) {
      const s = this.L(id);
      const elev = Number(val(s.Elevation));
      this.storeys.push({
        id,
        name: String(val(s.Name) ?? `Level ${this.storeys.length}`),
        elevation: Number.isFinite(elev) ? elev * this.unit : NaN,
      });
    }
  }

  private readContainment(): Map<number, number> {
    const map = new Map<number, number>();
    const storeyIds = new Set(this.storeys.map((s) => s.id));
    for (const rid of this.allIds(WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
      const rel = this.L(rid);
      const owner = rel.RelatingStructure?.value;
      if (!storeyIds.has(owner)) continue;
      for (const h of rel.RelatedElements || []) map.set(h.value, owner);
    }
    // Parts of an assembly (stair flights, curtain wall panels) sit in their parent's storey.
    for (const rid of this.allIds(WebIFC.IFCRELAGGREGATES)) {
      const rel = this.L(rid);
      const owner = map.get(rel.RelatingObject?.value);
      if (owner == null) continue;
      for (const h of rel.RelatedObjects || []) if (!map.has(h.value)) map.set(h.value, owner);
    }
    return map;
  }

  private readFlatMesh(flat: any): MeshData | null {
    const pos: number[] = [];
    const idx: number[] = [];
    let base = 0;
    const geoms = flat.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const placed = geoms.get(g);
      const geom = this.api.GetGeometry(this.mid, placed.geometryExpressID);
      const verts: Float32Array = this.api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const ind: Uint32Array = this.api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const t: number[] = placed.flatTransformation;
      const n = verts.length / 6;
      for (let k = 0; k < n; k++) {
        const x = verts[k * 6], y = verts[k * 6 + 1], z = verts[k * 6 + 2];
        // web-ifc hands geometry back in a Y-up frame: (x, y, z)_ifc -> (x, z, -y).
        const ox = t[0] * x + t[4] * y + t[8] * z + t[12];
        const oy = t[1] * x + t[5] * y + t[9] * z + t[13];
        const oz = t[2] * x + t[6] * y + t[10] * z + t[14];
        pos.push(ox, -oz, oy);
      }
      for (let k = 0; k < ind.length; k++) idx.push(ind[k] + base);
      base += n;
      geom.delete();
    }
    if (!pos.length) return null;
    return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
  }

  private readMaterials(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    const nameOf = (id: number, depth = 0): string[] => {
      if (depth > 4) return [];
      const line = this.L(id);
      if (!line) return [];
      const cls = this.tn(line);
      if (cls === 'IfcMaterial') return [String(val(line.Name) ?? '')].filter(Boolean);
      const found: string[] = [];
      const follow = (h: any) => {
        if (isHandle(h)) found.push(...nameOf(h.value, depth + 1));
      };
      if (cls === 'IfcMaterialLayerSetUsage') follow(line.ForLayerSet);
      else if (cls === 'IfcMaterialLayerSet') for (const h of line.MaterialLayers || []) follow(h);
      else if (cls === 'IfcMaterialLayer') follow(line.Material);
      else if (cls === 'IfcMaterialConstituentSet') for (const h of line.MaterialConstituents || []) follow(h);
      else if (cls === 'IfcMaterialConstituent') follow(line.Material);
      else if (cls === 'IfcMaterialProfileSetUsage') follow(line.ForProfileSet);
      else if (cls === 'IfcMaterialProfileSet') for (const h of line.MaterialProfiles || []) follow(h);
      else if (cls === 'IfcMaterialProfile') follow(line.Material);
      else if (cls === 'IfcMaterialList') for (const h of line.Materials || []) follow(h);
      return [...new Set(found)];
    };
    for (const rid of this.allIds(WebIFC.IFCRELASSOCIATESMATERIAL)) {
      const rel = this.L(rid);
      if (!rel.RelatingMaterial) continue;
      const names = nameOf(rel.RelatingMaterial.value);
      if (!names.length) continue;
      for (const h of rel.RelatedObjects || []) out.set(h.value, names);
    }
    return out;
  }

  private readProperties(): Map<number, Record<string, string>> {
    const out = new Map<number, Record<string, string>>();
    const psetCache = new Map<number, Record<string, string>>();
    const readPset = (id: number): Record<string, string> => {
      const hit = psetCache.get(id);
      if (hit) return hit;
      const res: Record<string, string> = {};
      const ps = this.L(id);
      if (ps && this.tn(ps) === 'IfcPropertySet') {
        const pname = String(val(ps.Name) ?? 'Pset');
        for (const h of ps.HasProperties || []) {
          const p = this.L(h.value);
          if (!p || this.tn(p) !== 'IfcPropertySingleValue') continue;
          const v = val(p.NominalValue);
          if (v == null) continue;
          res[`${pname}.${String(val(p.Name))}`] = String(v);
        }
      }
      psetCache.set(id, res);
      return res;
    };
    for (const rid of this.allIds(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
      const rel = this.L(rid);
      const def = rel.RelatingPropertyDefinition;
      if (!isHandle(def)) continue;
      const set = readPset(def.value);
      if (!Object.keys(set).length) continue;
      const targets = rel.RelatedObjects || (rel.RelatedObject ? [rel.RelatedObject] : []);
      for (const h of targets) out.set(h.value, { ...(out.get(h.value) || {}), ...set });
    }
    return out;
  }

  private buildRecord(
    id: number,
    containment: Map<number, number>,
    materials: Map<number, string[]>,
    props: Map<number, Record<string, string>>,
  ): void {
    const line = this.L(id);
    const mesh = this.meshes.get(id);
    if (!line || !mesh) return;
    const rec = this.measure(id, line, mesh);
    const storeyId = containment.get(id);
    if (storeyId != null) {
      this.storeyOf.set(id, storeyId);
      rec.storey = this.storeys.find((s) => s.id === storeyId)?.name ?? null;
    }
    rec.materials = materials.get(id) ?? [];
    rec.props = props.get(id) ?? {};
    this.records.set(id, rec);
  }

  /** Geometry-derived fields of one element. */
  private measure(id: number, line: any, mesh: MeshData, prev?: ElementRecord): ElementRecord {
    const stats = meshStats(mesh);
    const placement = this.elementPlacement(line);
    const lb = localBox(mesh, placement);
    const local: Vec3 = [lb[3] - lb[0], lb[4] - lb[1], lb[5] - lb[2]];
    // which local axis is most vertical
    let v = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(placement[j * 4 + 2]) > Math.abs(placement[v * 4 + 2])) v = j;
    const others = [0, 1, 2].filter((j) => j !== v).map((j) => local[j]).sort((a, b) => b - a);
    const size = { length: others[0], thickness: others[1], height: local[v] };
    const thin = Math.max(Math.min(local[0], local[1], local[2]), 1e-4);
    return {
      id,
      guid: String(val(line.GlobalId) ?? ''),
      cls: this.tn(line) || 'IfcProduct',
      name: String(val(line.Name) ?? ''),
      storey: prev?.storey ?? null,
      materials: prev?.materials ?? [],
      props: prev?.props ?? {},
      bbox: stats.bbox,
      local,
      size,
      volume: stats.volume,
      area: stats.volume / thin,
      surface: stats.surface,
    };
  }

  /** Elements with no containment link take the highest storey at or below their base. */
  private assignStoreysByHeight(): void {
    const sorted = [...this.storeys]
      .map((s) => ({ ...s }))
      .sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
    // storeys with no Elevation attribute get the lowest base of the elements they contain
    for (const s of sorted) {
      if (Number.isFinite(s.elevation)) continue;
      let low = Infinity;
      for (const [eid, sid] of this.storeyOf) if (sid === s.id) low = Math.min(low, this.records.get(eid)?.bbox[2] ?? Infinity);
      s.elevation = Number.isFinite(low) ? low : 0;
      const orig = this.storeys.find((x) => x.id === s.id);
      if (orig) orig.elevation = s.elevation;
    }
    if (!sorted.length) return;
    for (const rec of this.records.values()) {
      if (rec.storey) continue;
      let pick: StoreyRecord | null = null;
      for (const s of sorted) if (s.elevation <= rec.bbox[2] + 0.3) pick = s;
      rec.storey = (pick ?? sorted[0]).name;
    }
  }

  table(): ModelTable {
    let bbox: Box6 | null = null;
    for (const r of this.records.values()) bbox = bbox ? unionBox(bbox, r.bbox) : [...r.bbox];
    return {
      project: this.project,
      unitScale: this.unit,
      storeys: [...this.storeys].sort((a, b) => (a.elevation || 0) - (b.elevation || 0)),
      elements: [...this.records.values()],
      bbox,
    };
  }

  /** The current file, including any edits. */
  save(): Uint8Array {
    if (this.mid < 0) throw new Error('No model is open');
    return this.api.SaveModel(this.mid);
  }

  /* ───────────────────────── what can be edited ───────────────────────── */

  private bodyItemIds(line: any): number[] {
    const out: number[] = [];
    if (!line?.Representation) return out;
    const pds = this.L(line.Representation.value);
    for (const rh of pds?.Representations || []) {
      const rep = this.L(rh.value);
      // Only the 3D body counts. Axis, footprint and box representations are not drawn.
      const rid = String(val(rep?.RepresentationIdentifier) ?? '');
      if (rid && rid.toLowerCase() !== 'body') continue;
      for (const ih of rep?.Items || []) out.push(ih.value);
    }
    return out;
  }

  /** Maps each axis of an extruded solid onto the element's axes, or null if it is not square to them. */
  private solidAxisMap(solid: any): { map: [number, number, number]; loc: Vec3 } | null {
    let R: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    let loc: Vec3 = [0, 0, 0];
    if (solid.Position) {
      const m = this.axisMatrix(solid.Position.value);
      R = [0, 1, 2].map((r) => [m[r], m[4 + r], m[8 + r]]); // R[row=element axis][col=solid axis]
      loc = [m[12] / this.unit, m[13] / this.unit, m[14] / this.unit];
    }
    const map: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      let best = 0;
      for (let j = 1; j < 3; j++) if (Math.abs(R[j][k]) > Math.abs(R[best][k])) best = j;
      if (Math.abs(R[best][k]) < 0.999) return null;
      map[k] = best;
    }
    if (new Set(map).size !== 3) return null;
    return { map, loc };
  }

  private checkResizable(line: any): string | null {
    const items = this.bodyItemIds(line);
    if (!items.length) return 'This element has no body geometry to resize.';
    for (const id of items) {
      const item = this.L(id);
      if (this.tn(item) !== 'IfcExtrudedAreaSolid') {
        return 'This element is not a simple extruded shape, so it can be moved but not resized.';
      }
      if (!this.solidAxisMap(item)) return 'This element is rotated inside its own frame, so it can be moved but not resized.';
      const d = (item.ExtrudedDirection ? (this.L(item.ExtrudedDirection.value).DirectionRatios as any[]).map((r) => r.value) : [0, 0, 1]) as number[];
      if (Math.abs(Math.abs(d[2] ?? 0) - 1) > 1e-3) return 'This element is extruded at a slant, so it can be moved but not resized.';
      const prof = this.L(item.SweptArea.value);
      const pc = this.tn(prof);
      if (!['IfcRectangleProfileDef', 'IfcCircleProfileDef', 'IfcArbitraryClosedProfileDef', 'IfcArbitraryProfileDefWithVoids'].includes(pc)) {
        return 'This element has a profile shape that cannot be resized by hand yet.';
      }
      if (prof.Position) {
        const pm = this.L(prof.Position.value);
        const rd = pm?.RefDirection ? ((this.L(pm.RefDirection.value).DirectionRatios as any[]).map((r) => r.value) as number[]) : [1, 0];
        if (Math.abs(rd[1] ?? 0) > 1e-3 && Math.abs(rd[0] ?? 0) > 1e-3) return 'This element has an angled profile, so it can be moved but not resized.';
      }
      if (pc.startsWith('IfcArbitrary')) {
        const curves: number[] = [prof.OuterCurve.value, ...((prof.InnerCurves || []) as any[]).map((h) => h.value as number)];
        for (const cid of curves) {
          const cv = this.L(cid);
          const cn = this.tn(cv);
          if (cn !== 'IfcPolyline' && cn !== 'IfcIndexedPolyCurve') return 'This element has a curved outline, so it can be moved but not resized.';
          if (cn === 'IfcIndexedPolyCurve') {
            for (const seg of (cv.Segments || []) as any[]) {
              if (seg instanceof WebIFC.IFC4.IfcArcIndex) return 'This element has a curved outline, so it can be moved but not resized.';
            }
          }
        }
      }
    }
    return null;
  }

  getEditInfo(id: number): EditInfo | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    const line = this.L(id);
    const placement = this.elementPlacement(line);
    let v = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(placement[j * 4 + 2]) > Math.abs(placement[v * 4 + 2])) v = j;
    const horizontal = [0, 1, 2].filter((j) => j !== v).sort((a, b) => rec.local[b] - rec.local[a]);
    const [l1, l2, l3] = axisLabels(rec.cls);
    const axes: EditAxis[] = [
      { index: horizontal[0] as 0 | 1 | 2, label: l1, size: rec.local[horizontal[0]] },
      { index: horizontal[1] as 0 | 1 | 2, label: l2, size: rec.local[horizontal[1]] },
      { index: v as 0 | 1 | 2, label: l3, size: rec.local[v] },
    ];
    const reason = this.checkResizable(line);
    return { id, movable: !!line?.ObjectPlacement, resizable: reason == null, reason: reason ?? undefined, axes };
  }

  /* ───────────────────────── editing ───────────────────────── */

  apply(op: EditOp): EditResult {
    if (this.mid < 0) return this.fail('No model is open');
    try {
      const changed = new Set<number>();
      const removed = new Set<number>();
      switch (op.kind) {
        case 'move':
          for (const id of op.ids) {
            this.moveElement(id, op.delta);
            changed.add(id);
          }
          break;
        case 'resize':
          this.resizeElement(op.id, op.sizes, op.anchor);
          changed.add(op.id);
          break;
        case 'resizeBy': {
          const info = this.getEditInfo(op.id);
          if (!info) throw new Error('That element is not in the model.');
          const axis = info.axes[op.dim === 'length' ? 0 : op.dim === 'thickness' ? 1 : 2];
          this.resizeElement(op.id, { [axis.index]: op.size }, op.anchor);
          changed.add(op.id);
          break;
        }
        case 'delete': {
          const gone = this.deleteElements(op.ids);
          for (const id of gone) removed.add(id);
          break;
        }
        case 'rename': {
          const line = this.L(op.id);
          if (!line) throw new Error('That element is not in the model.');
          line.Name = new WebIFC.IFC4.IfcLabel(op.name);
          this.write(line);
          const rec = this.records.get(op.id);
          if (rec) rec.name = op.name;
          break;
        }
      }
      this.commit(changed, removed);
      return { ok: true, changed: [...changed], removed: [...removed], table: this.table() };
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(error: string): EditResult {
    return { ok: false, error, changed: [], removed: [], table: this.table() };
  }

  /** Save, reopen, and re-measure what changed. */
  private commit(changed: Set<number>, removed: Set<number>): void {
    const out = this.save();
    this.closeModel();
    this.mid = this.api.OpenModel(out);
    this.nextId = this.api.GetMaxExpressID(this.mid);
    this.placementCache.clear();
    for (const id of removed) {
      this.records.delete(id);
      this.meshes.delete(id);
      this.storeyOf.delete(id);
    }
    const ids = [...changed].filter((id) => !removed.has(id));
    if (!ids.length) return;
    this.api.StreamMeshes(this.mid, ids, (flat: any) => {
      const mesh = this.readFlatMesh(flat);
      const prev = this.records.get(flat.expressID);
      if (mesh && prev) {
        this.meshes.set(flat.expressID, mesh);
        const line = this.L(flat.expressID);
        this.records.set(flat.expressID, this.measure(flat.expressID, line, mesh, prev));
      }
    });
  }

  /** The element's own placement line, replaced with a copy that has a new Location. */
  private relocate(id: number, shiftLocal: Vec3 | null, deltaParent: Vec3 | null): void {
    const line = this.L(id);
    if (!line?.ObjectPlacement) throw new Error('That element has no position to change.');
    const lp = this.L(line.ObjectPlacement.value);
    const axisId = lp.RelativePlacement.value as number;
    const axis = this.L(axisId);
    if (!axis?.Location) throw new Error('That element cannot be moved.');
    const rel = this.axisMatrix(axisId);
    const here = this.coords(axis.Location.value);
    // shift expressed in the element's own axes goes through its relative rotation
    const fromLocal = shiftLocal ? applyDir(rel, shiftLocal[0], shiftLocal[1], shiftLocal[2]) : [0, 0, 0];
    const d = deltaParent ?? [0, 0, 0];
    const moved = [0, 1, 2].map((k) => (here[k] ?? 0) + (fromLocal[k] + d[k]) / this.unit);
    const pointId = this.cloneLine(axis.Location.value, (p) => {
      p.Coordinates = moved.map((c) => this.len(c));
    });
    const newAxis = this.cloneLine(axisId, (a) => {
      a.Location = this.handle(pointId);
    });
    lp.RelativePlacement = this.handle(newAxis);
    this.write(lp);
    this.placementCache.clear();
  }

  private moveElement(id: number, delta: Vec3): void {
    const line = this.L(id);
    if (!line?.ObjectPlacement) throw new Error('That element has no position to change.');
    const lp = this.L(line.ObjectPlacement.value);
    const parent = lp.PlacementRelTo ? this.placementWorld(lp.PlacementRelTo.value) : IDENTITY;
    // world delta into the parent's frame: rotate by the parent's inverse rotation
    const inv = invertRigid(parent);
    const dp = applyDir(inv, delta[0], delta[1], delta[2]);
    this.relocate(id, null, dp);
  }

  private resizeElement(id: number, sizes: Partial<Record<0 | 1 | 2, number>>, anchor: 'base' | 'centre'): void {
    const rec = this.records.get(id);
    const line = this.L(id);
    if (!rec || !line) throw new Error('That element is not in the model.');
    const reason = this.checkResizable(line);
    if (reason) throw new Error(reason);

    const S: Vec3 = [1, 1, 1];
    for (const j of [0, 1, 2] as const) {
      const target = sizes[j];
      if (target == null) continue;
      const cur = rec.local[j];
      if (cur < 1e-6) throw new Error('This element is too thin to resize.');
      if (target < 0.01) throw new Error('The new size must be at least 1 cm.');
      S[j] = target / cur;
    }
    if (S.every((s) => Math.abs(s - 1) < 1e-9)) return;

    // Anchor: where in the element's own frame stays still while it grows or shrinks.
    const placement = this.elementPlacement(line);
    const mesh = this.meshes.get(id)!;
    const lb = localBox(mesh, placement);
    let vert = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(placement[j * 4 + 2]) > Math.abs(placement[vert * 4 + 2])) vert = j;
    const anchorPt: Vec3 = [(lb[0] + lb[3]) / 2, (lb[1] + lb[4]) / 2, (lb[2] + lb[5]) / 2];
    if (anchor === 'base') {
      // the end of the vertical axis that points down
      anchorPt[vert] = placement[vert * 4 + 2] >= 0 ? lb[vert] : lb[vert + 3];
    }

    // Rewrite every body solid so its shape follows the new size.
    const newItems = new Map<number, number>();
    for (const itemId of this.bodyItemIds(line)) newItems.set(itemId, this.scaleSolid(itemId, S));
    // point the shape representations at the rewritten solids
    const pds = this.L(line.Representation.value);
    for (const rh of pds.Representations || []) {
      const rep = this.L(rh.value);
      let touched = false;
      const items = (rep.Items || []).map((h: any) => {
        const to = newItems.get(h.value);
        if (to != null) {
          touched = true;
          return this.handle(to);
        }
        return h;
      });
      if (touched) {
        const nid = this.cloneLine(rh.value, (r) => {
          r.Items = items;
        });
        rh.value = nid;
      }
    }
    const newPds = this.cloneLine(line.Representation.value, (p) => {
      p.Representations = pds.Representations;
    });
    line.Representation = this.handle(newPds);
    this.write(line);

    // Scaling grew the shape about the element origin, so slide the element to hold the anchor still.
    const shift: Vec3 = [(1 - S[0]) * anchorPt[0], (1 - S[1]) * anchorPt[1], (1 - S[2]) * anchorPt[2]];
    if (shift.some((s) => Math.abs(s) > 1e-9)) this.relocate(id, shift, null);
  }

  /** Writes a scaled copy of one extruded solid and returns its new id. */
  private scaleSolid(solidId: number, S: Vec3): number {
    const solid = this.L(solidId);
    const axisInfo = this.solidAxisMap(solid)!;
    const sx = S[axisInfo.map[0]];
    const sy = S[axisInfo.map[1]];
    const sz = S[axisInfo.map[2]];

    const profile = this.scaleProfile(solid.SweptArea.value, sx, sy);
    let posId: number | null = null;
    if (solid.Position) {
      const posLine = this.L(solid.Position.value);
      const loc = this.coords(posLine.Location.value);
      const pt = this.cloneLine(posLine.Location.value, (p) => {
        p.Coordinates = [this.len(loc[0] * S[0]), this.len(loc[1] * S[1]), this.len(loc[2] * S[2])];
      });
      posId = this.cloneLine(solid.Position.value, (a) => {
        a.Location = this.handle(pt);
      });
    }
    const depth = Number(val(solid.Depth));
    return this.cloneLine(solidId, (s) => {
      s.SweptArea = this.handle(profile);
      s.Depth = new WebIFC.IFC4.IfcPositiveLengthMeasure(depth * sz);
      if (posId != null) s.Position = this.handle(posId);
    });
  }

  private scaleProfile(profileId: number, sx: number, sy: number): number {
    const prof = this.L(profileId);
    const cls = this.tn(prof);
    // A profile placed with a quarter-turn swaps which scale applies to which side.
    let swap = false;
    if (prof.Position) {
      const pm = this.L(prof.Position.value);
      const rd = pm?.RefDirection ? ((this.L(pm.RefDirection.value).DirectionRatios as any[]).map((r) => r.value) as number[]) : [1, 0];
      swap = Math.abs(rd[1] ?? 0) > Math.abs(rd[0] ?? 0);
    }
    const px = swap ? sy : sx;
    const py = swap ? sx : sy;
    const moveProfileOrigin = (): number | null => {
      if (!prof.Position) return null;
      const pm = this.L(prof.Position.value);
      if (!pm.Location) return null;
      const c = this.coords(pm.Location.value);
      const pt = this.cloneLine(pm.Location.value, (p) => {
        p.Coordinates = [this.len((c[0] ?? 0) * sx), this.len((c[1] ?? 0) * sy)];
      });
      return this.cloneLine(prof.Position.value, (a) => {
        a.Location = this.handle(pt);
      });
    };
    if (cls === 'IfcRectangleProfileDef') {
      const pos = moveProfileOrigin();
      return this.cloneLine(profileId, (p) => {
        p.XDim = new WebIFC.IFC4.IfcPositiveLengthMeasure(Number(val(prof.XDim)) * px);
        p.YDim = new WebIFC.IFC4.IfcPositiveLengthMeasure(Number(val(prof.YDim)) * py);
        if (pos != null) p.Position = this.handle(pos);
      });
    }
    if (cls === 'IfcCircleProfileDef') {
      const pos = moveProfileOrigin();
      // A circle stays a circle: take the larger change.
      const k = Math.abs(px - 1) >= Math.abs(py - 1) ? px : py;
      return this.cloneLine(profileId, (p) => {
        p.Radius = new WebIFC.IFC4.IfcPositiveLengthMeasure(Number(val(prof.Radius)) * k);
        if (pos != null) p.Position = this.handle(pos);
      });
    }
    // Arbitrary outlines: scale every outline point about the profile origin.
    const outer = this.scaleCurve(prof.OuterCurve.value, sx, sy);
    const inner = (prof.InnerCurves || []).map((h: any) => this.handle(this.scaleCurve(h.value, sx, sy)));
    return this.cloneLine(profileId, (p) => {
      p.OuterCurve = this.handle(outer);
      if (cls === 'IfcArbitraryProfileDefWithVoids') p.InnerCurves = inner;
    });
  }

  private scaleCurve(curveId: number, sx: number, sy: number): number {
    const curve = this.L(curveId);
    const cls = this.tn(curve);
    if (cls === 'IfcPolyline') {
      const pts = (curve.Points as any[]).map((h) => {
        const c = this.coords(h.value);
        return this.handle(
          this.cloneLine(h.value, (p) => {
            p.Coordinates = [this.len((c[0] ?? 0) * sx), this.len((c[1] ?? 0) * sy), ...(c.length > 2 ? [this.len(c[2])] : [])];
          }),
        );
      });
      return this.cloneLine(curveId, (cv) => {
        cv.Points = pts;
      });
    }
    if (cls === 'IfcIndexedPolyCurve') {
      // web-ifc cannot write the Segments of an indexed curve, so the outline is rewritten as
      // a plain polyline, which every IFC reader understands.
      const list = this.L(curve.Points.value);
      const rows = (list.CoordList as any[]).map((row) => (row as any[]).map((c) => c.value as number));
      let order: number[] = rows.map((_, i) => i);
      const segs = curve.Segments as any[] | null;
      if (segs && segs.length) {
        order = [];
        for (const seg of segs) {
          const ix = (seg.value as any[]).map((n) => (typeof n === 'number' ? n : n.value) as number);
          if (seg instanceof WebIFC.IFC4.IfcArcIndex) throw new Error('This element has a curved outline, so it can be moved but not resized.');
          for (const n of ix) if (order[order.length - 1] !== n - 1) order.push(n - 1);
        }
      }
      if (order.length > 1 && order[0] !== order[order.length - 1]) order.push(order[0]);
      const handles = order.map((i) => {
        const r = rows[i];
        const pid = this.newId();
        const pt = new WebIFC.IFC4.IfcCartesianPoint([this.len((r[0] ?? 0) * sx), this.len((r[1] ?? 0) * sy)]);
        (pt as any).expressID = pid;
        this.write(pt);
        return this.handle(pid);
      });
      const nid = this.newId();
      const pl = new WebIFC.IFC4.IfcPolyline(handles);
      (pl as any).expressID = nid;
      this.write(pl);
      return nid;
    }
    throw new Error(`Cannot resize an outline of type ${cls}.`);
  }

  /** Removes elements and everything that only exists to point at them. Returns every id removed. */
  private deleteElements(ids: number[]): number[] {
    const doomed = new Set<number>(ids);
    // parts of an assembly go with their parent
    const aggregates = this.allIds(WebIFC.IFCRELAGGREGATES).map((rid) => this.L(rid));
    for (let pass = 0; pass < 3; pass++) {
      for (const rel of aggregates) {
        if (doomed.has(rel.RelatingObject?.value)) for (const h of rel.RelatedObjects || []) doomed.add(h.value);
      }
    }
    // openings cut by a doomed wall go too
    for (const rid of this.allIds(WebIFC.IFCRELVOIDSELEMENT)) {
      const rel = this.L(rid);
      if (doomed.has(rel.RelatingBuildingElement?.value) && rel.RelatedOpeningElement) doomed.add(rel.RelatedOpeningElement.value);
    }

    for (const type of RELATION_TYPES) {
      for (const rid of this.allIds(type)) {
        const rel = this.L(rid);
        let drop = false;
        let touched = false;
        for (const key of Object.keys(rel)) {
          const v = rel[key];
          if (Array.isArray(v) && v.length && isHandle(v[0])) {
            const kept = v.filter((h: any) => !doomed.has(h.value));
            if (kept.length !== v.length) {
              touched = true;
              rel[key] = kept;
              if (!kept.length) drop = true;
            }
          } else if (isHandle(v) && doomed.has(v.value) && key !== 'OwnerHistory') {
            drop = true;
          }
        }
        if (drop) this.api.DeleteLine(this.mid, rid);
        else if (touched) this.write(rel);
      }
    }
    for (const id of doomed) {
      try {
        this.api.DeleteLine(this.mid, id);
      } catch {
        /* line already gone */
      }
    }
    return [...doomed];
  }

  /* ───────────────────────── drawings ───────────────────────── */

  /** Cuts every element with a plane. `onlyAbove` and `onlyBelow` limit plan cuts to a storey's own elements. */
  slice(plane: SlicePlane, filter?: (rec: ElementRecord) => boolean): SliceResult {
    const segments: CutSegment[] = [];
    const level = plane.kind === 'plan' ? plane.z : plane.kind === 'sectionX' ? plane.x : plane.y;
    const axis = plane.kind === 'plan' ? 2 : plane.kind === 'sectionX' ? 0 : 1;
    for (const rec of this.records.values()) {
      if (rec.bbox[axis] > level || rec.bbox[axis + 3] < level) continue;
      if (filter && !filter(rec)) continue;
      const mesh = this.meshes.get(rec.id);
      if (!mesh) continue;
      for (const s of sliceMesh(mesh, plane)) {
        segments.push({ id: rec.id, cls: rec.cls, x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
      }
    }
    return { segments };
  }

  /** Elements whose box touches a box, for proximity questions such as "windows near this room". */
  near(box: Box6, pad: number): number[] {
    const out: number[] = [];
    for (const rec of this.records.values()) if (boxesOverlap(rec.bbox, box, pad)) out.push(rec.id);
    return out;
  }

  dispose(): void {
    this.closeModel();
    this.meshes.clear();
    this.records.clear();
  }
}
