import { fetch as uFetch, Agent, setGlobalDispatcher } from "undici";
import * as fs from "fs";

const localAgent = new Agent({ headersTimeout: 900000, bodyTimeout: 900000, connectTimeout: 60000 });
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function callTool(name, args, sid) {
  const res = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "call_tool", name, args, session_id: sid })
  });
  if (!res.ok) throw new Error(`Tool ${name} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log("=== DEDUP DEBUG TEST ===\n");

  // Init & build 2 adjacent rooms
  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  await callTool("initialize_project", { project_name: "Dedup Debug" }, sid);
  console.log("✓ Project initialized");

  await callTool("build_room", {
    room_name: "RoomA", width: 4, length: 4, height: 3,
    wall_thickness: 0.25, origin: [0, 0, 0], floor_slab: true, ceiling_slab: true
  }, sid);
  console.log("✓ RoomA (0,0) 4x4m");

  await callTool("build_room", {
    room_name: "RoomB", width: 4, length: 4, height: 3,
    wall_thickness: 0.25, origin: [4, 0, 0], floor_slab: true, ceiling_slab: true
  }, sid);
  console.log("✓ RoomB (4,0) 4x4m — shares east wall with RoomA\n");

  // Step 1: Check what walls exist and their bboxes
  console.log("=== STEP 1: Query walls via execute_blender_code ===");
  const bboxRes = await callTool("execute_blender_code", {
    code: `
import bpy, json, mathutils
results = []
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    results.append({
        "name": obj.name,
        "type": obj.type,
        "min": [round(min(xs),3), round(min(ys),3), round(min(zs),3)],
        "max": [round(max(xs),3), round(max(ys),3), round(max(zs),3)]
    })
results.sort(key=lambda r: r["name"])
print("ALL_OBJECTS:" + json.dumps(results))
print("WALL_COUNT:" + str(len([r for r in results if 'Wall' in r['name']])))
`
  }, sid);

  console.log("Raw result (first 2000 chars):");
  const resultText = typeof bboxRes.result === 'string' ? bboxRes.result : JSON.stringify(bboxRes.result);
  console.log(resultText.substring(0, 2000));
  console.log("\n");

  // Step 2: Now try IFC approach - list all IfcWall entities
  console.log("=== STEP 2: Query IfcWall entities via execute_ifc_code_tool ===");
  const ifcRes = await callTool("execute_ifc_code_tool", {
    code: `
import json
ifc_file = get_ifc_file()
walls = ifc_file.by_type("IfcWall")
result = []
for w in walls:
    placement = None
    try:
        if w.ObjectPlacement and w.ObjectPlacement.RelativePlacement:
            loc = w.ObjectPlacement.RelativePlacement.Location
            if loc:
                placement = [loc.Coordinates[0], loc.Coordinates[1], loc.Coordinates[2]]
    except:
        pass
    result.append({"id": w.id(), "global_id": w.GlobalId, "name": w.Name, "placement": placement})
print("IFC_WALLS:" + json.dumps(result))
`
  }, sid);

  console.log("IFC Wall entities:");
  const ifcResultText = typeof ifcRes.result === 'string' ? ifcRes.result : JSON.stringify(ifcRes.result);
  console.log(ifcResultText.substring(0, 2000));
  console.log("\n");

  // Step 3: Try deleting duplicate wall directly 
  console.log("=== STEP 3: Try direct IFC deletion of RoomB_Wall_West (should overlap RoomA_Wall_East) ===");
  const deleteRes = await callTool("execute_ifc_code_tool", {
    code: `
import ifcopenshell.api as api
import json

ifc_file = get_ifc_file()
walls = ifc_file.by_type("IfcWall")
target_name = "RoomB_Wall_West"
removed = []
errors = []

for w in walls:
    if w.Name == target_name:
        try:
            api.run("root.remove_product", ifc_file, product=w)
            removed.append(w.Name)
        except Exception as e:
            errors.append(str(e))
            # Try alternative delete
            try:
                ifc_file.remove(w)
                removed.append(w.Name + " (direct)")
            except Exception as e2:
                errors.append(str(e2))

if removed:
    save_and_load_ifc()

print("DELETE_RESULT:" + json.dumps({"removed": removed, "errors": errors}))
`
  }, sid);

  console.log("Delete result:");
  const deleteResultText = typeof deleteRes.result === 'string' ? deleteRes.result : JSON.stringify(deleteRes.result);
  console.log(deleteResultText.substring(0, 1000));

  // Step 4: Check wall count after deletion
  console.log("\n=== STEP 4: Verify wall count after deletion ===");
  const verifyRes = await callTool("execute_ifc_code_tool", {
    code: `
ifc_file = get_ifc_file()
walls = ifc_file.by_type("IfcWall")
print(f"WALL_COUNT_AFTER: {len(walls)}")
for w in walls:
    print(f"  {w.Name} (id={w.id()})")
`
  }, sid);
  const verifyText = typeof verifyRes.result === 'string' ? verifyRes.result : JSON.stringify(verifyRes.result);
  console.log(verifyText);

  console.log("\n=== DEDUP DEBUG COMPLETE ===");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
