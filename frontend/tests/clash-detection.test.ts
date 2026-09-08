import { describe, it, expect } from 'vitest';
import {
  createAxisAlignedBoundingBox,
  detectClashes,
  groupClashes,
  exportClashReport,
  SpatialElement,
  ClashOptions,
  ClashResult,
  ClashRecord,
  AxisAlignedBoundingBox
} from '../src/spatial';
//
describe('Spatial Bounding Box & Clash Detection Engine', () => {
  it('Spatial Bounding Box: correctly creates a 3D AABB with valid min and max coordinates', () => {
    const box = createAxisAlignedBoundingBox([0, 0, 0], [10, 20, 30]);
    expect(box).toBeDefined();
    expect(box.min).toEqual([0, 0, 0]);
    expect(box.max).toEqual([10, 20, 30]);
    expect(box.size).toEqual([10, 20, 30]);
    expect(box.center).toEqual([5, 10, 15]);
  });
//
  it('Spatial Bounding Box: calculates correct size vector across X, Y, and Z dimensions', () => {
    const box1 = createAxisAlignedBoundingBox([-5, -10, -15], [5, 10, 15]);
    expect(box1.size).toEqual([10, 20, 30]);
    const box2 = createAxisAlignedBoundingBox([2.5, 3.5, 4.5], [7.5, 8.5, 9.5]);
    expect(box2.size[0]).toBeCloseTo(5.0);
    expect(box2.size[1]).toBeCloseTo(5.0);
    expect(box2.size[2]).toBeCloseTo(5.0);
  });
//
  it('Spatial Bounding Box: calculates accurate center coordinates of the bounding box', () => {
    const box = createAxisAlignedBoundingBox([10, 20, 30], [20, 40, 50]);
    expect(box.center).toEqual([15, 30, 40]);
    const offsetBox = createAxisAlignedBoundingBox([-10, -20, -30], [10, 20, 30]);
    expect(offsetBox.center).toEqual([0, 0, 0]);
  });
//
  it('Spatial Bounding Box: throws descriptive error on invalid min greater than max coordinates', () => {
    expect(() => {
      createAxisAlignedBoundingBox([10, 0, 0], [5, 10, 10]);
    }).toThrowError(/Invalid bounding box coordinates/);
    expect(() => {
      createAxisAlignedBoundingBox([0, 20, 0], [10, 10, 10]);
    }).toThrowError(/Invalid bounding box coordinates/);
    expect(() => {
      createAxisAlignedBoundingBox([0, 0, 30], [10, 10, 10]);
    }).toThrowError(/Invalid bounding box coordinates/);
  });
//
  it('Spatial Bounding Box: correctly computes volume of a 3D bounding box', () => {
    const box = createAxisAlignedBoundingBox([0, 0, 0], [2, 3, 4]);
    const volume = box.size[0] * box.size[1] * box.size[2];
    expect(volume).toBe(24);
    const unitBox = createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]);
    expect(unitBox.size[0] * unitBox.size[1] * unitBox.size[2]).toBe(1);
  });
//
  it('Spatial Bounding Box: detects point containment inside the bounding box', () => {
    const box = createAxisAlignedBoundingBox([0, 0, 0], [10, 10, 10]);
    const insidePoint: [number, number, number] = [5, 5, 5];
    const isContained =
      insidePoint[0] >= box.min[0] && insidePoint[0] <= box.max[0] &&
      insidePoint[1] >= box.min[1] && insidePoint[1] <= box.max[1] &&
      insidePoint[2] >= box.min[2] && insidePoint[2] <= box.max[2];
    expect(isContained).toBe(true);
  });
//
  it('Spatial Bounding Box: detects non-containment for points outside bounding volume', () => {
    const box = createAxisAlignedBoundingBox([0, 0, 0], [10, 10, 10]);
    const outsidePoint: [number, number, number] = [15, 5, 5];
    const isContained =
      outsidePoint[0] >= box.min[0] && outsidePoint[0] <= box.max[0] &&
      outsidePoint[1] >= box.min[1] && outsidePoint[1] <= box.max[1] &&
      outsidePoint[2] >= box.min[2] && outsidePoint[2] <= box.max[2];
    expect(isContained).toBe(false);
  });
