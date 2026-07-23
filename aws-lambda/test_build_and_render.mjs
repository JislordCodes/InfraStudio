import { fetch as uFetch, Agent, setGlobalDispatcher } from "undici";
import puppeteer from 'puppeteer';
import * as fs from "fs";

const localAgent = new Agent({
  headersTimeout: 900000,
  bodyTimeout: 900000,
  connectTimeout: 60000
});
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";
const ARTIFACTS_DIR = "C:\\Users\\david\\.gemini\\antigravity\\brain\\c2579048-00a5-46d3-9c07-409e7d26348d";

async function callTool(name, args, sessionId) {
  const res = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "call_tool", name, args, session_id: sessionId })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tool ${name} failed (HTTP ${res.status}): ${err}`);
  }
  return res.json();
}

async function main() {
  // ═══════ STEP 1: Build via MCP ═══════
  console.log("=== STEP 1: BUILD MASTER VILLA VIA MCP TOOLS ===\n");

  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  console.log("  [1] initialize_project...");
  await callTool("initialize_project", { project_name: "Master Villa" }, sid);

  console.log("  [2] build_room: Living Room 6x5m...");
  await callTool("build_room", {
    room_name: "Living Room", width: 6, length: 5, height: 3,
    wall_thickness: 0.25, origin: [0, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.5, width: 1.0, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.5, width: 1.8, height: 1.4, sill_height: 0.9 },
              { wall: "north", offset: 2.0, width: 1.5, height: 1.2, sill_height: 0.9 }]
  }, sid);

  console.log("  [3] build_room: Kitchen 4x5m...");
  await callTool("build_room", {
    room_name: "Kitchen", width: 4, length: 5, height: 3,
    wall_thickness: 0.25, origin: [6, 0, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "west", offset: 1.5, width: 0.9, height: 2.1 }],
    windows: [{ wall: "east", offset: 1.0, width: 1.2, height: 1.2, sill_height: 0.9 }]
  }, sid);

  console.log("  [4] build_room: Bedroom 5x4m...");
  await callTool("build_room", {
    room_name: "Bedroom", width: 5, length: 4, height: 3,
    wall_thickness: 0.25, origin: [0, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 2.0, width: 0.9, height: 2.1 }],
    windows: [{ wall: "north", offset: 1.5, width: 1.5, height: 1.4, sill_height: 0.9 }]
  }, sid);

  console.log("  [5] build_room: Bathroom 3x4m...");
  await callTool("build_room", {
    room_name: "Bathroom", width: 3, length: 4, height: 3,
    wall_thickness: 0.25, origin: [5, 5, 0], floor_slab: true, ceiling_slab: true,
    doors: [{ wall: "south", offset: 1.0, width: 0.8, height: 2.1 }],
    windows: [{ wall: "north", offset: 0.8, width: 0.8, height: 0.6, sill_height: 1.5 }]
  }, sid);

  console.log("  [6] create_polyline_walls: Veranda...");
  await callTool("create_polyline_walls", {
    points: [[-0.5, -1.5, 0], [10.5, -1.5, 0], [10.5, 0, 0]],
    name_prefix: "VerandaRailing", thickness: 0.15, height: 1.1, closed: false
  }, sid);

  console.log("  [7] create_stairs...");
  await callTool("create_stairs", { start_point: [8, 5, 0], width: 1.2, height: 3.0, num_steps: 15 }, sid)
    .catch(e => console.log("    stairs handled:", e.message.substring(0, 50)));

  console.log("  [8] create_roof: Gable 35°...");
  await callTool("create_roof", {
    polyline: [[-0.5, -1.5, 3], [10.5, -1.5, 3], [10.5, 9.5, 3], [-0.5, 9.5, 3]],
    roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.3
  }, sid);

  console.log("  [9] create_surface_style...");
  await callTool("create_surface_style", { name: "BrickExterior", diffuse_color: [0.72, 0.38, 0.25, 1.0] }, sid);

  console.log("  [10] create_trimesh_ifc: Table...");
  await callTool("create_trimesh_ifc", {
    name: "DiningTable",
    trimesh_code: "import trimesh\ntop = trimesh.primitives.Box(extents=[1.8, 0.9, 0.05])\ntop.apply_translation([3.0, 2.5, 0.75])\nresult = top"
  }, sid).catch(e => console.log("    trimesh handled:", e.message.substring(0, 50)));

  console.log("  [11] export_ifc...");
  const exportRes = await callTool("export_ifc", {}, sid);
  let ifcUrl = "";
  try {
    const p = typeof exportRes.result === 'string' ? JSON.parse(exportRes.result) : exportRes.result;
    ifcUrl = p.file_url || "";
  } catch(e) { ifcUrl = exportRes.result?.file_url || ""; }
  console.log(`\n  📦 IFC URL: ${ifcUrl}\n`);

  if (!ifcUrl) { console.error("No IFC URL!"); return; }

  // ═══════ STEP 2: Render in browser ═══════
  console.log("=== STEP 2: LOAD IFC IN BROWSER & SCREENSHOT ===\n");

  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const executablePath = possiblePaths.find(p => fs.existsSync(p));

  const browser = await puppeteer.launch({
    executablePath, headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--use-gl=swiftshader']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log("  Navigating to localhost:5173 ...");
  // Use 'load' event instead of networkidle2 - the 3D viewer has constant WebGL activity
  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 60000 });
  console.log("  Page loaded. Waiting 8s for 3D engine init...");
  await new Promise(r => setTimeout(r, 8000));

  // Load the IFC model by injecting it through the file input
  console.log(`  Loading IFC file from: ${ifcUrl}`);
  const loadResult = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const blob = await resp.blob();
      const file = new File([blob], 'model.ifc', { type: 'application/octet-stream' });

      // Find the hidden file input for IFC upload
      const input = document.querySelector('input[type="file"][accept=".ifc"]');
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'file-input', bytes: blob.size };
      }
      return { error: 'No file input found' };
    } catch(e) { return { error: e.message }; }
  }, ifcUrl);

  console.log(`  Load result: ${JSON.stringify(loadResult)}`);

  // Wait for model to render in 3D
  console.log("  Waiting 20s for 3D model to fully render...");
  await new Promise(r => setTimeout(r, 20000));

  // Screenshot the rendered building
  const screenshotPath = `${ARTIFACTS_DIR}\\master_building_rendered.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`  ✅ Screenshot saved: ${screenshotPath}`);

  // Also take a second screenshot after panning/rotation for different angle
  console.log("  Taking console log snapshot...");
  const consoleLogs = await page.evaluate(() => {
    // Check if there are any IFC objects in the scene
    const bodyText = document.body.innerText;
    return bodyText.substring(0, 500);
  });
  console.log(`  Page text: ${consoleLogs.substring(0, 200)}`);

  await browser.close();
  console.log("\n=== DONE ===");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
