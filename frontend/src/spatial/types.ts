export type Vector3D = [number, number, number];

export type DisciplineType = 'architectural' | 'structural' | 'mechanical' | 'electrical' | 'plumbing' | 'generic';

export type ClashSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ClashType = 'hard' | 'clearance';

export interface AxisAlignedBoundingBox {
  min: Vector3D;
  max: Vector3D;
  size: Vector3D;
  center: Vector3D;
}

export interface SpatialElement {
  id: string;
  name: string;
  discipline: DisciplineType;
  boundingBox: AxisAlignedBoundingBox;
  properties?: Record<string, any>;
}

export interface ClashOptions {
  tolerance?: number;
  minSeverity?: ClashSeverity;
  includeTouching?: boolean;
  filterDisciplines?: DisciplineType[];
}

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

export interface Ray3D {
  origin: Vector3D;
  direction: Vector3D;
}
