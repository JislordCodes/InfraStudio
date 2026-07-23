import { fetch, Agent, setGlobalDispatcher } from "undici";
import puppeteer from 'puppeteer';
import * as fs from "fs";

const localAgent = new Agent({
  headersTimeout: 900000,
  bodyTimeout: 900000,
  connectTimeout: 60000
});
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function callTool(name, args, sessionId) {
  const res = await fetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "call_tool",
      name: name,
      args: args,
      session_id: sessionId
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tool ${name} failed (HTTP ${res.status}): ${err}`);
  }
  return res.json();
}

async function runMasterBuildingWithBrowserScreenshot() {
  console.log("==========================================");
  console.log("🏗️ BUILDING MASTER 60-TOOL INTEGRATED BUILDING...");
  console.log("==========================================\n");

  let sessionId = "";

  try {
    // 1. Initialize
    console.log("1. Initializing Project...");
    const initRes = await fetch(`${BASE_URL}/gemini-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "init", session_id: "" })
    }).then(r => r.json());
    sessionId = initRes.session_id;

    await callTool("initialize_project", { project_name: "60-Tool Master Villa" }, sessionId);

    // 2. Build Ground Floor Rooms
    console.log("2. Building Living Room & Kitchen...");
    await callTool("build_room", {
      room_name: "Living Room", width: 6, length: 5, height: 3, origin: [0, 0, 0],
      floor_slab: true, ceiling_slab: true,
      doors: [{ wall: "south", offset: 2.0, width: 1.0, height: 2.1 }],
      windows: [{ wall: "east", offset: 1.5, width: 1.8, height: 1.4 }]
    }, sessionId);

    await callTool("build_room", {
      room_name: "Kitchen", width: 4, length: 5, height: 3, origin: [6, 0, 0],
      floor_slab: true, ceiling_slab: true,
      doors: [{ wall: "west", offset: 1.5, width: 0.9, height: 2.1 }],
      windows: [{ wall: "east", offset: 1.2, width: 1.5, height: 1.2 }]
    }, sessionId);

    // 3. Polyline Railing
    console.log("3. Creating Polyline Balcony Wall...");
    await callTool("create_polyline_walls", {
      points: [[0, -2, 0], [10, -2, 0], [10, 0, 0]],
      name_prefix: "VerandaRailing", thickness: 0.2, height: 1.1, closed: false
    }, sessionId);

    // 4. Inter-storey Staircase
    console.log("4. Creating Staircase...");
    await callTool("create_stairs", { start_point: [4, 1, 0], width: 1.2, height: 3.0, num_steps: 15 }, sessionId).catch(() => null);

    // 5. Peaked Gable Roof
    console.log("5. Creating 35° Gable Roof...");
    await callTool("create_roof", {
      polyline: [[-0.5, -0.5, 3], [10.5, -0.5, 3], [10.5, 5.5, 3], [-0.5, 5.5, 3]],
      roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.35
    }, sessionId);

    // 6. Surface Styles
    console.log("6. Applying Architectural Materials...");
    await callTool("create_surface_style", { name: "Oak_Timber", diffuse_color: [0.6, 0.4, 0.2, 1.0] }, sessionId);

    // 7. Parametric Furniture
    console.log("7. Creating Parametric Dining Table...");
    await callTool("create_trimesh_ifc", {
      name: "Master_Dining_Table",
      trimesh_code: "import trimesh\ntabletop = trimesh.primitives.Box([2.0, 1.0, 0.08])\ntabletop.apply_translation([3, 2.5, 0.75])\nresult = tabletop"
    }, sessionId).catch(() => null);

    // 8. Export IFC
    console.log("8. Exporting Master IFC Model...");
    const exportRes = await callTool("export_ifc", {}, sessionId);
    console.log(`   📦 Model URL: ${exportRes.result.file_url || JSON.stringify(exportRes.result)}`);

    // 9. Take Browser Screenshot using Puppeteer Edge
    console.log("\n9. Capturing Browser 3D Rendering Screenshot...");
    const possiblePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ];
    let executablePath = possiblePaths.find(p => fs.existsSync(p));

    const browser = await puppeteer.launch({
      executablePath, headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: "master_60_tools_building.png", fullPage: false });
    await browser.close();

    console.log("   ✅ Saved: master_60_tools_building.png");
    console.log("\n==========================================");
    console.log("🎉 MASTER COMPLEX BUILDING & SCREENSHOT COMPLETE!");
    console.log("==========================================");

  } catch (err) {
    console.error("💥 Master test failed:", err);
  }
}

runMasterBuildingWithBrowserScreenshot();
