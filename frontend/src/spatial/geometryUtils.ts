/**
 * 3D vector and bounding box geometric calculation utilities
 */

import type { Vector3D, AxisAlignedBoundingBox } from './types';
import { createAxisAlignedBoundingBox } from './aabb';

/**
 * Calculates Euclidean distance between two 3D points.
 */
export function pointDistance3D(p1: Vector3D, p2: Vector3D): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const dz = p2[2] - p1[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Linearly interpolates between two 3D coordinate vectors by factor t in [0, 1].
 */
export function lerpPoint3D(p1: Vector3D, p2: Vector3D, t: number): Vector3D {
  return [
    p1[0] + (p2[0] - p1[0]) * t,
    p1[1] + (p2[1] - p1[1]) * t,
    p1[2] + (p2[2] - p1[2]) * t
  ];
}

/**
 * Computes shortest separation distance between two 3D axis-aligned bounding boxes.
 * Returns 0 if the boxes intersect or touch.
 */
export function calculateAABBDistance(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): number {
  let dx = 0;
  if (a.max[0] < b.min[0]) {
    dx = b.min[0] - a.max[0];
  } else if (b.max[0] < a.min[0]) {
    dx = a.min[0] - b.max[0];
  }

  let dy = 0;
  if (a.max[1] < b.min[1]) {
    dy = b.min[1] - a.max[1];
  } else if (b.max[1] < a.min[1]) {
    dy = a.min[1] - b.max[1];
  }

  let dz = 0;
  if (a.max[2] < b.min[2]) {
    dz = b.min[2] - a.max[2];
  } else if (b.max[2] < a.min[2]) {
    dz = a.min[2] - b.max[2];
  }

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Computes closest coordinate points between two separated bounding boxes.
 */
export function getClosestPointsAABB(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): { pointA: Vector3D; pointB: Vector3D } {
  const clamp = (val: number, min: number, max: number) =>
    Math.max(min, Math.min(max, val));

  const targetA: Vector3D = [
    clamp(b.center[0], a.min[0], a.max[0]),
    clamp(b.center[1], a.min[1], a.max[1]),
    clamp(b.center[2], a.min[2], a.max[2])
  ];

  const targetB: Vector3D = [
    clamp(targetA[0], b.min[0], b.max[0]),
    clamp(targetA[1], b.min[1], b.max[1]),
    clamp(targetA[2], b.min[2], b.max[2])
  ];

  return {
    pointA: targetA,
    pointB: targetB
  };
}

/**
 * Computes minimum enclosing bounding box covering an array of bounding boxes.
 */
export function unionBoundingBoxes(
  boxes: AxisAlignedBoundingBox[]
): AxisAlignedBoundingBox {
  if (boxes.length === 0) {
    return createAxisAlignedBoundingBox([0, 0, 0], [0, 0, 0]);
  }

  const min: Vector3D = [boxes[0].min[0], boxes[0].min[1], boxes[0].min[2]];
  const max: Vector3D = [boxes[0].max[0], boxes[0].max[1], boxes[0].max[2]];

  for (let i = 1; i < boxes.length; i++) {
    min[0] = Math.min(min[0], boxes[i].min[0]);
    min[1] = Math.min(min[1], boxes[i].min[1]);
    min[2] = Math.min(min[2], boxes[i].min[2]);

    max[0] = Math.max(max[0], boxes[i].max[0]);
    max[1] = Math.max(max[1], boxes[i].max[1]);
    max[2] = Math.max(max[2], boxes[i].max[2]);
  }

  return createAxisAlignedBoundingBox(min, max);
}

/**
 * Scales an AABB around its center by a uniform scale factor.
 */
export function scaleBoundingBox(
  box: AxisAlignedBoundingBox,
  factor: number
): AxisAlignedBoundingBox {
  const newSize: Vector3D = [
    box.size[0] * factor,
    box.size[1] * factor,
    box.size[2] * factor
  ];

  const min: Vector3D = [
    box.center[0] - newSize[0] / 2,
    box.center[1] - newSize[1] / 2,
    box.center[2] - newSize[2] / 2
  ];

  const max: Vector3D = [
    box.center[0] + newSize[0] / 2,
    box.center[1] + newSize[1] / 2,
    box.center[2] + newSize[2] / 2
  ];

  return createAxisAlignedBoundingBox(min, max);
}

/**
 * Translates an AABB by a 3D offset vector.
 */
export function translateBoundingBox(
  box: AxisAlignedBoundingBox,
  offset: Vector3D
): AxisAlignedBoundingBox {
  return createAxisAlignedBoundingBox(
    [box.min[0] + offset[0], box.min[1] + offset[1], box.min[2] + offset[2]],
    [box.max[0] + offset[0], box.max[1] + offset[1], box.max[2] + offset[2]]
  );
}
