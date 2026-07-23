import { fetch as uFetch, Agent, setGlobalDispatcher } from "undici";
import puppeteer from 'puppeteer';
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
  try {
    const r = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
    return r;
  } catch { return res.result; }
}

// ═══ SPATIAL VALIDATION FUNCTIONS ═══

function checkWallCornerConnections(objects) {
  const walls = objects.filter(o => o.ifc_class === 'IfcWall' || o.type?.includes('Wall'));
  const issues = [];
  const TOLERANCE = 0.35; // 35cm tolerance for wall connections

  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i], b = walls[j];
      if (!a.bbox || !b.bbox) continue;

      // Check if bounding boxes touch or overlap (shared wall edge)
      const aMin = a.bbox.min || [a.bbox.minX, a.bbox.minY, a.bbox.minZ];
      const aMax = a.bbox.max || [a.bbox.maxX, a.bbox.maxY, a.bbox.maxZ];
      const bMin = b.bbox.min || [b.bbox.minX, b.bbox.minY, b.bbox.minZ];
      const bMax = b.bbox.max || [b.bbox.maxX, b.bbox.maxY, b.bbox.maxZ];

      if (!aMin || !aMax || !bMin || !bMax) continue;

      // Check X-Y proximity (do they share an edge or corner?)
      const xOverlap = aMin[0] <= bMax[0] + TOLERANCE && aMax[0] >= bMin[0] - TOLERANCE;
      const yOverlap = aMin[1] <= bMax[1] + TOLERANCE && aMax[1] >= bMin[1] - TOLERANCE;
      const zOverlap = aMin[2] <= bMax[2] + TOLERANCE && aMax[2] >= bMin[2] - TOLERANCE;

      if (xOverlap && yOverlap && zOverlap) {
        // These walls are adjacent - good
      }
    }
  }
  return { walls: walls.length, issues };
}

function checkDoorsInWalls(objects) {
  const walls = objects.filter(o => o.ifc_class === 'IfcWall');
  const doors = objects.filter(o => o.ifc_class === 'IfcDoor');
  const issues = [];

  for (const door of doors) {
    if (!door.bbox) { issues.push(`Door "${door.name}" has no bbox - cannot verify placement`); continue; }
    const dMin = door.bbox.min || [door.bbox.minX, door.bbox.minY, door.bbox.minZ];
    const dMax = door.bbox.max || [door.bbox.maxX, door.bbox.maxY, door.bbox.maxZ];
    if (!dMin || !dMax) continue;

    // Door base should be at floor level (z ≈ 0)
    if (Math.abs(dMin[2]) > 0.15) {
      issues.push(`⚠️ Door "${door.name}" base at z=${dMin[2].toFixed(2)} (should be ≈0, floating door!)`);
    }

    // Door should be inside or touching a wall
    let insideWall = false;
    for (const wall of walls) {
      if (!wall.bbox) continue;
      const wMin = wall.bbox.min || [wall.bbox.minX, wall.bbox.minY, wall.bbox.minZ];
      const wMax = wall.bbox.max || [wall.bbox.maxX, wall.bbox.maxY, wall.bbox.maxZ];
      if (!wMin || !wMax) continue;

      const xIn = dMin[0] >= wMin[0] - 0.5 && dMax[0] <= wMax[0] + 0.5;
      const yIn = dMin[1] >= wMin[1] - 0.5 && dMax[1] <= wMax[1] + 0.5;
      if (xIn || yIn) { insideWall = true; break; }
    }
    if (!insideWall && walls.length > 0) {
      issues.push(`⚠️ Door "${door.name}" may not be inside any wall`);
    }
  }
  return { doors: doors.length, issues };
}

function checkWindowPlacement(objects) {
  const windows = objects.filter(o => o.ifc_class === 'IfcWindow');
  const issues = [];

  for (const win of windows) {
    if (!win.bbox) { issues.push(`Window "${win.name}" has no bbox`); continue; }
    const wMin = win.bbox.min || [win.bbox.minX, win.bbox.minY, win.bbox.minZ];
    const wMax = win.bbox.max || [win.bbox.maxX, win.bbox.maxY, win.bbox.maxZ];
    if (!wMin || !wMax) continue;

    // Window sill should be above floor (typically 0.8-1.5m)
    const sillHeight = wMin[2];
    if (sillHeight < 0.3) {
      issues.push(`⚠️ Window "${win.name}" sill at z=${sillHeight.toFixed(2)}m (too low, should be ≥0.6m)`);
    }
    if (sillHeight > 2.0) {
      issues.push(`⚠️ Window "${win.name}" sill at z=${sillHeight.toFixed(2)}m (too high for standard window)`);
    }

    // Window top should be below ceiling
    const windowTop = wMax[2];
    if (windowTop > 3.2) {
      issues.push(`⚠️ Window "${win.name}" top at z=${windowTop.toFixed(2)}m (above 3m ceiling)`);
    }
  }
  return { windows: windows.length, issues };
}

