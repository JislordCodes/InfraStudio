/**
 * Bounding box and geometric collision primitives for 3D spatial analysis
 */

import type { Vector3D, AxisAlignedBoundingBox } from './types';

/**
 * Creates an axis-aligned bounding box from minimum and maximum coordinate vectors.
 * Throws a descriptive error if any minimum component exceeds its corresponding maximum.
 */
export function createAxisAlignedBoundingBox(
  min: Vector3D,
  max: Vector3D
): AxisAlignedBoundingBox {
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
    throw new Error(
      'Invalid bounding box coordinates: min values must be less than or equal to max values'
    );
  }

  const size: Vector3D = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2]
  ];

  const center: Vector3D = [
    min[0] + size[0] / 2,
    min[1] + size[1] / 2,
    min[2] + size[2] / 2
  ];

  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    size,
    center
  };
}

/**
 * Determines whether two axis-aligned bounding boxes overlap in 3D space.
 */
export function intersectsAABB(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/**
 * Computes the overlapping intersection volume bounding box between two AABBs.
 * Returns null if the boxes do not intersect.
 */
export function computeIntersectionBox(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): AxisAlignedBoundingBox | null {
  if (!intersectsAABB(a, b)) {
    return null;
  }

  const min: Vector3D = [
    Math.max(a.min[0], b.min[0]),
    Math.max(a.min[1], b.min[1]),
    Math.max(a.min[2], b.min[2])
  ];

  const max: Vector3D = [
    Math.min(a.max[0], b.max[0]),
    Math.min(a.max[1], b.max[1]),
    Math.min(a.max[2], b.max[2])
  ];

  return createAxisAlignedBoundingBox(min, max);
}

/**
 * Computes the penetration depth between two colliding AABBs along the minimum overlap axis.
 */
export function computePenetrationDepth(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): number {
  const intersection = computeIntersectionBox(a, b);
  if (!intersection) {
    return 0;
  }
  return Math.min(
    intersection.size[0],
    intersection.size[1],
    intersection.size[2]
  );
}

/**
 * Expands an AABB symmetrically by a uniform margin on all sides.
 */
export function expandBoundingBox(
  box: AxisAlignedBoundingBox,
  margin: number
): AxisAlignedBoundingBox {
  return createAxisAlignedBoundingBox(
    [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin]
  );
}

/**
 * Tests whether a 3D coordinate point lies within the interior or on the boundary of an AABB.
 */
export function containsPoint(
  box: AxisAlignedBoundingBox,
  point: Vector3D
): boolean {
  return (
    point[0] >= box.min[0] &&
    point[0] <= box.max[0] &&
    point[1] >= box.min[1] &&
    point[1] <= box.max[1] &&
    point[2] >= box.min[2] &&
    point[2] <= box.max[2]
  );
}
