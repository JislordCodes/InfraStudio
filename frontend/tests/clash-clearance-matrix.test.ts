import { describe, it, expect } from 'vitest';
import {
  createAxisAlignedBoundingBox,
  calculateClearance,
  buildClearanceMatrix,
  SpatialElement,
  ClearanceMatrixResult
} from '../src/spatial';
//
describe('Spatial Clearance Analysis & Distance Matrix', () => {
  it('Clearance Calculation: computes exact Euclidean distance between separated elements', () => {
    const elem1: SpatialElement = {
      id: 'box-1',
      name: 'Equipment Alpha',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'box-2',
      name: 'Equipment Beta',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([5, 0, 0], [7, 2, 2])
    };
    const clearance = calculateClearance(elem1, elem2, 1.0);
    expect(clearance.distance).toBeCloseTo(3.0);
    expect(clearance.hasConflict).toBe(false);
  });
//
  it('Clearance Calculation: computes zero distance for overlapping elements', () => {
    const elem1: SpatialElement = {
      id: 'box-1',
      name: 'Wall Section',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [5, 2, 3])
    };
    const elem2: SpatialElement = {
      id: 'box-2',
      name: 'Conduit Line',
      discipline: 'electrical',
      boundingBox: createAxisAlignedBoundingBox([2, 0, 1], [4, 2, 2])
    };
    const clearance = calculateClearance(elem1, elem2, 0.5);
    expect(clearance.distance).toBe(0);
    expect(clearance.hasConflict).toBe(true);
  });
//
  it('Clearance Calculation: returns closest coordinate points between separated bounding boxes', () => {
    const elem1: SpatialElement = {
      id: 'b1',
      name: 'Base Block',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'b2',
      name: 'Upper Offset Block',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([5, 6, 0], [7, 8, 2])
    };
    const clearance = calculateClearance(elem1, elem2, 10.0);
    expect(clearance.closestPoints.pointA).toEqual([2, 2, 1]);
    expect(clearance.closestPoints.pointB).toEqual([5, 6, 1]);
    expect(clearance.distance).toBeCloseTo(5.0);
  });
//
  it('Clearance Calculation: correctly determines conflict status based on required clearance', () => {
    const elem1: SpatialElement = {
      id: 'e1',
      name: 'High Voltage Line',
      discipline: 'electrical',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [10, 1, 1])
    };
    const elem2: SpatialElement = {
      id: 'e2',
      name: 'Water Main',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([0, 2, 0], [10, 3, 1])
    };
    const safeCheck = calculateClearance(elem1, elem2, 0.5);
    expect(safeCheck.distance).toBeCloseTo(1.0);
    expect(safeCheck.hasConflict).toBe(false);
    const conflictCheck = calculateClearance(elem1, elem2, 1.5);
    expect(conflictCheck.distance).toBeCloseTo(1.0);
    expect(conflictCheck.hasConflict).toBe(true);
  });
//
  it('Clearance Distance Matrix: builds symmetric NxN distance matrix across all elements', () => {
    const elements: SpatialElement[] = [
      { id: 'A', name: 'Item A', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) },
      { id: 'B', name: 'Item B', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([3, 0, 0], [4, 1, 1]) },
      { id: 'C', name: 'Item C', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([0, 5, 0], [1, 6, 1]) }
    ];
    const matrixRes = buildClearanceMatrix(elements, 1.0);
    expect(matrixRes.elementIds).toEqual(['A', 'B', 'C']);
    expect(matrixRes.matrix.length).toBe(3);
    expect(matrixRes.matrix[0][0]).toBe(0);
    expect(matrixRes.matrix[1][1]).toBe(0);
    expect(matrixRes.matrix[2][2]).toBe(0);
    expect(matrixRes.matrix[0][1]).toBeCloseTo(2.0);
    expect(matrixRes.matrix[1][0]).toBeCloseTo(2.0);
    expect(matrixRes.matrix[0][2]).toBeCloseTo(4.0);
    expect(matrixRes.matrix[2][0]).toBeCloseTo(4.0);
  });
