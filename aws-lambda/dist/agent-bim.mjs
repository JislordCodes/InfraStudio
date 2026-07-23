// ../supabase/functions/_shared/shared.ts
var MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function extractText(content) {
  if (!content) return void 0;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (Array.isArray(item)) {
        const r = extractText(item);
        if (r) return r;
      } else if (typeof item === "object" && item !== null) {
        const o = item;
        if (typeof o.text === "string") return o.text;
      }
    }
  }
  return void 0;
}
async function mcpPost(body, clientSessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (clientSessionId) headers["mcp-session-id"] = clientSessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const returnedSession = res.headers.get("mcp-session-id") || clientSessionId;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find((l2) => l2.startsWith("data:"));
    const data = l ? JSON.parse(l.slice(5).trim()) : {};
    return { data, session: returnedSession };
  }
  try {
    return { data: JSON.parse(text), session: returnedSession };
  } catch {
    return { data: { raw: text }, session: returnedSession };
  }
}
async function mcpInit(clientSessionId) {
  const res1 = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "9.0" } }
  }, clientSessionId);
  const newSession = res1.session;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, newSession).catch(() => {
  });
  return newSession;
}
async function mcpCallTool(name, args, clientSessionId) {
  const res = await mcpPost({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args }
  }, clientSessionId);
  const payload = res.data;
  if (payload.error) {
    throw new Error(`Tool ${name} failed: ${JSON.stringify(payload.error)}`);
  }
  if (!payload.result && payload.raw) {
    throw new Error(`Tool ${name} returned invalid response from server: ${payload.raw}`);
  }
  const resultText = extractText(payload?.result?.content) || JSON.stringify(payload?.result ?? "done");
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object") {
      if (parsed.success === false || parsed.error) {
        throw new Error(`Tool ${name} reported failure: ${parsed.error || JSON.stringify(parsed)}`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Tool ")) throw e;
  }
  return { resultText, session: res.session };
}
async function fetchMcpTools(clientSessionId) {
  const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, clientSessionId);
  const data = res.data;
  const tools = data?.result?.tools || [];
  return {
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: (t.description || "").slice(0, 256),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}
async function callGLM(systemPrompt, userMessage, tools, model = "glm-5.1") {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];
  const targetModel = model === "glm-5.1" ? "qwen-plus" : model;
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages: msgs,
      tools: tools && tools.length > 0 ? tools : void 0,
      temperature: 0.1,
      max_tokens: 8e3
    })
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      if (targetModel === "qwen-plus") return await callGLM(systemPrompt, userMessage, tools, "qwen-turbo");
    }
    throw new Error(`GLM Error: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// ../supabase/functions/agent-bim/index.ts
var MUTATION_TOOLS = /* @__PURE__ */ new Set([
  "build_room",
  "build_wall_assembly",
  "build_floor_plan",
  "create_wall",
  "create_two_point_wall",
  "create_polyline_walls",
  "update_wall",
  "create_slab",
  "update_slab",
  "create_door",
  "update_door",
  "create_window",
  "update_window",
  "create_roof",
  "update_roof",
  "delete_roof",
  "create_stairs",
  "update_stairs",
  "delete_stairs",
  "create_trimesh_ifc",
  "create_mesh_ifc",
  "execute_ifc_code_tool",
  "create_surface_style",
  "create_pbr_style",
  "apply_style_to_object",
  "update_style",
  "remove_style"
]);
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function literal(value) {
  return JSON.stringify(String(value ?? ""));
}
function guidsByClass(scene) {
  const grouped = {};
  for (const obj of scene?.objects || []) {
    if (!obj?.guid || !obj?.ifc_class) continue;
    const cls = String(obj.ifc_class);
    grouped[cls] = grouped[cls] || [];
    grouped[cls].push(String(obj.guid));
  }
  return grouped;
}
async function applyDefaultMaterials(mcpSessionId) {
  let session = mcpSessionId;
  const errors = [];
  const summary = {};
  const sceneRes = await mcpCallTool("get_scene_info", { limit: -1, include_bbox: false, include_transform: false }, session);
  session = sceneRes.session;
  const scene = parseJson(sceneRes.resultText);
  const byClass = guidsByClass(scene);
  const styleRun = Date.now();
  const styles = [
    {
      name: `InfraStudio_Plaster_${styleRun}`,
      color: [0.86, 0.84, 0.78],
      transparency: 0,
      classes: ["IfcWall", "IfcWallStandardCase"]
    },
    {
      name: `InfraStudio_ConcreteFloor_${styleRun}`,
      color: [0.48, 0.48, 0.46],
      transparency: 0,
      classes: ["IfcSlab", "IfcRoof"]
    },
    {
      name: `InfraStudio_WoodDoor_${styleRun}`,
      color: [0.45, 0.28, 0.14],
      transparency: 0,
      classes: ["IfcDoor"]
    },
    {
      name: `InfraStudio_Glass_${styleRun}`,
      color: [0.62, 0.82, 0.92],
      transparency: 0.55,
      classes: ["IfcWindow"]
    },
    {
      name: `InfraStudio_StairConcrete_${styleRun}`,
      color: [0.58, 0.58, 0.56],
      transparency: 0,
      classes: ["IfcStair", "IfcStairFlight"]
    }
  ];
  for (const style of styles) {
    const targetGuids = style.classes.flatMap((cls) => byClass[cls] || []);
    summary[style.name] = targetGuids.length;
    if (targetGuids.length === 0) continue;
    try {
      const created = await mcpCallTool("create_surface_style", {
        name: style.name,
        color: style.color,
        transparency: style.transparency,
        style_type: "rendering"
      }, session);
      session = created.session;
      const applied = await mcpCallTool("apply_style_to_object", {
        object_guids: targetGuids,
        style_name: style.name
      }, session);
      session = applied.session;
    } catch (err) {
      errors.push(`${style.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { session, summary, errors };
}
async function exportWithMaterials(mcpSessionId) {
  const materialResult = await applyDefaultMaterials(mcpSessionId);
  let session = materialResult.session;
  const exportRes = await mcpCallTool("export_ifc", {}, session);
  session = exportRes.session;
  const exportData = parseJson(exportRes.resultText) || {};
  return {
    ifc_url: exportData.file_url || exportData.ifc_url || "",
    mcpSessionId: session,
    materialResult,
    rawData: exportData
  };
}
async function handleBim(payload) {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");
  if (payload.action === "initialize") {
    const res = await mcpCallTool("initialize_project", { project_name: payload.projectName || "InfraStudio AI Building" }, mcpSessionId);
    mcpSessionId = res.session;
    return { status: "success", mcpSessionId };
  }
  if (payload.action === "create_storey") {
    const name = payload.name || "Storey";
    const elevation = Number(payload.elevation || 0);
    const code = `
import ifcopenshell.api as api
ifc_file = get_ifc_file()
buildings = ifc_file.by_type("IfcBuilding")
if buildings:
    building = buildings[0]
    storey = api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name=${literal(name)})
    api.run("geometry.edit_object_placement", ifc_file, product=storey, matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,${elevation},1]])
    api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])
    save_and_load_ifc()
`;
    const res = await mcpCallTool("execute_ifc_code_tool", { code }, mcpSessionId);
    mcpSessionId = res.session;
    return { status: "success", mcpSessionId };
  }
  if (payload.action === "build_room") {
    const room = payload.room || {};
    const buildRes = await mcpCallTool("build_room", {
      room_name: room.name,
      width: room.width || 4,
      length: room.length || 4,
      height: payload.storeyHeight || room.height || 3,
      wall_thickness: room.wall_thickness || 0.2,
      origin: room.origin || [0, 0, 0],
      floor_slab: true,
      ceiling_slab: true,
      doors: room.doors || [],
      windows: room.windows || []
    }, mcpSessionId);
    mcpSessionId = buildRes.session;
    return { status: "success", result: buildRes, mcpSessionId };
  }
  if (payload.action === "deduplicate_walls") {
    const dedupeCode = `
import bpy
import mathutils
import json
import ifcopenshell
import ifcopenshell.api as api

ifc_file = None
try:
    import tool
    ifc_file = tool.Ifc.get()
except:
    try:
        import blenderbim.tool as tool
        ifc_file = tool.Ifc.get()
    except:
        ifc_file = None

def get_wall_bbox(obj):
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

walls = [o for o in bpy.data.objects if o.type == 'MESH' and 'Wall' in o.name]
to_remove = []

for i in range(len(walls)):
    if walls[i] in to_remove:
        continue
    for j in range(i+1, len(walls)):
        if walls[j] in to_remove:
            continue
        a = get_wall_bbox(walls[i])
        b = get_wall_bbox(walls[j])
        
        ox = max(0, min(a[3], b[3]) - max(a[0], b[0]))
        oy = max(0, min(a[4], b[4]) - max(a[1], b[1]))
        oz = max(0, min(a[5], b[5]) - max(a[2], b[2]))
        overlap_vol = ox * oy * oz
        
        vol_a = (a[3]-a[0]) * (a[4]-a[1]) * (a[5]-a[2])
        vol_b = (b[3]-b[0]) * (b[4]-b[1]) * (b[5]-b[2])
        min_vol = min(vol_a, vol_b)
        
        if min_vol > 0 and overlap_vol / min_vol > 0.5:
            to_remove.append(walls[j])

removed_names = []
for obj in to_remove:
    removed_names.append(obj.name)
    element = None
    if tool:
        try: element = tool.Ifc.get_entity(obj)
        except: pass

    if element and ifc_file:
        try:
            api.run('root.remove_product', ifc_file, product=element)
        except Exception as e:
            try: ifc_file.remove(element)
            except: pass

    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh and mesh.users == 0:
        bpy.data.meshes.remove(mesh)

if removed_names:
    try:
        if tool and hasattr(tool.Ifc, 'save'):
            tool.Ifc.save()
    except Exception as e:
        print("save warning:", str(e))

print("DEDUP_RESULT:" + json.dumps({"removed": removed_names, "count": len(removed_names)}))
`;
    const res = await mcpCallTool("execute_blender_code", { code: dedupeCode }, mcpSessionId);
    mcpSessionId = res.session;
    let removed = 0;
    try {
      const match = res.resultText.match(/DEDUP_RESULT:(\{[\s\S]*?\})/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        removed = parsed.count || 0;
      }
    } catch {
    }
    return { status: "success", removed, mcpSessionId };
  }
  if (payload.action === "apply_materials") {
    const materialResult = await applyDefaultMaterials(mcpSessionId);
    mcpSessionId = materialResult.session;
    return { status: "success", materialResult, mcpSessionId };
  }
  if (payload.action === "create_roof") {
    const rawType = (payload.roof_type || "flat").toUpperCase();
    let roof_type = "FLAT";
    if (rawType.includes("GABLE")) roof_type = "GABLE_ROOF";
    else if (rawType.includes("HIP")) roof_type = "HIP_ROOF";
    else if (rawType.includes("SHED")) roof_type = "SHED";
    const bbox = payload.bbox || { minX: 0, minY: 0, maxX: 6, maxY: 6, height: 3 };
    const overhang = 0.4;
    const x0 = Number(bbox.minX) - overhang;
    const x1 = Number(bbox.maxX) + overhang;
    const y0 = Number(bbox.minY) - overhang;
    const y1 = Number(bbox.maxY) + overhang;
    const z = Number(bbox.height || 3);
    const polyline = [
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
      [x0, y1, z]
    ];
    const buildRes = await mcpCallTool("create_roof", {
      polyline,
      roof_type,
      angle: roof_type === "GABLE_ROOF" || roof_type === "HIP_ROOF" ? 35 : 0,
      thickness: 0.3
    }, mcpSessionId).catch((err) => {
      console.error("create_roof execution error:", err);
      return null;
    });
    if (buildRes) mcpSessionId = buildRes.session;
    return { status: "success", mcpSessionId };
  }
  if (payload.action === "dynamic_edit") {
    const plan = payload.plan;
    const toolFetch = await fetchMcpTools(mcpSessionId);
    mcpSessionId = toolFetch.session;
    const availableTools = toolFetch.tools;
    const routedTools = availableTools;
    const sceneRes = await mcpCallTool("get_scene_info", {
      limit: -1,
      include_bbox: true,
      include_transform: true,
      round_decimals: 3
    }, mcpSessionId);
    mcpSessionId = sceneRes.session;
    const overviewRes = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId).catch(() => null);
    if (overviewRes) mcpSessionId = overviewRes.session;
    const glmPrompt = `You are the BIM MCP Execution Agent for InfraStudio.
Your sole job is to call real MCP tools to perform the requested edit or creation on the active IFC model.

Rules for Edits:
 1. Look at "Current IFC Scene State" and "IFC Overview" to find target GlobalId (GUID) values for existing walls, slabs, storeys, or elements. Never invent fake GUIDs.
 2. To add a door or window: Call create_door or create_window, setting wall_guid to the target wall's GlobalId, and ALWAYS set "create_opening": true.
 3. To change materials: Call create_surface_style or create_pbr_style, then call apply_style_to_object with the target entity's GlobalId.
 4. To add a roof: Call create_roof on the top storey or host walls.
 5. To add stairs: Call create_stairs between storeys.
 6. To add custom objects or furniture: Call create_trimesh_ifc or build_room.
 7. Output ONLY tool calls. Do not return empty tool calls. At least one mutation tool must be called.`;
    const basePlanData = `Instructions: ${JSON.stringify(plan)}

Current IFC Scene State:
${sceneRes.resultText}

IFC Overview:
${overviewRes?.resultText || "Unavailable"}`;
    let ifc_url = "";
    let executionError = "";
    let executedMutation = false;
    const executedTools = [];
    for (let tryNum = 1; tryNum <= 3; tryNum++) {
      let currentPlanData = basePlanData;
      if (executionError) {
        currentPlanData += `

PREVIOUS EXECUTION FAILED:
${executionError}
Retry with concrete mutation tool calls.`;
        executionError = "";
      }
      const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools, "glm-5.1");
      const toolCalls = glmMsg.tool_calls || [];
      if (toolCalls.length === 0) {
        executionError = "No tool calls were produced.";
        if (tryNum === 3) throw new Error(executionError);
        continue;
      }
      try {
        for (const call of toolCalls) {
          const toolName = call.function.name;
          const args = JSON.parse(call.function.arguments || "{}");
          const toolRes = await mcpCallTool(toolName, args, mcpSessionId);
          mcpSessionId = toolRes.session;
          executedTools.push(toolName);
          if (MUTATION_TOOLS.has(toolName) && toolName !== "export_ifc") {
            executedMutation = true;
          }
        }
        if (!executedMutation) {
          throw new Error("The model was not edited because no mutation tool was executed.");
        }
        break;
      } catch (err) {
        executionError = err.message || String(err);
        if (tryNum === 3) throw err;
      }
    }
    const exported = await exportWithMaterials(mcpSessionId);
    ifc_url = exported.ifc_url;
    mcpSessionId = exported.mcpSessionId;
    return {
      status: "success",
      ifc_url,
      mcpSessionId,
      executedTools,
      materialResult: exported.materialResult
    };
  }
  if (payload.action === "export") {
    const exported = await exportWithMaterials(mcpSessionId);
    return { status: "success", ...exported };
  }
  throw new Error("Invalid action");
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleBim(payload);
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  });
}
export {
  handleBim
};
