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

async function callEdge(funcName, body) {
  const res = await uFetch(`${BASE_URL}/${funcName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${funcName} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function parseResult(res) {
  try { return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; }
  catch { return res.result; }
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  SPATIAL AUDIT v3 — WITH WALL DEDUPLICATION FIX APPLIED      ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  // Init
  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  console.log("══ PHASE 1: Build 4-room villa ══\n");
  await callTool("initialize_project", { project_name: "Spatial Audit v3" }, sid);
  console.log("  ✓ Project initialized");

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
  console.log("  ✓ Kitchen (6,0) 4x5m");

  await callTool("build_room", {
    room_name: "Bedroom", width: 5, length: 4, height: 3,
    wall_thickness: 0.25, origin: [0, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "north", offset: 1.5, width: 1.5, height: 1.4, sill_height: 0.9 }]
  }, sid);
  console.log("  ✓ Bedroom (0,5) 5x4m");

  await callTool("build_room", {
    room_name: "Bathroom", width: 3, length: 4, height: 3,
    wall_thickness: 0.25, origin: [5, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 1.0, width: 0.8, height: 2.1 }],
    windows: [{ wall: "north", offset: 0.8, width: 0.8, height: 0.6, sill_height: 1.5 }]
  }, sid);
  console.log("  ✓ Bathroom (5,5) 3x4m");

  // ═══ PHASE 1.5: DEDUPLICATE WALLS ═══
  console.log("\n══ PHASE 1.5: Deduplicate shared walls ══\n");
  try {
    const dedupRes = await callEdge('agent-bim', { action: 'deduplicate_walls', mcpSessionId: sid });
    sid = dedupRes.mcpSessionId || sid;
    console.log(`  ✓ Deduplication complete: ${dedupRes.removed || 0} walls removed`);
  } catch (e) {
    console.log(`  ⚠ Deduplication error: ${e.message}`);
  }

  // Add roof
  await callTool("create_roof", {
    polyline: [[-0.5, -0.5, 3], [10.5, -0.5, 3], [10.5, 9.5, 3], [-0.5, 9.5, 3]],
    roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.3
  }, sid);
  console.log("  ✓ Gable Roof 35°");

  // Export
  const exportRes = await callTool("export_ifc", {}, sid);
  let ifcUrl = "";
  try { const p = typeof exportRes.result === 'string' ? JSON.parse(exportRes.result) : exportRes.result; ifcUrl = p.file_url || ""; } catch {}
  console.log(`  ✓ Exported: ${ifcUrl}\n`);

  // ═══ PHASE 2: Query bounding boxes from Blender ═══
  console.log("══ PHASE 2: Query all bounding boxes from Blender ══\n");

  const bboxScript = `
import bpy, json, mathutils
results = []
for obj in bpy.data.objects:
    if obj.type != 'MESH': continue
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    name = obj.name
    if "Wall" in name: t = "IfcWall"
    elif "Slab" in name or "Floor" in name or "Ceiling" in name: t = "IfcSlab"
    elif "Door" in name: t = "IfcDoor"
    elif "Window" in name: t = "IfcWindow"
    elif "Roof" in name: t = "IfcRoof"
    elif "Stair" in name: t = "IfcStair"
    else: t = "Other"
    results.append({"name": name, "ifc_type": t,
        "bbox_min": [round(min(xs),3), round(min(ys),3), round(min(zs),3)],
        "bbox_max": [round(max(xs),3), round(max(ys),3), round(max(zs),3)],
        "width": round(max(xs)-min(xs),3), "depth": round(max(ys)-min(ys),3), "height": round(max(zs)-min(zs),3)})
results.sort(key=lambda r: (r["ifc_type"], r["name"]))
print(json.dumps(results))
`;

  const bboxRes = await callTool("execute_blender_code", { code: bboxScript }, sid);
  const bboxData = parseResult(bboxRes);
  let objects = [];
  try {
    if (typeof bboxData === 'string') { const m = bboxData.match(/\[[\s\S]*\]/); if (m) objects = JSON.parse(m[0]); }
    else if (Array.isArray(bboxData)) objects = bboxData;
    else if (bboxData?.output) { const m = bboxData.output.match(/\[[\s\S]*\]/); if (m) objects = JSON.parse(m[0]); }
  } catch(e) { console.log("Parse error:", e.message); }

  const walls = objects.filter(o => o.ifc_type === 'IfcWall');
  const doors = objects.filter(o => o.ifc_type === 'IfcDoor');
  const windows = objects.filter(o => o.ifc_type === 'IfcWindow');
  const slabs = objects.filter(o => o.ifc_type === 'IfcSlab');
  const roofs = objects.filter(o => o.ifc_type === 'IfcRoof');

  console.log(`  Objects: ${objects.length} total — ${walls.length} walls, ${slabs.length} slabs, ${doors.length} doors, ${windows.length} windows, ${roofs.length} roofs\n`);

  // Print table
  for (const obj of objects) {
    const name = (obj.name || '?').padEnd(35).substring(0, 35);
    const type = (obj.ifc_type || '?').padEnd(12).substring(0, 12);
    const bmin = `[${obj.bbox_min.map(v => v.toFixed(2)).join(', ')}]`.padEnd(25);
    const bmax = `[${obj.bbox_max.map(v => v.toFixed(2)).join(', ')}]`.padEnd(25);
    console.log(`  ${name} ${type} min=${bmin} max=${bmax} ${obj.width.toFixed(2)}x${obj.depth.toFixed(2)}x${obj.height.toFixed(2)}`);
  }

  // ═══ PHASE 3: Run ALL spatial checks ═══
  console.log("\n══ PHASE 3: Spatial Validation Checks ══\n");

  let totalIssues = 0;
  let totalPasses = 0;

  // CHECK 1: Doors grounded
  console.log("  ── CHECK 1: Doors Grounded at Floor Level ──");
  let c1Issues = 0;
  for (const d of doors) {
    if (d.bbox_min[2] > 0.15) { console.log(`    ⚠️ ${d.name} floating at z=${d.bbox_min[2]}`); c1Issues++; }
    else console.log(`    ✅ ${d.name}: z=${d.bbox_min[2].toFixed(2)}, h=${d.height.toFixed(2)}m`);
  }
  if (c1Issues === 0) { totalPasses++; console.log("    ✅ ALL DOORS GROUNDED"); } else totalIssues += c1Issues;

  // CHECK 2: Window sills
  console.log("\n  ── CHECK 2: Window Sill Heights ──");
  let c2Issues = 0;
  for (const w of windows) {
    const ok = w.bbox_min[2] >= 0.3 && w.bbox_min[2] <= 2.0 && w.bbox_max[2] <= 3.2;
    if (ok) console.log(`    ✅ ${w.name}: sill=${w.bbox_min[2].toFixed(2)}m, top=${w.bbox_max[2].toFixed(2)}m`);
    else { console.log(`    ⚠️ ${w.name}: sill=${w.bbox_min[2].toFixed(2)}m OUT OF RANGE`); c2Issues++; }
  }
  if (c2Issues === 0) { totalPasses++; console.log("    ✅ ALL WINDOWS CORRECT"); } else totalIssues += c2Issues;

  // CHECK 3: Roof covers footprint
  console.log("\n  ── CHECK 3: Roof Covers Footprint ──");
  let c3Issues = 0;
  const nonVerandaWalls = walls.filter(w => !w.name.includes('Veranda'));
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  for (const w of nonVerandaWalls) {
    fMinX = Math.min(fMinX, w.bbox_min[0]); fMinY = Math.min(fMinY, w.bbox_min[1]);
    fMaxX = Math.max(fMaxX, w.bbox_max[0]); fMaxY = Math.max(fMaxY, w.bbox_max[1]);
  }
  let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity, rMinZ = Infinity;
  for (const r of roofs) {
    rMinX = Math.min(rMinX, r.bbox_min[0]); rMinY = Math.min(rMinY, r.bbox_min[1]);
    rMaxX = Math.max(rMaxX, r.bbox_max[0]); rMaxY = Math.max(rMaxY, r.bbox_max[1]);
    rMinZ = Math.min(rMinZ, r.bbox_min[2]);
  }
  console.log(`    Building: X=[${fMinX.toFixed(1)}, ${fMaxX.toFixed(1)}], Y=[${fMinY.toFixed(1)}, ${fMaxY.toFixed(1)}]`);
  console.log(`    Roof:     X=[${rMinX.toFixed(1)}, ${rMaxX.toFixed(1)}], Y=[${rMinY.toFixed(1)}, ${rMaxY.toFixed(1)}], Z_base=${rMinZ.toFixed(1)}`);
  if (rMinX > fMinX + 0.5) { c3Issues++; console.log(`    ⚠️ West not covered`); }
  if (rMaxX < fMaxX - 0.5) { c3Issues++; console.log(`    ⚠️ East not covered`); }
  if (rMinY > fMinY + 0.5) { c3Issues++; console.log(`    ⚠️ South not covered`); }
  if (rMaxY < fMaxY - 0.5) { c3Issues++; console.log(`    ⚠️ North not covered`); }
  if (rMinZ < 2.5) { c3Issues++; console.log(`    ⚠️ Roof too low z=${rMinZ.toFixed(1)}`); }
  if (c3Issues === 0) { totalPasses++; console.log("    ✅ ROOF FULLY COVERS FOOTPRINT"); } else totalIssues += c3Issues;

  // CHECK 4: Floor & ceiling slabs
  console.log("\n  ── CHECK 4: Floor & Ceiling Slabs ──");
  let c4Issues = 0;
  const floorSlabs = slabs.filter(s => s.bbox_min[2] < 0.5);
  const ceilSlabs = slabs.filter(s => s.bbox_min[2] > 2.0);
  console.log(`    Floor slabs: ${floorSlabs.length}, Ceiling slabs: ${ceilSlabs.length}`);
  if (floorSlabs.length === 0) { c4Issues++; console.log("    ⚠️ No floor slabs!"); }
  if (ceilSlabs.length === 0) { c4Issues++; console.log("    ⚠️ No ceiling slabs!"); }
  if (c4Issues === 0) { totalPasses++; console.log("    ✅ FLOOR AND CEILING SLABS PRESENT"); } else totalIssues += c4Issues;

  // CHECK 5: Wall heights consistent
  console.log("\n  ── CHECK 5: Wall Heights ──");
  let c5Issues = 0;
  for (const w of nonVerandaWalls) {
    if (Math.abs(w.height - 3.0) > 0.3) { c5Issues++; console.log(`    ⚠️ ${w.name} h=${w.height.toFixed(2)}m`); }
  }
  if (c5Issues === 0) { totalPasses++; console.log(`    ✅ ALL ${nonVerandaWalls.length} WALLS AT 3m`); } else totalIssues += c5Issues;

  // CHECK 6: ★ NO DOUBLE/OVERLAPPING WALLS ★ (the fixed check)
  console.log("\n  ── CHECK 6: ★ NO DOUBLE/OVERLAPPING WALLS ★ ──");
  let c6Issues = 0;
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i], b = walls[j];
      const ox = Math.max(0, Math.min(a.bbox_max[0], b.bbox_max[0]) - Math.max(a.bbox_min[0], b.bbox_min[0]));
      const oy = Math.max(0, Math.min(a.bbox_max[1], b.bbox_max[1]) - Math.max(a.bbox_min[1], b.bbox_min[1]));
      const oz = Math.max(0, Math.min(a.bbox_max[2], b.bbox_max[2]) - Math.max(a.bbox_min[2], b.bbox_min[2]));
      const overlapVol = ox * oy * oz;
      const minVol = Math.min(a.width * a.depth * a.height, b.width * b.depth * b.height);
      if (minVol > 0 && overlapVol / minVol > 0.5) {
        c6Issues++;
        console.log(`    ⚠️ DOUBLE WALL: "${a.name}" and "${b.name}" overlap ${(overlapVol / minVol * 100).toFixed(0)}%`);
      }
    }
  }
  if (c6Issues === 0) { totalPasses++; console.log("    ✅ NO OVERLAPPING WALLS — DEDUPLICATION WORKING!"); } else totalIssues += c6Issues;

  // ═══ FINAL VERDICT ═══
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  SPATIAL CHECKS: ${totalPasses}/6 PASSED, ${totalIssues} ISSUES`);
  console.log(`  VERDICT: ${totalIssues === 0 ? '✅ ALL SPATIAL REASONING CHECKS PASSED!' : `⚠️ ${totalIssues} issues remain`}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ═══ PHASE 4: Screenshot ═══
  if (ifcUrl) {
    console.log("══ PHASE 4: Browser screenshot ══\n");
    const executablePath = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
    const browser = await puppeteer.launch({ executablePath, headless: "new",
      args: ['--no-sandbox', '--enable-webgl', '--use-gl=swiftshader'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));
    const lr = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url); const blob = await resp.blob();
        const file = new File([blob], 'model.ifc', { type: 'application/octet-stream' });
        const input = document.querySelector('input[type="file"][accept=".ifc"]');
        if (input) { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, bytes: blob.size }; }
        return { error: 'no input' };
      } catch(e) { return { error: e.message }; }
    }, ifcUrl);
    console.log(`  IFC loaded: ${JSON.stringify(lr)}`);
    await new Promise(r => setTimeout(r, 20000));
    const ssPath = `${ARTIFACTS}\\spatial_audit_v3_fixed.png`;
    await page.screenshot({ path: ssPath });
    console.log(`  ✅ Screenshot: ${ssPath}`);
    await browser.close();
  }

  console.log("\n══ SPATIAL AUDIT v3 COMPLETE ══");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