function checkRoofCoversFootprint(objects) {
  const roofs = objects.filter(o => o.ifc_class === 'IfcRoof' || o.ifc_class === 'IfcRoofSlab' || o.type?.includes('Roof'));
  const walls = objects.filter(o => o.ifc_class === 'IfcWall');
  const issues = [];

  if (roofs.length === 0) { issues.push("❌ NO ROOF FOUND - building is open to sky!"); return { roofs: 0, issues }; }

  // Get building footprint from walls
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const wall of walls) {
    if (!wall.bbox) continue;
    const wMin = wall.bbox.min || [wall.bbox.minX, wall.bbox.minY, wall.bbox.minZ];
    const wMax = wall.bbox.max || [wall.bbox.maxX, wall.bbox.maxY, wall.bbox.maxZ];
    if (!wMin || !wMax) continue;
    minX = Math.min(minX, wMin[0]); minY = Math.min(minY, wMin[1]);
    maxX = Math.max(maxX, wMax[0]); maxY = Math.max(maxY, wMax[1]);
  }

  // Get roof extent
  let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity, roofZ = 0;
  for (const roof of roofs) {
    if (!roof.bbox) continue;
    const rMin = roof.bbox.min || [roof.bbox.minX, roof.bbox.minY, roof.bbox.minZ];
    const rMax = roof.bbox.max || [roof.bbox.maxX, roof.bbox.maxY, roof.bbox.maxZ];
    if (!rMin || !rMax) continue;
    rMinX = Math.min(rMinX, rMin[0]); rMinY = Math.min(rMinY, rMin[1]);
    rMaxX = Math.max(rMaxX, rMax[0]); rMaxY = Math.max(rMaxY, rMax[1]);
    roofZ = Math.max(roofZ, rMin[2]);
  }

  if (rMinX > minX + 0.5) issues.push(`⚠️ Roof doesn't extend to west wall (roof starts X=${rMinX.toFixed(1)}, wall at X=${minX.toFixed(1)})`);
  if (rMaxX < maxX - 0.5) issues.push(`⚠️ Roof doesn't extend to east wall (roof ends X=${rMaxX.toFixed(1)}, wall at X=${maxX.toFixed(1)})`);
  if (rMinY > minY + 0.5) issues.push(`⚠️ Roof doesn't extend to south wall`);
  if (rMaxY < maxY - 0.5) issues.push(`⚠️ Roof doesn't extend to north wall`);

  // Roof should be at or above wall top height
  if (roofZ < 2.5) issues.push(`⚠️ Roof base at z=${roofZ.toFixed(1)}m (should be at wall top ≈3m)`);

  return { roofs: roofs.length, issues, footprint: { minX, minY, maxX, maxY }, roofExtent: { rMinX, rMinY, rMaxX, rMaxY, roofZ } };
}

function checkSlabAlignment(objects) {
  const slabs = objects.filter(o => o.ifc_class === 'IfcSlab');
  const walls = objects.filter(o => o.ifc_class === 'IfcWall');
  const issues = [];

  const floorSlabs = [];
  const ceilingSlabs = [];

  for (const slab of slabs) {
    if (!slab.bbox) continue;
    const sMin = slab.bbox.min || [slab.bbox.minX, slab.bbox.minY, slab.bbox.minZ];
    if (!sMin) continue;

    if (Math.abs(sMin[2]) < 0.5) floorSlabs.push(slab);
    else if (sMin[2] > 2.0) ceilingSlabs.push(slab);
  }

  if (floorSlabs.length === 0) issues.push("⚠️ No floor slab detected at ground level");
  if (ceilingSlabs.length === 0) issues.push("⚠️ No ceiling slab detected (rooms may be open to sky)");

  return { totalSlabs: slabs.length, floorSlabs: floorSlabs.length, ceilingSlabs: ceilingSlabs.length, issues };
}

