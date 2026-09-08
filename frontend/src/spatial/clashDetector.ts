/**
 * Clash detection algorithms for 3D BIM spatial models
 */

import type {
  SpatialElement,
  ClashRecord,
  ClashResult,
  ClashOptions,
  ClashSeverity
} from './types';
import {
  computeIntersectionBox,
  computePenetrationDepth
} from './aabb';
import { calculateAABBDistance } from './geometryUtils';

const SEVERITY_RANK: Record<ClashSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

/**
 * Detects hard physical collisions and clearance proximity violations among spatial elements.
 */
export function detectClashes(
  elements: SpatialElement[],
  options?: ClashOptions
): ClashResult {
  const clashes: ClashRecord[] = [];
  let hardCount = 0;
  let clearanceCount = 0;

  if (!elements || elements.length < 2) {
    return {
      clashes: [],
      summary: {
        total: 0,
        hard: 0,
        clearance: 0,
        processedElements: elements ? elements.length : 0
      }
    };
  }

  const tolerance = options?.tolerance ?? 0;
  const minSeverity = options?.minSeverity;
  const includeTouching = options?.includeTouching ?? false;
  const filterDisciplines = options?.filterDisciplines;

  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const elemA = elements[i];
      const elemB = elements[j];

      if (filterDisciplines && filterDisciplines.length >= 2) {
        const hasA = filterDisciplines.includes(elemA.discipline);
        const hasB = filterDisciplines.includes(elemB.discipline);
        if (!hasA || !hasB || elemA.discipline === elemB.discipline) {
          continue;
        }
      }

      const intersection = computeIntersectionBox(
        elemA.boundingBox,
        elemB.boundingBox
      );

      if (intersection) {
        const isTouching =
          intersection.size[0] === 0 ||
          intersection.size[1] === 0 ||
          intersection.size[2] === 0;

        if (isTouching && !includeTouching) {
          continue;
        }

        const penetration = computePenetrationDepth(
          elemA.boundingBox,
          elemB.boundingBox
        );

        const record: ClashRecord = {
          id: `clash-${elemA.id}-${elemB.id}`,
          elementA: elemA,
          elementB: elemB,
          type: 'hard',
          severity: 'critical',
          distance: 0,
          penetrationDepth: penetration,
          intersectionBox: intersection
        };

        if (
          !minSeverity ||
          SEVERITY_RANK[record.severity] >= SEVERITY_RANK[minSeverity]
        ) {
          clashes.push(record);
          hardCount++;
        }
      } else if (tolerance > 0) {
        const distance = calculateAABBDistance(
          elemA.boundingBox,
          elemB.boundingBox
        );

        if (distance > 0 && distance <= tolerance) {
          const severity: ClashSeverity =
            distance < tolerance * 0.5 ? 'high' : 'medium';

          const record: ClashRecord = {
            id: `clash-${elemA.id}-${elemB.id}`,
            elementA: elemA,
            elementB: elemB,
            type: 'clearance',
            severity,
            distance
          };

          if (
            !minSeverity ||
            SEVERITY_RANK[record.severity] >= SEVERITY_RANK[minSeverity]
          ) {
            clashes.push(record);
            clearanceCount++;
          }
        }
      }
    }
  }

  return {
    clashes,
    summary: {
      total: clashes.length,
      hard: hardCount,
      clearance: clearanceCount,
      processedElements: elements.length
    }
  };
}