//
  it('Clearance Distance Matrix: identifies all pair-wise clearance violations', () => {
    const elements: SpatialElement[] = [
      { id: 'A', name: 'Tray A', discipline: 'electrical', boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2]) },
      { id: 'B', name: 'Pipe B', discipline: 'plumbing', boundingBox: createAxisAlignedBoundingBox([2.5, 0, 0], [4.5, 2, 2]) },
      { id: 'C', name: 'Wall C', discipline: 'architectural', boundingBox: createAxisAlignedBoundingBox([10, 0, 0], [12, 2, 2]) }
    ];
    const matrixRes = buildClearanceMatrix(elements, 1.0);
    expect(matrixRes.violations.length).toBe(1);
    expect(matrixRes.violations[0].elementA).toBe('A');
    expect(matrixRes.violations[0].elementB).toBe('B');
    expect(matrixRes.violations[0].distance).toBeCloseTo(0.5);
    expect(matrixRes.violations[0].requiredClearance).toBe(1.0);
  });
//
  it('Clearance Distance Matrix: respects maxDistanceCutoff by assigning Infinity to distant pairs', () => {
    const elements: SpatialElement[] = [
      { id: 'A', name: 'Origin Element', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) },
      { id: 'B', name: 'Near Element', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([3, 0, 0], [4, 1, 1]) },
      { id: 'C', name: 'Distant Element', discipline: 'structural', boundingBox: createAxisAlignedBoundingBox([100, 0, 0], [101, 1, 1]) }
    ];
    const matrixRes = buildClearanceMatrix(elements, 1.0, 50.0);
    expect(matrixRes.matrix[0][1]).toBeCloseTo(2.0);
    expect(matrixRes.matrix[0][2]).toBe(Infinity);
    expect(matrixRes.matrix[2][0]).toBe(Infinity);
  });
//
  it('Spatial Clearance Edge Case Suite 2A: evaluates zero required clearance', () => {
    const elem1 = { id: '1', name: 'A', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) };
    const elem2 = { id: '2', name: 'B', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([2, 0, 0], [3, 1, 1]) };
    const res = calculateClearance(elem1, elem2, 0);
    expect(res.hasConflict).toBe(false);
  });
//
  it('Spatial Clearance Edge Case Suite 2B: evaluates diagonal offset distance', () => {
    const elem1 = { id: '1', name: 'A', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) };
    const elem2 = { id: '2', name: 'B', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([4, 5, 1], [5, 6, 2]) };
    const res = calculateClearance(elem1, elem2, 10);
    expect(res.distance).toBeCloseTo(5.0);
  });
//
  it('Spatial Clearance Edge Case Suite 2C: builds empty clearance matrix safely', () => {
    const res = buildClearanceMatrix([], 1.0);
    expect(res.matrix).toEqual([]);
    expect(res.violations).toEqual([]);
  });
//
  it('Spatial Clearance Edge Case Suite 2D: builds single-element clearance matrix safely', () => {
    const elem1 = { id: '1', name: 'A', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) };
    const res = buildClearanceMatrix([elem1], 1.0);
    expect(res.matrix).toEqual([[0]]);
    expect(res.violations).toEqual([]);
  });
//
  it('Spatial Clearance Edge Case Suite 2E: validates cutoff below minimum separation', () => {
    const elem1 = { id: '1', name: 'A', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]) };
    const elem2 = { id: '2', name: 'B', discipline: 'structural' as const, boundingBox: createAxisAlignedBoundingBox([5, 0, 0], [6, 1, 1]) };
    const res = buildClearanceMatrix([elem1, elem2], 1.0, 2.0);
    expect(res.matrix[0][1]).toBe(Infinity);
  });
});
//