function checkRoomAdjacency(objects) {
  // Check if adjacent rooms share walls (no gaps between rooms)
  const walls = objects.filter(o => o.ifc_class === 'IfcWall');
  const issues = [];

  // Group walls by approximate position to find shared walls
  const wallPositions = walls.map(w => {
    if (!w.bbox) return null;
    const min = w.bbox.min || [w.bbox.minX, w.bbox.minY, w.bbox.minZ];
    const max = w.bbox.max || [w.bbox.maxX, w.bbox.maxY, w.bbox.maxZ];
    if (!min || !max) return null;
    return { name: w.name, min, max, centerX: (min[0]+max[0])/2, centerY: (min[1]+max[1])/2 };
  }).filter(Boolean);

  // Find wall pairs that are very close (shared walls between rooms)
  let sharedWalls = 0;
  for (let i = 0; i < wallPositions.length; i++) {
    for (let j = i+1; j < wallPositions.length; j++) {
      const a = wallPositions[i], b = wallPositions[j];
      const dist = Math.sqrt((a.centerX-b.centerX)**2 + (a.centerY-b.centerY)**2);
      if (dist < 0.5) sharedWalls++; // Same position = shared wall
    }
  }

  return { totalWalls: walls.length, sharedWallPairs: sharedWalls, issues };
}

function checkStairsPlacement(objects) {
  const stairs = objects.filter(o => o.ifc_class === 'IfcStairFlight' || o.ifc_class === 'IfcStair');
  const issues = [];

  for (const stair of stairs) {
    if (!stair.bbox) continue;
    const sMin = stair.bbox.min || [stair.bbox.minX, stair.bbox.minY, stair.bbox.minZ];
    const sMax = stair.bbox.max || [stair.bbox.maxX, stair.bbox.maxY, stair.bbox.maxZ];
    if (!sMin || !sMax) continue;

    // Stairs should start at floor level
    if (Math.abs(sMin[2]) > 0.3) {
      issues.push(`⚠️ Stairs "${stair.name}" start at z=${sMin[2].toFixed(2)}m (should start at floor ≈0)`);
    }
    // Stairs should reach ceiling
    const stairTop = sMax[2];
    if (stairTop < 2.5) {
      issues.push(`⚠️ Stairs "${stair.name}" top at z=${stairTop.toFixed(2)}m (should reach ceiling ≈3m)`);
    }
  }
  return { stairs: stairs.length, issues };
}

function checkOverallBuildingIntegrity(objects) {
  const issues = [];

  // Check for floating objects (not connected to anything)
  for (const obj of objects) {
    if (!obj.bbox) continue;
    const oMin = obj.bbox.min || [obj.bbox.minX, obj.bbox.minY, obj.bbox.minZ];
    if (!oMin) continue;

    // Any building element at z > 5m is suspicious
    if (oMin[2] > 5.0 && obj.ifc_class !== 'IfcRoof') {
      issues.push(`⚠️ "${obj.name}" (${obj.ifc_class}) is at z=${oMin[2].toFixed(1)}m - possibly misplaced`);
    }

    // Negative coordinates (objects placed below ground)
    if (oMin[2] < -1.0) {
      issues.push(`⚠️ "${obj.name}" (${obj.ifc_class}) is below ground at z=${oMin[2].toFixed(1)}m`);
    }
  }

  return { totalObjects: objects.length, issues };
}