//
  it('Spatial Clash Detection: identifies hard collision between overlapping elements', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Structural Column A',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 5])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'HVAC Duct B',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([1, 1, 2], [4, 4, 3])
    };
    const result = detectClashes([elem1, elem2]);
    expect(result.summary.total).toBe(1);
    expect(result.summary.hard).toBe(1);
    expect(result.clashes[0].type).toBe('hard');
    expect(result.clashes[0].elementA.id).toBe('elem-1');
    expect(result.clashes[0].elementB.id).toBe('elem-2');
  });
//
  it('Spatial Clash Detection: computes exact 3D intersection volume and bounding box', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Beam X',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [10, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Pipe Y',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([4, -1, 1], [6, 3, 3])
    };
    const result = detectClashes([elem1, elem2]);
    expect(result.clashes.length).toBe(1);
    const clash = result.clashes[0];
    expect(clash.intersectionBox).toBeDefined();
    expect(clash.intersectionBox!.min).toEqual([4, 0, 1]);
    expect(clash.intersectionBox!.max).toEqual([6, 2, 2]);
    expect(clash.intersectionBox!.size).toEqual([2, 2, 1]);
  });
//
  it('Spatial Clash Detection: computes correct minimum-axis penetration depth', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Wall W1',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [10, 1, 3])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Conduit C1',
      discipline: 'electrical',
      boundingBox: createAxisAlignedBoundingBox([2, 0.5, 1], [4, 1.5, 2])
    };
    const result = detectClashes([elem1, elem2]);
    expect(result.clashes.length).toBe(1);
    expect(result.clashes[0].penetrationDepth).toBeCloseTo(0.5);
  });
//
  it('Spatial Clash Detection: detects proximity clearance clashes within specified tolerance', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Cable Tray',
      discipline: 'electrical',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [5, 1, 1])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Cold Water Pipe',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([0, 1.2, 0], [5, 2.2, 1])
    };
    const result = detectClashes([elem1, elem2], { tolerance: 0.5 });
    expect(result.summary.clearance).toBe(1);
    expect(result.clashes[0].type).toBe('clearance');
    expect(result.clashes[0].distance).toBeCloseTo(0.2);
  });
//
  it('Spatial Clash Detection: distinguishes hard clashes from clearance clashes by severity', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Column C1',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 4])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Beam B1 (Overlapping)',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 2], [5, 2, 3])
    };
    const elem3: SpatialElement = {
      id: 'elem-3',
      name: 'Pipe P1 (Close)',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([2.1, 0, 0], [3, 1, 1])
    };
    const result = detectClashes([elem1, elem2, elem3], { tolerance: 0.5 });
    expect(result.summary.hard).toBe(1);
    expect(result.summary.clearance).toBe(1);
    const hardClash = result.clashes.find(c => c.type === 'hard');
    const clearanceClash = result.clashes.find(c => c.type === 'clearance');
    expect(hardClash?.severity).toBe('critical');
    expect(clearanceClash?.severity).toBe('high');
  });
//
  it('Spatial Clash Detection: respects includeTouching flag for zero-distance face contacts', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Slab S1',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [10, 10, 1])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Wall W1 (Resting on top)',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 1], [10, 0.5, 4])
    };
    const resultWithoutTouching = detectClashes([elem1, elem2], { includeTouching: false, tolerance: 0 });
    expect(resultWithoutTouching.summary.total).toBe(0);
    const resultWithTouching = detectClashes([elem1, elem2], { includeTouching: true, tolerance: 0.1 });
    expect(resultWithTouching.summary.total).toBe(1);
  });
//
  it('Spatial Clash Detection: ignores clearance breaches exceeding configured tolerance', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Equipment Box',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Far Pipe',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([10, 10, 10], [11, 11, 11])
    };
    const result = detectClashes([elem1, elem2], { tolerance: 1.0 });
    expect(result.summary.total).toBe(0);
    expect(result.clashes.length).toBe(0);
  });
