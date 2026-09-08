/**
 * Clearance analysis and distance matrix generation for spatial components
 */

import type {
  SpatialElement,
  ClearanceInfo,
  ClearanceMatrixResult,
  ClearanceViolation
} from './types';
import { calculateAABBDistance, getClosestPointsAABB } from './geometryUtils';

/**
 * Calculates clearance distance and conflict status between two elements.
 */
export function calculateClearance(
  elemA: SpatialElement,
  elemB: SpatialElement,
  requiredClearance: number
): ClearanceInfo {
  const distance = calculateAABBDistance(
    elemA.boundingBox,
    elemB.boundingBox
  );
  const closestPoints = getClosestPointsAABB(
    elemA.boundingBox,
    elemB.boundingBox
  );

  return {
    distance,
    hasConflict: distance < requiredClearance,
    closestPoints
  };
}

/**
 * Builds a symmetric NxN clearance distance matrix and identifies all pairwise violations.
 */
export function buildClearanceMatrix(
  elements: SpatialElement[],
  requiredClearance: number,
  maxDistanceCutoff?: number
): ClearanceMatrixResult {
  const elementIds = elements.map(e => e.id);
  const n = elements.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const violations: ClearanceViolation[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 0;
      } else {
        const elemA = elements[i];
        const elemB = elements[j];
        let dist = calculateAABBDistance(
          elemA.boundingBox,
          elemB.boundingBox
        );

        if (maxDistanceCutoff !== undefined && dist > maxDistanceCutoff) {
          dist = Infinity;
        }

        matrix[i][j] = dist;
        matrix[j][i] = dist;

        if (dist < requiredClearance) {
          violations.push({
            elementA: elemA.id,
            elementB: elemB.id,
            distance: dist,
            requiredClearance
          });
        }
      }
    }
  }

  return {
    elementIds,
    matrix,
    violations
  };
}
