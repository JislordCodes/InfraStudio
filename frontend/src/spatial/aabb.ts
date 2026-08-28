import { Vector3D, AxisAlignedBoundingBox } from './types';

export function createAxisAlignedBoundingBox(min: Vector3D, max: Vector3D): AxisAlignedBoundingBox {
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
    throw new Error('Invalid bounding box coordinates: min values must be less than or equal to max values');
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

export function intersectsAABB(a: AxisAlignedBoundingBox, b: AxisAlignedBoundingBox, tolerance = 0): boolean {
  return (
    a.min[0] <= b.max[0] + tolerance &&
    a.max[0] >= b.min[0] - tolerance &&
    a.min[1] <= b.max[1] + tolerance &&
    a.max[1] >= b.min[1] - tolerance &&
    a.min[2] <= b.max[2] + tolerance &&
    a.max[2] >= b.min[2] - tolerance
  );
}

export function computeIntersectionBox(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): AxisAlignedBoundingBox | null {
  const minX = Math.max(a.min[0], b.min[0]);
  const minY = Math.max(a.min[1], b.min[1]);
  const minZ = Math.max(a.min[2], b.min[2]);

  const maxX = Math.min(a.max[0], b.max[0]);
  const maxY = Math.min(a.max[1], b.max[1]);
  const maxZ = Math.min(a.max[2], b.max[2]);

  if (minX <= maxX && minY <= maxY && minZ <= maxZ) {
    return createAxisAlignedBoundingBox([minX, minY, minZ], [maxX, maxY, maxZ]);
  }
  return null;
}

export function computePenetrationDepth(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): number {
  const overlapX = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const overlapY = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const overlapZ = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);

  if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
    return Math.min(overlapX, overlapY, overlapZ);
  }
  return 0;
}

export function expandBoundingBox(box: AxisAlignedBoundingBox, margin: number): AxisAlignedBoundingBox {
  return createAxisAlignedBoundingBox(
    [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin]
  );
}

export function containsPoint(box: AxisAlignedBoundingBox, point: Vector3D): boolean {
  return (
    point[0] >= box.min[0] && point[0] <= box.max[0] &&
    point[1] >= box.min[1] && point[1] <= box.max[1] &&
    point[2] >= box.min[2] && point[2] <= box.max[2]
  );
}
