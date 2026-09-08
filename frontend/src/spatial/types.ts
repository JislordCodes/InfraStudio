/**
 * TypeScript definitions and data structures for 3D BIM spatial analysis
 */

export type Vector3D = [number, number, number];

export interface AxisAlignedBoundingBox {
  min: Vector3D;
  max: Vector3D;
  size: Vector3D;
  center: Vector3D;
}

export type DisciplineType =
  | 'architectural'
  | 'structural'
  | 'mechanical'
  | 'electrical'
  | 'plumbing'
  | 'generic';

export interface SpatialElement {
  id: string;
  name: string;
  discipline: DisciplineType;
  boundingBox: AxisAlignedBoundingBox;
  properties?: Record<string, unknown>;
}

export type ClashType = 'hard' | 'clearance' | 'duplicate';
export type ClashSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ClashRecord {
  id: string;
  elementA: SpatialElement;
  elementB: SpatialElement;
  type: ClashType;
  severity: ClashSeverity;
  distance: number;
  penetrationDepth?: number;
  intersectionBox?: AxisAlignedBoundingBox;
}

export interface ClashSummary {
  total: number;
  hard: number;
  clearance: number;
  processedElements: number;
}

export interface ClashResult {
  clashes: ClashRecord[];
  summary: ClashSummary;
}

export interface ClashOptions {
  tolerance?: number;
  minSeverity?: ClashSeverity;
  includeTouching?: boolean;
  filterDisciplines?: DisciplineType[];
}

export interface ClearanceInfo {
  distance: number;
  hasConflict: boolean;
  closestPoints: {
    pointA: Vector3D;
    pointB: Vector3D;
  };
}

export interface ClearanceViolation {
  elementA: string;
  elementB: string;
  distance: number;
  requiredClearance: number;
}

export interface ClearanceMatrixResult {
  elementIds: string[];
  matrix: number[][];
  violations: ClearanceViolation[];
}
