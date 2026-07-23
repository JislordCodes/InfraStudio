import { fetch as uFetch, Agent, setGlobalDispatcher } from "undici";
import * as fs from "fs";

const localAgent = new Agent({ headersTimeout: 900000, bodyTimeout: 900000, connectTimeout: 60000 });
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";
const ARTIFACTS = "C:\\Users\\david\\.gemini\\antigravity\\brain\\c2579048-00a5-46d3-9c07-409e7d26348d";

async function callTool(name, args, sid) {
  const res = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "call_tool", name, args, session_id: sid })
  });
  if (!res.ok) throw new Error(`Tool ${name} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function parseResult(res) {
  try { return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; }
  catch { return res.result; }
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  SPATIAL REASONING AUDIT v2 — BLENDER-DIRECT BBOX QUERIES   ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  // Init & build the villa (same as before)
  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  console.log("══ PHASE 1: Build multi-room villa ══\n");
  await callTool("initialize_project", { project_name: "Spatial Audit v2" }, sid);

  await callTool("build_room", {
    room_name: "LivingRoom", width: 6, length: 5, height: 3,
    wall_thickness: 0.25, origin: [0, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.5, width: 1.0, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.5, width: 1.8, height: 1.4, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ LivingRoom (0,0) 6x5m");

  await callTool("build_room", {
    room_name: "Kitchen", width: 4, length: 5, height: 3,
    wall_thickness: 0.25, origin: [6, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "west", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.0, width: 1.2, height: 1.2, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ Kitchen (6,0) 4x5m — adjacent east of LivingRoom");

  await callTool("build_room", {
    room_name: "Bedroom", width: 5, length: 4, height: 3,
    wall_thickness: 0.25, origin: [0, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "north", offset: 1.5, width: 1.5, height: 1.4, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ Bedroom (0,5) 5x4m — adjacent north of LivingRoom");

  await callTool("build_room", {
    room_name: "Bathroom", width: 3, length: 4, height: 3,
    wall_thickness: 0.25, origin: [5, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 1.0, width: 0.8, height: 2.1 }],
    windows: [{ wall: "north", offset: 0.8, width: 0.8, height: 0.6, sill_height: 1.5 }]
  }, sid);
  console.log("  ✓ Bathroom (5,5) 3x4m — adjacent north of Kitchen");

  await callTool("create_roof", {
    polyline: [[-0.5, -0.5, 3], [10.5, -0.5, 3], [10.5, 9.5, 3], [-0.5, 9.5, 3]],
    roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.3
  }, sid);
  console.log("  ✓ Gable Roof 35°\n");

  // ══ PHASE 2: Use execute_blender_code to get ALL bounding boxes directly ══
  console.log("══ PHASE 2: Query Blender for all object bounding boxes ══\n");

  const bboxScript = `
import bpy
import json
import mathutils

results = []
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    
    # Get world-space bounding box
    bbox_corners = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
    
    xs = [c.x for c in bbox_corners]
    ys = [c.y for c in bbox_corners]
    zs = [c.z for c in bbox_corners]
    
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    
    # Get IFC class from custom properties
    ifc_class = ""
    for key in obj.keys():
        if "ifc" in key.lower() or "class" in key.lower():
            ifc_class = str(obj[key])
            break
    
    # Try to get IFC class from name
    name = obj.name
    if "Wall" in name: ifc_type = "IfcWall"
    elif "Slab" in name or "Floor" in name or "Ceiling" in name: ifc_type = "IfcSlab"
    elif "Door" in name: ifc_type = "IfcDoor"
    elif "Window" in name: ifc_type = "IfcWindow"
    elif "Roof" in name: ifc_type = "IfcRoof"
    elif "Stair" in name: ifc_type = "IfcStair"
    elif "Veranda" in name or "Railing" in name: ifc_type = "IfcWall"
    elif "Table" in name or "Chair" in name or "Furniture" in name: ifc_type = "IfcFurnishingElement"
    else: ifc_type = ifc_class or "Unknown"
    
    results.append({
        "name": name,
        "ifc_type": ifc_type,
        "location": [round(obj.location.x, 3), round(obj.location.y, 3), round(obj.location.z, 3)],
        "dimensions": [round(obj.dimensions.x, 3), round(obj.dimensions.y, 3), round(obj.dimensions.z, 3)],
        "bbox_min": [round(min_x, 3), round(min_y, 3), round(min_z, 3)],
        "bbox_max": [round(max_x, 3), round(max_y, 3), round(max_z, 3)],
        "width": round(max_x - min_x, 3),
        "depth": round(max_y - min_y, 3),
        "height": round(max_z - min_z, 3),
    })

# Sort by type then name
results.sort(key=lambda r: (r["ifc_type"], r["name"]))
print(json.dumps(results, indent=2))
`;

  const bboxRes = await callTool("execute_blender_code", { code: bboxScript }, sid);
  const bboxData = parseResult(bboxRes);
  
  let objects = [];
  try {
    // The result might be a string with the JSON output
    if (typeof bboxData === 'string') {
      // Find the JSON array in the output
      const jsonMatch = bboxData.match(/\[[\s\S]*\]/);
      if (jsonMatch) objects = JSON.parse(jsonMatch[0]);
    } else if (Array.isArray(bboxData)) {
      objects = bboxData;
    } else if (bboxData && bboxData.output) {
      const jsonMatch = bboxData.output.match(/\[[\s\S]*\]/);
      if (jsonMatch) objects = JSON.parse(jsonMatch[0]);
    }
  } catch(e) {
    console.log("  ⚠️ Could not parse bbox data:", e.message);
    console.log("  Raw result:", JSON.stringify(bboxData).substring(0, 500));
  }

  console.log(`  Found ${objects.length} mesh objects with bounding boxes\n`);

  // Print all objects with positions
  console.log("  ┌─────────────────────────────────────┬────────────────┬──────────────────────────────┬──────────────────────────────┬─────────────────────┐");
  console.log("  │ Object Name                         │ IFC Type       │ BBox Min [x, y, z]           │ BBox Max [x, y, z]           │ Dimensions WxDxH    │");
  console.log("  ├─────────────────────────────────────┼────────────────┼──────────────────────────────┼──────────────────────────────┼─────────────────────┤");
  for (const obj of objects) {
    const name = (obj.name || '?').padEnd(35).substring(0, 35);
    const type = (obj.ifc_type || '?').padEnd(14).substring(0, 14);
    const bmin = `[${obj.bbox_min.map(v => v.toFixed(2)).join(', ')}]`.padEnd(28);
    const bmax = `[${obj.bbox_max.map(v => v.toFixed(2)).join(', ')}]`.padEnd(28);
    const dims = `${obj.width.toFixed(2)}x${obj.depth.toFixed(2)}x${obj.height.toFixed(2)}`.padEnd(19);
    console.log(`  │ ${name} │ ${type} │ ${bmin} │ ${bmax} │ ${dims} │`);
  }
  console.log("  └─────────────────────────────────────┴────────────────┴──────────────────────────────┴──────────────────────────────┴─────────────────────┘\n");

  // ══ PHASE 3: SPATIAL VALIDATION CHECKS ══
  console.log("══ PHASE 3: Spatial Reasoning Validation Checks ══\n");

  let totalIssues = 0;
  let totalPasses = 0;
  const reportLines = [];

  // --- CHECK 1: Wall Corner Connections ---
  {
    console.log("  ─── CHECK 1: Wall Corner Connections ───");
    const walls = objects.filter(o => o.ifc_type === 'IfcWall');
    const issues = [];
    const TOLERANCE = 0.35;

    // For each room, check that the 4 walls form a closed rectangle
    const rooms = ["LivingRoom", "Kitchen", "Bedroom", "Bathroom"];
    for (const room of rooms) {
      const roomWalls = walls.filter(w => w.name.startsWith(room));
      if (roomWalls.length < 4) {
        issues.push(`⚠️ ${room} has only ${roomWalls.length} walls (expected 4)`);
        continue;
      }

      // Check each pair of walls shares a corner
      let connectedPairs = 0;
      for (let i = 0; i < roomWalls.length; i++) {
        for (let j = i + 1; j < roomWalls.length; j++) {
          const a = roomWalls[i], b = roomWalls[j];
          // Check if bboxes touch (share an edge/corner)
          const xTouch = Math.abs(a.bbox_max[0] - b.bbox_min[0]) < TOLERANCE ||
                         Math.abs(b.bbox_max[0] - a.bbox_min[0]) < TOLERANCE ||
                         (a.bbox_min[0] < b.bbox_max[0] + TOLERANCE && a.bbox_max[0] > b.bbox_min[0] - TOLERANCE);
          const yTouch = Math.abs(a.bbox_max[1] - b.bbox_min[1]) < TOLERANCE ||
                         Math.abs(b.bbox_max[1] - a.bbox_min[1]) < TOLERANCE ||
                         (a.bbox_min[1] < b.bbox_max[1] + TOLERANCE && a.bbox_max[1] > b.bbox_min[1] - TOLERANCE);
          
          if (xTouch && yTouch) connectedPairs++;
        }
      }
      
      if (connectedPairs < 4) {
        issues.push(`⚠️ ${room} walls have ${connectedPairs} connected pairs (need ≥4 for closed rectangle)`);
      } else {
        console.log(`    ✅ ${room}: ${roomWalls.length} walls, ${connectedPairs} corner connections — CLOSED`);
      }
    }
    
    if (issues.length === 0) { totalPasses++; console.log("    ✅ ALL ROOM WALLS FORM CLOSED RECTANGLES"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 1: Wall Corners — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 2: Doors Inside Walls ---
  {
    console.log("  ─── CHECK 2: Doors Placed Inside Host Walls ───");
    const doors = objects.filter(o => o.ifc_type === 'IfcDoor');
    const walls = objects.filter(o => o.ifc_type === 'IfcWall');
    const issues = [];

    for (const door of doors) {
      // Door base should be at z ≈ 0
      if (door.bbox_min[2] > 0.15) {
        issues.push(`⚠️ ${door.name} base at z=${door.bbox_min[2].toFixed(2)}m — FLOATING`);
      } else {
        console.log(`    ✅ ${door.name}: base at z=${door.bbox_min[2].toFixed(2)}m, height=${door.height.toFixed(2)}m — GROUNDED`);
      }

      // Check door is within a wall's XY extent
      let insideWall = false;
      for (const wall of walls) {
        const xIn = door.bbox_min[0] >= wall.bbox_min[0] - 0.3 && door.bbox_max[0] <= wall.bbox_max[0] + 0.3;
        const yIn = door.bbox_min[1] >= wall.bbox_min[1] - 0.3 && door.bbox_max[1] <= wall.bbox_max[1] + 0.3;
        if (xIn && yIn) { insideWall = true; break; }
      }
      if (!insideWall) {
        issues.push(`⚠️ ${door.name} not inside any wall XY extent`);
      }
    }

    if (issues.length === 0) { totalPasses++; console.log("    ✅ ALL DOORS CORRECTLY PLACED IN WALLS"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 2: Doors — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 3: Window Sill Heights ---
  {
    console.log("  ─── CHECK 3: Window Sill Heights & Wall Placement ───");
    const windows = objects.filter(o => o.ifc_type === 'IfcWindow');
    const issues = [];

    for (const win of windows) {
      const sill = win.bbox_min[2];
      const top = win.bbox_max[2];
      const ok = sill >= 0.3 && sill <= 2.0 && top <= 3.2;
      if (ok) {
        console.log(`    ✅ ${win.name}: sill=${sill.toFixed(2)}m, top=${top.toFixed(2)}m, size=${win.width.toFixed(2)}x${win.height.toFixed(2)}m — OK`);
      } else {
        if (sill < 0.3) issues.push(`⚠️ ${win.name} sill too low: z=${sill.toFixed(2)}m`);
        if (sill > 2.0) issues.push(`⚠️ ${win.name} sill too high: z=${sill.toFixed(2)}m`);
        if (top > 3.2) issues.push(`⚠️ ${win.name} top above ceiling: z=${top.toFixed(2)}m`);
      }
    }

    if (issues.length === 0) { totalPasses++; console.log("    ✅ ALL WINDOWS AT CORRECT SILL HEIGHTS"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 3: Windows — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 4: Roof Covers Footprint ---
  {
    console.log("  ─── CHECK 4: Roof Covers Full Building Footprint ───");
    const roofs = objects.filter(o => o.ifc_type === 'IfcRoof');
    const walls = objects.filter(o => o.ifc_type === 'IfcWall' && !o.name.includes('Veranda'));
    const issues = [];

    if (roofs.length === 0) { issues.push("❌ NO ROOF!"); }
    else {
      // Building footprint from walls
      let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
      for (const w of walls) {
        fMinX = Math.min(fMinX, w.bbox_min[0]); fMinY = Math.min(fMinY, w.bbox_min[1]);
        fMaxX = Math.max(fMaxX, w.bbox_max[0]); fMaxY = Math.max(fMaxY, w.bbox_max[1]);
      }

      // Roof extent
      let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity, rMinZ = Infinity;
      for (const r of roofs) {
        rMinX = Math.min(rMinX, r.bbox_min[0]); rMinY = Math.min(rMinY, r.bbox_min[1]);
        rMaxX = Math.max(rMaxX, r.bbox_max[0]); rMaxY = Math.max(rMaxY, r.bbox_max[1]);
        rMinZ = Math.min(rMinZ, r.bbox_min[2]);
      }

      console.log(`    Building footprint: X=[${fMinX.toFixed(1)}, ${fMaxX.toFixed(1)}], Y=[${fMinY.toFixed(1)}, ${fMaxY.toFixed(1)}]`);
      console.log(`    Roof extent:        X=[${rMinX.toFixed(1)}, ${rMaxX.toFixed(1)}], Y=[${rMinY.toFixed(1)}, ${rMaxY.toFixed(1)}], Z_base=${rMinZ.toFixed(1)}m`);

      if (rMinX > fMinX + 0.5) issues.push(`⚠️ Roof X_min=${rMinX.toFixed(1)} doesn't cover west wall X_min=${fMinX.toFixed(1)}`);
      if (rMaxX < fMaxX - 0.5) issues.push(`⚠️ Roof X_max=${rMaxX.toFixed(1)} doesn't cover east wall X_max=${fMaxX.toFixed(1)}`);
      if (rMinY > fMinY + 0.5) issues.push(`⚠️ Roof Y_min=${rMinY.toFixed(1)} doesn't cover south wall Y_min=${fMinY.toFixed(1)}`);
      if (rMaxY < fMaxY - 0.5) issues.push(`⚠️ Roof Y_max=${rMaxY.toFixed(1)} doesn't cover north wall Y_max=${fMaxY.toFixed(1)}`);
      if (rMinZ < 2.5) issues.push(`⚠️ Roof base at z=${rMinZ.toFixed(1)}m (should be ≈3m at wall top)`);

      if (issues.length === 0) console.log("    ✅ ROOF FULLY COVERS BUILDING FOOTPRINT WITH OVERHANG");
    }

    if (issues.length === 0) totalPasses++; else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 4: Roof — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 5: Floor & Ceiling Slabs ---
  {
    console.log("  ─── CHECK 5: Floor & Ceiling Slabs Present ───");
    const slabs = objects.filter(o => o.ifc_type === 'IfcSlab');
    const issues = [];

    const floorSlabs = slabs.filter(s => s.bbox_min[2] < 0.5);
    const ceilingSlabs = slabs.filter(s => s.bbox_min[2] > 2.0);

    console.log(`    Total slabs: ${slabs.length}`);
    console.log(`    Floor slabs (z<0.5m): ${floorSlabs.length}`);
    console.log(`    Ceiling slabs (z>2.0m): ${ceilingSlabs.length}`);

    for (const s of slabs) {
      console.log(`      ${s.name}: z=[${s.bbox_min[2].toFixed(2)}, ${s.bbox_max[2].toFixed(2)}], size=${s.width.toFixed(1)}x${s.depth.toFixed(1)}m`);
    }

    if (floorSlabs.length === 0) issues.push("⚠️ No floor slab at ground level");
    if (ceilingSlabs.length === 0) issues.push("⚠️ No ceiling slab (rooms open to sky)");

    if (issues.length === 0) { totalPasses++; console.log("    ✅ FLOOR AND CEILING SLABS PRESENT"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 5: Slabs — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 6: Room Adjacency (shared walls / no gaps) ---
  {
    console.log("  ─── CHECK 6: Room Adjacency — No Gaps Between Rooms ───");
    const issues = [];

    // LivingRoom east wall should touch Kitchen west wall at x ≈ 6
    const lrEast = objects.find(o => o.name === 'LivingRoom_Wall_East');
    const kWest = objects.find(o => o.name === 'Kitchen_Wall_West');
    if (lrEast && kWest) {
      const gap = Math.abs(lrEast.bbox_max[0] - kWest.bbox_min[0]);
      if (gap < 0.5) {
        console.log(`    ✅ LivingRoom↔Kitchen: wall gap=${gap.toFixed(3)}m at x≈6 — CONNECTED`);
      } else {
        issues.push(`⚠️ LivingRoom↔Kitchen gap=${gap.toFixed(2)}m (walls don't meet at x≈6)`);
      }
    } else {
      console.log(`    ~ LivingRoom_Wall_East or Kitchen_Wall_West not found by exact name`);
    }

    // LivingRoom north wall should touch Bedroom south wall at y ≈ 5
    const lrNorth = objects.find(o => o.name === 'LivingRoom_Wall_North');
    const brSouth = objects.find(o => o.name === 'Bedroom_Wall_South');
    if (lrNorth && brSouth) {
      const gap = Math.abs(lrNorth.bbox_max[1] - brSouth.bbox_min[1]);
      if (gap < 0.5) {
        console.log(`    ✅ LivingRoom↔Bedroom: wall gap=${gap.toFixed(3)}m at y≈5 — CONNECTED`);
      } else {
        issues.push(`⚠️ LivingRoom↔Bedroom gap=${gap.toFixed(2)}m (walls don't meet at y≈5)`);
      }
    }

    // Kitchen north wall should touch Bathroom south wall at y ≈ 5
    const kNorth = objects.find(o => o.name === 'Kitchen_Wall_North');
    const bathSouth = objects.find(o => o.name === 'Bathroom_Wall_South');
    if (kNorth && bathSouth) {
      const gap = Math.abs(kNorth.bbox_max[1] - bathSouth.bbox_min[1]);
      if (gap < 0.5) {
        console.log(`    ✅ Kitchen↔Bathroom: wall gap=${gap.toFixed(3)}m at y≈5 — CONNECTED`);
      } else {
        issues.push(`⚠️ Kitchen↔Bathroom gap=${gap.toFixed(2)}m`);
      }
    }

    // Bedroom east wall should touch Bathroom west wall at x ≈ 5
    const brEast = objects.find(o => o.name === 'Bedroom_Wall_East');
    const bathWest = objects.find(o => o.name === 'Bathroom_Wall_West');
    if (brEast && bathWest) {
      const gap = Math.abs(brEast.bbox_max[0] - bathWest.bbox_min[0]);
      if (gap < 0.5) {
        console.log(`    ✅ Bedroom↔Bathroom: wall gap=${gap.toFixed(3)}m at x≈5 — CONNECTED`);
      } else {
        issues.push(`⚠️ Bedroom↔Bathroom gap=${gap.toFixed(2)}m`);
      }
    }

    if (issues.length === 0) { totalPasses++; console.log("    ✅ ALL ROOMS PROPERLY ADJACENT — NO GAPS"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 6: Adjacency — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 7: No Overlapping Walls (double walls at shared boundary) ---
  {
    console.log("  ─── CHECK 7: No Overlapping/Double Walls ───");
    const walls = objects.filter(o => o.ifc_type === 'IfcWall');
    const issues = [];
    const OVERLAP_THRESHOLD = 0.1;

    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const a = walls[i], b = walls[j];
        // Check if two walls occupy nearly the same space (double wall)
        const xOverlap = Math.max(0, Math.min(a.bbox_max[0], b.bbox_max[0]) - Math.max(a.bbox_min[0], b.bbox_min[0]));
        const yOverlap = Math.max(0, Math.min(a.bbox_max[1], b.bbox_max[1]) - Math.max(a.bbox_min[1], b.bbox_min[1]));
        const zOverlap = Math.max(0, Math.min(a.bbox_max[2], b.bbox_max[2]) - Math.max(a.bbox_min[2], b.bbox_min[2]));

        const overlapVolume = xOverlap * yOverlap * zOverlap;
        const aVolume = a.width * a.depth * a.height;
        const bVolume = b.width * b.depth * b.height;
        const minVolume = Math.min(aVolume, bVolume);

        if (minVolume > 0 && overlapVolume / minVolume > 0.5) {
          issues.push(`⚠️ DOUBLE WALL: "${a.name}" and "${b.name}" overlap ${(overlapVolume / minVolume * 100).toFixed(0)}%`);
        }
      }
    }

    if (issues.length === 0) { totalPasses++; console.log("    ✅ NO OVERLAPPING/DOUBLE WALLS DETECTED"); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 7: Overlaps — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // --- CHECK 8: Wall Heights Consistent ---
  {
    console.log("  ─── CHECK 8: Wall Heights Consistent (all ≈3m) ───");
    const walls = objects.filter(o => o.ifc_type === 'IfcWall' && !o.name.includes('Veranda'));
    const issues = [];

    for (const wall of walls) {
      if (Math.abs(wall.height - 3.0) > 0.3) {
        issues.push(`⚠️ ${wall.name} height=${wall.height.toFixed(2)}m (expected ≈3.0m)`);
      }
    }

    if (issues.length === 0) { totalPasses++; console.log(`    ✅ ALL ${walls.length} WALLS AT CONSISTENT 3m HEIGHT`); }
    else { totalIssues += issues.length; issues.forEach(i => console.log(`    ${i}`)); }
    reportLines.push(`### Check 8: Wall Heights — ${issues.length === 0 ? 'PASS' : issues.length + ' issues'}`);
    reportLines.push(...issues.map(i => `- ${i}`));
    console.log("");
  }

  // ══ FINAL VERDICT ══
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  SPATIAL CHECKS: ${totalPasses} PASSED, ${totalIssues} ISSUES`);
  console.log(`  VERDICT: ${totalIssues === 0 ? '✅ ALL SPATIAL REASONING CHECKS PASSED' : `⚠️ ${totalIssues} spatial issues need fixing`}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Write report
  const report = [
    `# Spatial Reasoning Audit Report v2`,
    ``,
    `## Summary`,
    `- **Objects**: ${objects.length} mesh objects with bounding boxes`,
    `- **Checks Passed**: ${totalPasses}/8`,
    `- **Issues Found**: ${totalIssues}`,
    `- **Verdict**: ${totalIssues === 0 ? 'ALL CHECKS PASSED' : `${totalIssues} issues`}`,
    ``,
    `## Detailed Results`,
    ...reportLines,
  ].join('\n');

  fs.writeFileSync(`${ARTIFACTS}\\spatial_audit_report_v2.md`, report);
  console.log(`Report saved: ${ARTIFACTS}\\spatial_audit_report_v2.md`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