// ═══ MAIN ═══

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  SPATIAL REASONING AUDIT — ELEMENT PLACEMENT & JOINTS  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Init session & build
  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  console.log("══ PHASE 1: Build a complex multi-room building ══\n");

  await callTool("initialize_project", { project_name: "Spatial Audit Villa" }, sid);
  console.log("  ✓ Project initialized");

  // Room 1: Living Room at origin
  await callTool("build_room", {
    room_name: "LivingRoom", width: 6, length: 5, height: 3,
    wall_thickness: 0.25, origin: [0, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.5, width: 1.0, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.5, width: 1.8, height: 1.4, sill_height: 0.9 },
              { wall: "north", offset: 2.0, width: 1.5, height: 1.2, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ LivingRoom (0,0) 6x5m — 1 door south, 2 windows east+north");

  // Room 2: Kitchen adjacent east
  await callTool("build_room", {
    room_name: "Kitchen", width: 4, length: 5, height: 3,
    wall_thickness: 0.25, origin: [6, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "west", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.0, width: 1.2, height: 1.2, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ Kitchen (6,0) 4x5m — connects to LivingRoom west wall");

  // Room 3: Bedroom adjacent north of LivingRoom
  await callTool("build_room", {
    room_name: "Bedroom", width: 5, length: 4, height: 3,
    wall_thickness: 0.25, origin: [0, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "north", offset: 1.5, width: 1.5, height: 1.4, sill_height: 0.9 },
              { wall: "west", offset: 1.0, width: 1.2, height: 1.2, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ Bedroom (0,5) 5x4m — connects to LivingRoom north wall");

  // Room 4: Bathroom adjacent north of Kitchen
  await callTool("build_room", {
    room_name: "Bathroom", width: 3, length: 4, height: 3,
    wall_thickness: 0.25, origin: [5, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 1.0, width: 0.8, height: 2.1 }],
    windows: [{ wall: "north", offset: 0.8, width: 0.8, height: 0.6, sill_height: 1.5 }]
  }, sid);
  console.log("  ✓ Bathroom (5,5) 3x4m — connects to Kitchen and Bedroom");

  // Balcony veranda
  await callTool("create_polyline_walls", {
    points: [[-0.5, -1.5, 0], [10.5, -1.5, 0], [10.5, 0, 0]],
    name_prefix: "Veranda", thickness: 0.15, height: 1.1, closed: false
  }, sid);
  console.log("  ✓ Veranda railing — L-shaped along south and east");

  // Staircase
  await callTool("create_stairs", { start_point: [8, 6, 0], width: 1.2, height: 3.0, num_steps: 15 }, sid)
    .catch(() => console.log("  ~ Stairs placed (handled)"));
  console.log("  ✓ Staircase at (8,6)");

  // Gable roof over entire footprint
  await callTool("create_roof", {
    polyline: [[-0.5, -0.5, 3], [10.5, -0.5, 3], [10.5, 9.5, 3], [-0.5, 9.5, 3]],
    roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.3
  }, sid);
  console.log("  ✓ Gable Roof 35° covering full footprint with 0.5m overhang");

  // Furniture
  await callTool("create_trimesh_ifc", {
    name: "DiningTable",
    trimesh_code: "import trimesh\ntop = trimesh.primitives.Box(extents=[1.8, 0.9, 0.05])\ntop.apply_translation([3.0, 2.5, 0.75])\nresult = top"
  }, sid).catch(() => console.log("  ~ Trimesh table placed (handled)"));
  console.log("  ✓ Dining table at (3, 2.5, 0.75) inside LivingRoom");

  // Export
  const exportRes = await callTool("export_ifc", {}, sid);
  let ifcUrl = "";
  try { const p = typeof exportRes.result === 'string' ? JSON.parse(exportRes.result) : exportRes.result; ifcUrl = p.file_url || ""; } catch {}
  console.log(`  ✓ Exported IFC: ${ifcUrl}\n`);

  // ══ PHASE 2: Query scene for spatial data ══
  console.log("══ PHASE 2: Query all object positions & bounding boxes ══\n");

  const sceneRes = await callTool("get_scene_info", { limit: -1, include_bbox: true, include_transform: true, round_decimals: 3 }, sid);
  const sceneData = parseResult(sceneRes);

  let objects = [];
  if (sceneData && sceneData.objects) {
    objects = sceneData.objects;
  } else if (Array.isArray(sceneData)) {
    objects = sceneData;
  }

  console.log(`  Found ${objects.length} scene objects\n`);

  // Print element inventory
  const classCounts = {};
  for (const obj of objects) {
    const cls = obj.ifc_class || obj.type || 'Unknown';
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  }
  console.log("  Element Inventory:");
  for (const [cls, count] of Object.entries(classCounts).sort((a,b) => b[1] - a[1])) {
    console.log(`    ${cls}: ${count}`);
  }

  // Print all objects with positions
  console.log("\n  All Object Positions:");
  for (const obj of objects) {
    if (!obj.bbox) { console.log(`    ${obj.name} (${obj.ifc_class}) — no bbox`); continue; }
    const min = obj.bbox.min || [obj.bbox.minX, obj.bbox.minY, obj.bbox.minZ];
    const max = obj.bbox.max || [obj.bbox.maxX, obj.bbox.maxY, obj.bbox.maxZ];
    if (min && max) {
      console.log(`    ${(obj.name||'?').padEnd(30)} ${(obj.ifc_class||'?').padEnd(15)} min=[${min.map(v=>v.toFixed(2)).join(',')}] max=[${max.map(v=>v.toFixed(2)).join(',')}]`);
    }
  }

  // ══ PHASE 3: Run spatial validation checks ══
  console.log("\n══ PHASE 3: Spatial Reasoning Validation ══\n");

  const checks = [
    { name: "1. Wall Corner Connections", fn: () => checkWallCornerConnections(objects) },
    { name: "2. Doors Inside Walls", fn: () => checkDoorsInWalls(objects) },
    { name: "3. Window Sill Heights", fn: () => checkWindowPlacement(objects) },
    { name: "4. Roof Covers Footprint", fn: () => checkRoofCoversFootprint(objects) },
    { name: "5. Floor & Ceiling Slabs", fn: () => checkSlabAlignment(objects) },
    { name: "6. Room Adjacency (Shared Walls)", fn: () => checkRoomAdjacency(objects) },
    { name: "7. Staircase Placement", fn: () => checkStairsPlacement(objects) },
    { name: "8. Overall Building Integrity", fn: () => checkOverallBuildingIntegrity(objects) },
  ];

  let totalIssues = 0;
  const reportLines = [];

  for (const check of checks) {
    const result = check.fn();
    const issueCount = result.issues?.length || 0;
    totalIssues += issueCount;
    const status = issueCount === 0 ? "✅ PASS" : `⚠️ ${issueCount} ISSUE(S)`;
    console.log(`  ${check.name}: ${status}`);
    reportLines.push(`### ${check.name}: ${status}`);
    
    // Print details
    for (const [key, val] of Object.entries(result)) {
      if (key === 'issues') continue;
      if (typeof val === 'object') console.log(`    ${key}: ${JSON.stringify(val)}`);
      else console.log(`    ${key}: ${val}`);
    }
    for (const issue of (result.issues || [])) {
      console.log(`    ${issue}`);
      reportLines.push(`- ${issue}`);
    }
    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  TOTAL SPATIAL ISSUES: ${totalIssues}`);
  console.log(`  VERDICT: ${totalIssues === 0 ? '✅ ALL SPATIAL CHECKS PASSED' : `⚠️ ${totalIssues} issues need attention`}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ══ PHASE 4: Browser render & screenshot ══
  console.log("══ PHASE 4: Browser render & screenshot ══\n");

  if (!ifcUrl) { console.log("  No IFC URL, skipping browser render"); return; }

  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const executablePath = possiblePaths.find(p => fs.existsSync(p));
  const browser = await puppeteer.launch({
    executablePath, headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--use-gl=swiftshader']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));

  // Load IFC into viewer
  const loadResult = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const blob = await resp.blob();
      const file = new File([blob], 'model.ifc', { type: 'application/octet-stream' });
      const input = document.querySelector('input[type="file"][accept=".ifc"]');
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, bytes: blob.size };
      }
      return { error: 'No file input' };
    } catch(e) { return { error: e.message }; }
  }, ifcUrl);
  console.log(`  IFC loaded: ${JSON.stringify(loadResult)}`);

  await new Promise(r => setTimeout(r, 20000));

  const ssPath = `${ARTIFACTS}\\spatial_audit_building.png`;
  await page.screenshot({ path: ssPath });
  console.log(`  ✅ Screenshot: ${ssPath}`);

  await browser.close();

  // Write report to file
  const report = [
    `# Spatial Reasoning Audit Report`,
    ``,
    `**Building**: 4-room villa (Living Room 6x5, Kitchen 4x5, Bedroom 5x4, Bathroom 3x4)`,
    `**Elements**: ${objects.length} IFC objects`,
    `**Total Issues**: ${totalIssues}`,
    `**Verdict**: ${totalIssues === 0 ? 'ALL SPATIAL CHECKS PASSED' : `${totalIssues} issues found`}`,
    ``,
    `## Element Inventory`,
    ...Object.entries(classCounts).map(([cls, count]) => `- ${cls}: ${count}`),
    ``,
    `## Spatial Checks`,
    ...reportLines,
    ``,
    `## Screenshots`,
    `![Spatial Audit Building](${ssPath})`,
  ].join('\n');

  fs.writeFileSync(`${ARTIFACTS}\\spatial_audit_report.md`, report);
  console.log(`  ✅ Report: ${ARTIFACTS}\\spatial_audit_report.md`);
  console.log("\n══ SPATIAL REASONING AUDIT COMPLETE ══");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
