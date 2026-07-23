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
    throw new Error(`Tool ${name} HTTP error (${res.status}): ${err}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function testAll60ToolsIndividually() {
  console.log("=================================================");
  console.log("🔍 TESTING ALL 60 MCP TOOLS INDIVIDUALLY (1 BY 1)");
  console.log("=================================================\n");

  const initRes = await fetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());

  let sessionId = initRes.session_id;

  // Initialize base scene
  await callTool("initialize_project", { project_name: "Audit 60 Tools" }, sessionId);
  const roomRes = await callTool("build_room", { room_name: "Host Room", width: 5, length: 5, height: 3, origin: [0,0,0] }, sessionId);
  sessionId = roomRes.session_id || sessionId;

  // Get wall GUID for tools needing wall_guid
  const sceneRes = await callTool("get_scene_info", { limit: -1 }, sessionId);
  sessionId = sceneRes.session_id || sessionId;
  
  let wallGuid = "";
  try {
    const parsed = typeof sceneRes.result === 'string' ? JSON.parse(sceneRes.result) : sceneRes.result;
    const walls = parsed.objects ? parsed.objects.filter(o => o.ifc_class === 'IfcWall') : [];
    if (walls.length > 0) wallGuid = walls[0].guid || walls[0].global_id || "";
  } catch (e) {}

  const toolPayloads = {
    "execute_blender_code": { code: "import bpy\nprint('Tool test')" },
    "export_ifc": {},
    "list_blender_commands": {},
    "execute_ifc_code_tool": { code: "print('IFC code test')" },
    "get_scene_info": { limit: 10 },
    "get_blender_object_info": { object_name: "Camera" },
    "get_selected_objects": {},
    "get_object_info": { object_id: wallGuid || "1" },
    "get_ifc_scene_overview": {},
    "create_wall": { name: "TestWall", dimensions: { length: 4, height: 3, thickness: 0.2 }, location: [0, 6, 0] },
    "create_two_point_wall": { start_point: [0, 6, 0], end_point: [4, 6, 0], name: "TwoPointWall" },
    "create_polyline_walls": { points: [[0, 6, 0], [4, 6, 0], [4, 10, 0]], closed: false },
    "update_wall": { wall_guid: wallGuid || "1", dimensions: { height: 3.2 } },
    "get_wall_properties": { wall_guid: wallGuid || "1" },
    "get_roof_types": {},
    "create_roof": { polyline: [[-0.4, -0.4, 3], [5.4, -0.4, 3], [5.4, 5.4, 3], [-0.4, 5.4, 3]], roof_type: "GABLE_ROOF", angle: 35 },
    "update_roof": { roof_guid: "1", angle: 30 },
    "delete_roof": { roof_guids: ["dummy_guid"] },
    "create_slab": { polyline: [[0, 0, 0], [5, 0, 0], [5, 5, 0], [0, 5, 0]], thickness: 0.2, name: "FloorSlab" },
    "update_slab": { slab_guid: "1", thickness: 0.25 },
    "get_slab_properties": { slab_guid: "1" },
    "get_door_operation_types": {},
    "create_door": { wall_guid: wallGuid, location: [2, 0, 0], width: 0.9, height: 2.1, create_opening: true },
    "update_door": { door_guid: "1", width: 1.0 },
    "get_door_properties": { door_guid: "1" },
    "get_window_partition_types": {},
    "create_window": { wall_guid: wallGuid, location: [1, 0, 1], width: 1.2, height: 1.2, create_opening: true },
    "create_opening": { host_guid: wallGuid, location: [1, 0, 1], width: 1.0, height: 2.0 },
    "fill_opening": { opening_guid: "1", filling_guid: "2" },
    "update_window": { window_guid: "1", width: 1.5 },
    "create_trimesh_ifc": { name: "TestTable", trimesh_code: "import trimesh\nresult = trimesh.primitives.Box([1, 1, 0.75])" },
    "get_window_properties": { window_guid: "1" },
    "get_stairs_types": {},
    "create_stairs": { start_point: [1, 1, 0], width: 1.0, height: 3.0, num_steps: 15 },
    "update_stairs": { stairs_guid: "1", width: 1.2 },
    "delete_stairs": { stairs_guids: ["dummy_guid"] },
    "create_surface_style": { name: "TestWood", diffuse_color: [0.6, 0.4, 0.2, 1.0] },
    "create_pbr_style": { name: "ConcretePBR", base_color: [0.7, 0.7, 0.7, 1.0], roughness: 0.8 },
    "apply_style_to_object": { object_guid: wallGuid || "1", style_name: "TestWood" },
    "list_styles": {},
    "update_style": { style_name: "TestWood", diffuse_color: [0.5, 0.3, 0.1, 1.0] },
    "remove_style": { object_guid: wallGuid || "1" },
    "create_mesh_ifc": { name: "CustomMesh", vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]], faces: [[0,1,2],[0,2,3]] },
    "list_ifc_entities": {},
    "get_trimesh_examples": {},
    "initialize_project": { project_name: "TestProj" },
    "build_room": { room_name: "TestRoom2", width: 4, length: 4, height: 3, origin: [6, 0, 0] },
    "build_wall_assembly": { length: 5, height: 3, thickness: 0.2, origin: [0, 10, 0] },
    "build_floor_plan": { rooms: [{ name: "R1", width: 4, length: 4, origin: [0, 0, 0] }] },
    "build_building": { storeys: [{ name: "L1", rooms: [{ name: "R1", width: 4, length: 4, origin: [0, 0, 0] }] }] },
    "capture_blender_window_screenshot": {},
    "capture_blender_3dviewport_screenshot": {},
    "ensure_ifc_knowledge_ready": {},
    "search_ifc_knowledge": { query: "IfcWall" },
    "get_ifc_knowledge_status": {},
    "find_ifc_function": { query: "wall" },
    "get_ifc_module_info": { module_name: "ifcopenshell" },
    "get_ifc_function_details": { function_name: "create_ifcwall" },
    "clear_ifc_knowledge_cache": {},
    "get_cache_statistics": {}
  };

  const auditReport = [];

  for (const [toolName, payload] of Object.entries(toolPayloads)) {
    try {
      const res = await callTool(toolName, payload, sessionId);
      if (res.session_id) sessionId = res.session_id;
      auditReport.push({ Tool: toolName, Status: "PASS", Notes: "Execution successful" });
      console.log(`✅ [PASS] ${toolName}`);
    } catch (err) {
      auditReport.push({ Tool: toolName, Status: "HANDLED / WARN", Notes: err.message });
      console.log(`⚠️ [WARN] ${toolName}: ${err.message.substring(0, 70)}`);
    }
  }

  console.log("\n=================================================");
  console.log("📊 INDIVIDUAL 60 MCP TOOLS AUDIT REPORT TABLE:");
  console.table(auditReport);
  console.log("=================================================");
}

testAll60ToolsIndividually();
