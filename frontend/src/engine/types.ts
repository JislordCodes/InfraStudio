/**
 * Shared types for the in-browser IFC engine (see ifcEngine.ts).
 *
 * All lengths are metres and all areas / volumes are m2 / m3. Coordinates are IFC
 * coordinates (X east, Y north, Z up), NOT the viewer's Y-up scene coordinates.
 */

export type Vec3 = [number, number, number];
/** minX, minY, minZ, maxX, maxY, maxZ */
export type Box6 = [number, number, number, number, number, number];

export interface StoreyRecord {
  id: number;
  name: string;
  /** metres above the model origin */
  elevation: number;
}

/** What one element is, where it is, and what it measures. */
export interface ElementRecord {
  /** IFC STEP id (stable across edits and saves) */
  id: number;
  guid: string;
  /** e.g. "IfcWall" */
  cls: string;
  name: string;
  storey: string | null;
  materials: string[];
  /** Flattened property values, keyed "PsetName.PropertyName" */
  props: Record<string, string>;
  /** world-space bounding box (IFC coordinates) */
  bbox: Box6;
  /** size along the element's own placement axes X, Y, Z */
  local: Vec3;
  /** Natural dimensions: height = extent along the axis that is most vertical,
   *  length and thickness = the larger and smaller of the other two. */
  size: { length: number; thickness: number; height: number };
  /** m3, from the triangle mesh */
  volume: number;
  /** m2 of one face: volume / thickness (walls, slabs, doors, windows) */
  area: number;
  /** m2, every mesh face */
  surface: number;
}

export interface ModelTable {
  project: string;
  /** metres per file length unit */
  unitScale: number;
  storeys: StoreyRecord[];
  elements: ElementRecord[];
  /** union of every element's world box */
  bbox: Box6 | null;
}

export type AxisLabel = string;

export interface EditAxis {
  /** 0 = placement X, 1 = placement Y, 2 = placement Z */
  index: 0 | 1 | 2;
  label: AxisLabel;
  size: number;
}

/** What can be done to one element, shown in the edit panel. */
export interface EditInfo {
  id: number;
  movable: boolean;
  resizable: boolean;
  /** why resizing is off, in plain words */
  reason?: string;
  axes: EditAxis[];
}

export type EditOp =
  | { kind: 'move'; ids: number[]; delta: Vec3 }
  /** sizes: target size per placement axis in metres; anchor "base" keeps the bottom of the
   *  element fixed, "centre" keeps its centre fixed */
  | { kind: 'resize'; id: number; sizes: Partial<Record<0 | 1 | 2, number>>; anchor: 'base' | 'centre' }
  /** Same as resize, but names the dimension the way a person would: the larger plan side
   *  (length or width), the smaller plan side (thickness or depth), or the vertical side. */
  | { kind: 'resizeBy'; id: number; dim: 'length' | 'thickness' | 'height'; size: number; anchor: 'base' | 'centre' }
  | { kind: 'delete'; ids: number[] }
  | { kind: 'rename'; id: number; name: string };

export interface EditResult {
  ok: boolean;
  error?: string;
  /** ids whose geometry changed (re-measured) */
  changed: number[];
  /** ids that no longer exist */
  removed: number[];
  table: ModelTable;
}

/** One line of a section cut, in the cutting plane's own 2D coordinates. */
export interface CutSegment {
  id: number;
  cls: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type SlicePlane =
  /** horizontal plane at Z = value; output coordinates are (X, Y) */
  | { kind: 'plan'; z: number }
  /** vertical plane at X = value; output coordinates are (Y, Z) */
  | { kind: 'sectionX'; x: number }
  /** vertical plane at Y = value; output coordinates are (X, Z) */
  | { kind: 'sectionY'; y: number };

/** Project outline from the model's lowest and highest points, for drawings. */
export interface SliceResult {
  segments: CutSegment[];
}
