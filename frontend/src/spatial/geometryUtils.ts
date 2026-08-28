import { Vector3D, AxisAlignedBoundingBox } from './types';

export function calculateAABBDistance(a: AxisAlignedBoundingBox, b: AxisAlignedBoundingBox): number {
  let dx = 0;
  let dy = 0;
  let dz = 0;

  if (a.max[0] < b.min[0]) {
    dx = b.min[0] - a.max[0];
  } else if (b.max[0] < a.min[0]) {
    dx = a.min[0] - b.max[0];
  }

  if (a.max[1] < b.min[1]) {
    dy = b.min[1] - a.max[1];
  } else if (b.max[1] < a.min[1]) {
    dy = a.min[1] - b.max[1];
  }

  if (a.max[2] < b.min[2]) {
    dz = b.min[2] - a.max[2];
  } else if (b.max[2] < a.min[2]) {
    dz = a.min[2] - b.max[2];
  }

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function getClosestPointsAABB(
  a: AxisAlignedBoundingBox,
  b: AxisAlignedBoundingBox
): { pointA: Vector3D; pointB: Vector3D } {
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

  const pointA: Vector3D = [
    clamp(b.center[0], a.min[0], a.max[0]),
    clamp(b.center[1], a.min[1], a.max[1]),
    clamp(b.center[2], a.min[2], a.max[2])
  ];

  const pointB: Vector3D = [
    clamp(a.center[0], b.min[0], b.max[0]),
    clamp(a.center[1], b.min[1], b.max[1]),
    clamp(a.center[2], b.min[2], b.max[2])
  ];

  return { pointA, pointB };
}

export function pointDistance3D(p1: Vector3D, p2: Vector3D): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const dz = p2[2] - p1[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function lerpPoint3D(p1: Vector3D, p2: Vector3D, t: number): Vector3D {
  return [
    p1[0] + (p2[0] - p1[0]) * t,
    p1[1] + (p2[1] - p1[1]) * t,
    p1[2] + (p2[2] - p1[2]) * t
  ];
}

export function unionBoundingBoxes(boxes: AxisAlignedBoundingBox[]): AxisAlignedBoundingBox | null {
  if (!boxes || boxes.length === 0) return null;
  let minX = boxes[0].min[0];
  let minY = boxes[0].min[1];
  let minZ = boxes[0].min[2];
  let maxX = boxes[0].max[0];
  let maxY = boxes[0].max[1];
  let maxZ = boxes[0].max[2];

  for (let i = 1; i < boxes.length; i++) {
    minX = Math.min(minX, boxes[i].min[0]);
    minY = Math.min(minY, boxes[i].min[1]);
    minZ = Math.min(minZ, boxes[i].min[2]);
    maxX = Math.max(maxX, boxes[i].max[0]);
    maxY = Math.max(maxY, boxes[i].max[1]);
    maxZ = Math.max(maxZ, boxes[i].max[2]);
  }

  const size: Vector3D = [maxX - minX, maxY - minY, maxZ - minZ];
  const center: Vector3D = [minX + size[0] / 2, minY + size[1] / 2, minZ + size[2] / 2];

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size,
    center
  };
}

export function scaleBoundingBox(box: AxisAlignedBoundingBox, factor: number): AxisAlignedBoundingBox {
  const halfSize: Vector3D = [
    (box.size[0] * factor) / 2,
    (box.size[1] * factor) / 2,
    (box.size[2] * factor) / 2
  ];
  return {
    min: [box.center[0] - halfSize[0], box.center[1] - halfSize[1], box.center[2] - halfSize[2]],
    max: [box.center[0] + halfSize[0], box.center[1] + halfSize[1], box.center[2] + halfSize[2]],
    size: [box.size[0] * factor, box.size[1] * factor, box.size[2] * factor],
    center: [...box.center]
  };
}

export function translateBoundingBox(box: AxisAlignedBoundingBox, offset: Vector3D): AxisAlignedBoundingBox {
  return {
    min: [box.min[0] + offset[0], box.min[1] + offset[1], box.min[2] + offset[2]],
    max: [box.max[0] + offset[0], box.max[1] + offset[1], box.max[2] + offset[2]],
    size: [...box.size],
    center: [box.center[0] + offset[0], box.center[1] + offset[1], box.center[2] + offset[2]]
  };
}