//
  it('Spatial Clash Detection: filters collisions by discipline when filterDisciplines is provided', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Str Beam',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [5, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Arch Panel',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 0], [3, 2, 2])
    };
    const elem3: SpatialElement = {
      id: 'elem-3',
      name: 'HVAC Duct',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([2, 0, 0], [4, 2, 2])
    };
    const result = detectClashes([elem1, elem2, elem3], { filterDisciplines: ['structural', 'mechanical'] });
    expect(result.clashes.every(c =>
      (c.elementA.discipline === 'structural' && c.elementB.discipline === 'mechanical') ||
      (c.elementA.discipline === 'mechanical' && c.elementB.discipline === 'structural')
    )).toBe(true);
  });
//
  it('Spatial Clash Detection: filters results by minSeverity threshold', () => {
    const elem1: SpatialElement = {
      id: 'elem-1',
      name: 'Base Column',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 4])
    };
    const elem2: SpatialElement = {
      id: 'elem-2',
      name: 'Hard Collision Beam',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 1], [3, 2, 3])
    };
    const elem3: SpatialElement = {
      id: 'elem-3',
      name: 'Close Proximity Duct',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([2.1, 0, 0], [3, 1, 1])
    };
    const result = detectClashes([elem1, elem2, elem3], { tolerance: 0.5, minSeverity: 'critical' });
    expect(result.clashes.every(c => c.severity === 'critical')).toBe(true);
    expect(result.clashes.length).toBe(1);
  });
//
  it('Spatial Clash Detection: handles empty element lists safely without throwing errors', () => {
    const result = detectClashes([]);
    expect(result.clashes).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.summary.hard).toBe(0);
    expect(result.summary.clearance).toBe(0);
    expect(result.summary.processedElements).toBe(0);
  });
//
  it('Spatial Clash Detection: handles single element safely with zero clashes returned', () => {
    const elem: SpatialElement = {
      id: 'solo-elem',
      name: 'Isolated Pillar',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 3])
    };
    const result = detectClashes([elem]);
    expect(result.clashes).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.summary.processedElements).toBe(1);
  });
//
  it('Spatial Clash Grouping & Reporting: groups detected clashes by severity level', () => {
    const elem1: SpatialElement = {
      id: 'e1',
      name: 'Col 1',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 4])
    };
    const elem2: SpatialElement = {
      id: 'e2',
      name: 'Beam 1',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 1], [3, 2, 3])
    };
    const elem3: SpatialElement = {
      id: 'e3',
      name: 'Pipe High',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([2.1, 0, 0], [3, 1, 1])
    };
    const elem4: SpatialElement = {
      id: 'e4',
      name: 'Duct Med',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([2.35, 0, 0], [4, 1, 1])
    };
    const clashRes = detectClashes([elem1, elem2, elem3, elem4], { tolerance: 0.5 });
    const grouped = groupClashes(clashRes.clashes, 'severity');
    expect(grouped['critical']).toBeDefined();
    expect(grouped['high']).toBeDefined();
    expect(grouped['medium']).toBeDefined();
  });
//
  it('Spatial Clash Grouping & Reporting: groups detected clashes by participating element IDs', () => {
    const elem1: SpatialElement = {
      id: 'core-col',
      name: 'Core Column',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 10])
    };
    const elem2: SpatialElement = {
      id: 'duct-1',
      name: 'Duct Floor 1',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 2], [3, 2, 3])
    };
    const elem3: SpatialElement = {
      id: 'duct-2',
      name: 'Duct Floor 2',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 6], [3, 2, 7])
    };
    const clashRes = detectClashes([elem1, elem2, elem3]);
    const grouped = groupClashes(clashRes.clashes, 'element');
    expect(grouped['core-col'].length).toBe(2);
  });
