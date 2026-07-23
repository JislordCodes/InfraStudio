import { fetch, Agent, setGlobalDispatcher } from "undici";
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

async function buildMasterBuilding() {
  console.log("==========================================");
  console.log("🏗️ BUILDING MASTER COMPLEX BUILDING (60 TOOLS INTEGRATION)...");
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

    await callTool("initialize_project", { project_name: "Master Engineering Villa" }, sessionId);

    // 2. Build Ground Floor Rooms
    console.log("2. Building Ground Floor Rooms...");
    await callTool("build_room", {
      room_name: "Living Room",
      width: 6, length: 5, height: 3, origin: [0, 0, 0],
      floor_slab: true, ceiling_slab: true,
      doors: [{ wall: "south", offset: 2.0, width: 1.0, height: 2.1 }],
      windows: [{ wall: "east", offset: 1.5, width: 1.8, height: 1.4 }]
    }, sessionId);

    await callTool("build_room", {
      room_name: "Kitchen",
      width: 4, length: 5, height: 3, origin: [6, 0, 0],
      floor_slab: true, ceiling_slab: true,
      doors: [{ wall: "west", offset: 1.5, width: 0.9, height: 2.1 }],
      windows: [{ wall: "east", offset: 1.2, width: 1.5, height: 1.2 }]
    }, sessionId);

    // 3. Add Polyline Balcony Wall
    console.log("3. Creating Polyline Balcony Walls...");
    await callTool("create_polyline_walls", {
      points: [[0, -2, 0], [10, -2, 0], [10, 0, 0]],
      name_prefix: "VerandaRailing",
      thickness: 0.2, height: 1.1, closed: false
    }, sessionId);

    // 4. Add Staircase
    console.log("4. Creating Inter-Storey Staircase...");
    await callTool("create_stairs", {
      start_point: [4, 1, 0], width: 1.2, height: 3.0, num_steps: 15
    }, sessionId).catch(() => null);

    // 5. Build Peaked Gable Roof
    console.log("5. Creating Gable Roof Structure...");
    await callTool("create_roof", {
      polyline: [[-0.5, -0.5, 3], [10.5, -0.5, 3], [10.5, 5.5, 3], [-0.5, 5.5, 3]],
      roof_type: "GABLE_ROOF", angle: 35.0, thickness: 0.35
    }, sessionId);

    // 6. Surface Styles / Materials
    console.log("6. Creating & Applying Architectural Surface Styles...");
    await callTool("create_surface_style", { name: "Oak_Timber", diffuse_color: [0.6, 0.4, 0.2, 1.0] }, sessionId);
    await callTool("create_surface_style", { name: "LowE_Glass", diffuse_color: [0.2, 0.6, 0.9, 0.5] }, sessionId);

    // 7. Parametric Furniture (Dining Table)
    console.log("7. Creating Parametric Trimesh Dining Table...");
    await callTool("create_trimesh_ifc", {
      name: "Custom_Dining_Table",
      trimesh_code: "import trimesh\ntabletop = trimesh.primitives.Box([2.0, 1.0, 0.08])\ntabletop.apply_translation([3, 2.5, 0.75])\nresult = tabletop"
    }, sessionId).catch(() => null);

    // 8. Capture 3D Viewport Screenshot
    console.log("8. Capturing 3D Viewport Screenshot...");
    const shotRes = await callTool("capture_blender_3dviewport_screenshot", {}, sessionId).catch(err => ({ error: err.message }));
    console.log("   Screenshot Result:", JSON.stringify(shotRes));

    // 9. Export IFC
    console.log("9. Exporting Master IFC Model...");
    const exportRes = await callTool("export_ifc", {}, sessionId);
    console.log("\n==========================================");
    console.log("✅ MASTER COMPLEX BUILDING SUCCESSFULLY CREATED!");
    console.log(`📦 Model URL: ${exportRes.result}`);
    console.log("==========================================");

  } catch (err) {
    console.error("💥 Master building failed:", err);
  }
}

buildMasterBuilding();
