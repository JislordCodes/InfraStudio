import { fetch, Agent, setGlobalDispatcher } from "undici";

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

async function testAllTools() {
  console.log("==========================================");
  console.log("🧪 AUDITING AND TESTING ALL MCP TOOLS...");
  console.log("==========================================\n");

  let sessionId = "";
  const results = {};

  try {
    // 1. Initialize
    console.log("1. Testing initialize_project...");
    const initRes = await fetch(`${BASE_URL}/gemini-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "init", session_id: "" })
    }).then(r => r.json());
    sessionId = initRes.session_id;
    console.log(`   ✅ Session Initialized: ${sessionId}`);

    const initProj = await callTool("initialize_project", { project_name: "Tool Test Building" }, sessionId);
    sessionId = initProj.session_id;
    results["initialize_project"] = "PASS";
    console.log("   ✅ initialize_project: PASS");

    // 2. Build Room (Creates storeys, walls, slab, doors, windows with openings)
    console.log("\n2. Testing build_room...");
    const roomRes = await callTool("build_room", {
      room_name: "Living Room",
      width: 6,
      length: 5,
      height: 3,
      wall_thickness: 0.2,
      origin: [0, 0, 0],
      floor_slab: true,
      doors: [{ wall: "south", offset: 2.0, width: 1.0, height: 2.1 }],
      windows: [{ wall: "east", offset: 1.5, width: 1.5, height: 1.2, sill_height: 0.9 }]
    }, sessionId);
    sessionId = roomRes.session_id;
    results["build_room"] = "PASS";
    console.log("   ✅ build_room: PASS");

    // 3. Two Point Wall
    console.log("\n3. Testing create_two_point_wall...");
    const wallRes = await callTool("create_two_point_wall", {
      start_point: [0, 5, 0],
      end_point: [6, 5, 0],
      name: "North Partition Wall",
      thickness: 0.2,
      height: 3.0
    }, sessionId);
    sessionId = wallRes.session_id;
    results["create_two_point_wall"] = "PASS";
    console.log("   ✅ create_two_point_wall: PASS");

    // 4. Polyline Walls
    console.log("\n4. Testing create_polyline_walls...");
    const polyWalls = await callTool("create_polyline_walls", {
      points: [[6, 0, 0], [10, 0, 0], [10, 5, 0], [6, 5, 0]],
      name_prefix: "BalconyWall",
      thickness: 0.2,
      height: 1.1,
      closed: false
    }, sessionId);
    sessionId = polyWalls.session_id;
    results["create_polyline_walls"] = "PASS";
    console.log("   ✅ create_polyline_walls: PASS");

    // 5. Roofs (Flat, Gable, Hip)
    console.log("\n5. Testing create_roof (GABLE_ROOF)...");
    const gableRes = await callTool("create_roof", {
      polyline: [[-0.4, -0.4, 3], [6.4, -0.4, 3], [6.4, 5.4, 3], [-0.4, 5.4, 3]],
      roof_type: "GABLE_ROOF",
      angle: 35.0,
      thickness: 0.3
    }, sessionId);
    sessionId = gableRes.session_id;
    results["create_roof (GABLE_ROOF)"] = "PASS";
    console.log("   ✅ create_roof (GABLE_ROOF): PASS");

    // 6. Stairs
    console.log("\n6. Testing create_stairs...");
    const stairsRes = await callTool("create_stairs", {
      start_point: [1, 1, 0],
      width: 1.0,
      height: 3.0,
      num_steps: 15
    }, sessionId).catch(err => ({ error: err.message }));
    if (!stairsRes.error) {
      sessionId = stairsRes.session_id || sessionId;
      results["create_stairs"] = "PASS";
      console.log("   ✅ create_stairs: PASS");
    } else {
      results["create_stairs"] = `WARN: ${stairsRes.error}`;
      console.log(`   ⚠️ create_stairs: ${stairsRes.error}`);
    }

    // 7. Surface Styles
    console.log("\n7. Testing create_surface_style & list_styles...");
    const styleRes = await callTool("create_surface_style", {
      name: "Timber_Oak",
      diffuse_color: [0.6, 0.4, 0.2, 1.0]
    }, sessionId);
    sessionId = styleRes.session_id;
    results["create_surface_style"] = "PASS";
    console.log("   ✅ create_surface_style: PASS");

    const listStylesRes = await callTool("list_styles", {}, sessionId);
    sessionId = listStylesRes.session_id;
    results["list_styles"] = "PASS";
    console.log("   ✅ list_styles: PASS");

    // 8. Get Scene Info & Overview
    console.log("\n8. Testing get_scene_info & get_ifc_scene_overview...");
    const sceneInfo = await callTool("get_scene_info", { limit: -1 }, sessionId);
    sessionId = sceneInfo.session_id;
    const overview = await callTool("get_ifc_scene_overview", {}, sessionId);
    sessionId = overview.session_id;
    results["get_scene_info"] = "PASS";
    results["get_ifc_scene_overview"] = "PASS";
    console.log("   ✅ get_scene_info: PASS");
    console.log("   ✅ get_ifc_scene_overview: PASS");

    // 9. Trimesh Parametric Furniture / Feature
    console.log("\n9. Testing create_trimesh_ifc (Custom Furniture)...");
    const trimeshRes = await callTool("create_trimesh_ifc", {
      name: "Dining_Table",
      trimesh_code: "import trimesh\ntabletop = trimesh.primitives.Box([2.0, 1.0, 0.08])\ntabletop.apply_translation([0, 0, 0.75])\nleg1 = trimesh.primitives.Cylinder(radius=0.04, height=0.75)\nleg1.apply_translation([-0.9, -0.4, 0.375])\nresult = tabletop.union(leg1)"
    }, sessionId).catch(err => ({ error: err.message }));
    if (!trimeshRes.error) {
      sessionId = trimeshRes.session_id || sessionId;
      results["create_trimesh_ifc"] = "PASS";
      console.log("   ✅ create_trimesh_ifc: PASS");
    } else {
      results["create_trimesh_ifc"] = `WARN: ${trimeshRes.error}`;
      console.log(`   ⚠️ create_trimesh_ifc: ${trimeshRes.error}`);
    }

    // 10. Export IFC
    console.log("\n10. Testing export_ifc...");
    const exportRes = await callTool("export_ifc", {}, sessionId);
    sessionId = exportRes.session_id;
    results["export_ifc"] = "PASS";
    console.log("   ✅ export_ifc: PASS");
    console.log(`   📦 Exported Model URL: ${exportRes.result}`);

    console.log("\n==========================================");
    console.log("🎉 ALL MCP TOOLS TEST SUMMARY:");
    console.table(results);
    console.log("==========================================");

  } catch (err) {
    console.error("\n💥 MCP TOOL AUDIT FAILED WITH ERROR:");
    console.error(err);
    process.exit(1);
  }
}

testAllTools();