//
  it('Spatial Clash Grouping & Reporting: groups detected clashes by discipline pair', () => {
    const elem1: SpatialElement = {
      id: 'e1',
      name: 'Str Beam',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [4, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'e2',
      name: 'Mech Duct',
      discipline: 'mechanical',
      boundingBox: createAxisAlignedBoundingBox([1, 0, 0], [3, 2, 2])
    };
    const clashRes = detectClashes([elem1, elem2]);
    const grouped = groupClashes(clashRes.clashes, 'discipline');
    expect(grouped['mechanical-structural']).toBeDefined();
  });
//
  it('Spatial Clash Grouping & Reporting: exports valid structured JSON report', () => {
    const elem1: SpatialElement = {
      id: 'e1',
      name: 'Item A',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'e2',
      name: 'Item B',
      discipline: 'architectural',
      boundingBox: createAxisAlignedBoundingBox([1, 1, 1], [3, 3, 3])
    };
    const clashRes = detectClashes([elem1, elem2]);
    const jsonReport = exportClashReport(clashRes, 'json');
    expect(jsonReport).toBe(JSON.stringify(clashRes, null, 2));
    expect(jsonReport).toContain('\n');
    const parsed = JSON.parse(jsonReport);
    expect(parsed.summary.total).toBe(1);
    expect(parsed.clashes[0].type).toBe('hard');
  });
//
  it('Spatial Clash Grouping & Reporting: exports formatted summary text with SPATIAL CLASH DETECTION REPORT header', () => {
    const elem1: SpatialElement = {
      id: 'e1',
      name: 'Pillar 1',
      discipline: 'structural',
      boundingBox: createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2])
    };
    const elem2: SpatialElement = {
      id: 'e2',
      name: 'Pipe 1',
      discipline: 'plumbing',
      boundingBox: createAxisAlignedBoundingBox([1, 1, 1], [3, 3, 3])
    };
    const clashRes = detectClashes([elem1, elem2]);
    const textReport = exportClashReport(clashRes, 'summary_text');
    expect(textReport).toContain('SPATIAL CLASH DETECTION REPORT');
    expect(textReport).toContain('Total Clashes: 1');
    expect(textReport).toContain('Hard Clashes: 1');
  });
//
  it('Spatial Edge Case Suite 1A: verifies scaling of boundary extents', () => {
    const box = createAxisAlignedBoundingBox([0, 0, 0], [5, 5, 5]);
    expect(box.size[0]).toBe(5);
    expect(box.size[1]).toBe(5);
    expect(box.size[2]).toBe(5);
  });
//
  it('Spatial Edge Case Suite 1B: verifies non-overlapping collinear elements', () => {
    const box1 = createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2]);
    const box2 = createAxisAlignedBoundingBox([10, 0, 0], [12, 2, 2]);
    const res = detectClashes([
      { id: '1', name: 'A', discipline: 'structural', boundingBox: box1 },
      { id: '2', name: 'B', discipline: 'structural', boundingBox: box2 }
    ]);
    expect(res.summary.total).toBe(0);
  });
//
  it('Spatial Edge Case Suite 1C: verifies multiple hard collisions in a cluster', () => {
    const box1 = createAxisAlignedBoundingBox([0, 0, 0], [4, 4, 4]);
    const box2 = createAxisAlignedBoundingBox([1, 1, 1], [3, 3, 3]);
    const box3 = createAxisAlignedBoundingBox([2, 2, 2], [5, 5, 5]);
    const res = detectClashes([
      { id: '1', name: 'A', discipline: 'structural', boundingBox: box1 },
      { id: '2', name: 'B', discipline: 'mechanical', boundingBox: box2 },
      { id: '3', name: 'C', discipline: 'plumbing', boundingBox: box3 }
    ]);
    expect(res.summary.hard).toBe(3);
  });
//
  it('Spatial Edge Case Suite 1D: verifies high tolerance capturing multiple proximity pairs', () => {
    const box1 = createAxisAlignedBoundingBox([0, 0, 0], [2, 2, 2]);
    const box2 = createAxisAlignedBoundingBox([2.5, 0, 0], [4.5, 2, 2]);
    const res = detectClashes([
      { id: '1', name: 'A', discipline: 'electrical', boundingBox: box1 },
      { id: '2', name: 'B', discipline: 'mechanical', boundingBox: box2 }
    ], { tolerance: 1.0 });
    expect(res.summary.clearance).toBe(1);
  });
//
  it('Spatial Edge Case Suite 1E: verifies zero elements input stability', () => {
    const res = detectClashes([], { tolerance: 2.0 });
    expect(res.summary.total).toBe(0);
  });
});
//
