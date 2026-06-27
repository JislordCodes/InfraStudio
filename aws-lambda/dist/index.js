var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);

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
async function callQwen(systemPrompt4, userMessage, jsonMode = false, model = "qwen-max") {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  let msgs = [{ role: "system", content: systemPrompt4 }];
  if (Array.isArray(userMessage)) {
    msgs = msgs.concat(userMessage.map((m) => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: msgs,
      temperature: 0.1,
      max_tokens: 2e3,
      response_format: jsonMode ? { type: "json_object" } : void 0
    })
  });
  if (!res.ok) throw new Error(`Qwen Error: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content || "";
}
async function callGLM(systemPrompt4, userMessage, tools, model = "glm-5.1") {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  const msgs = [
    { role: "system", content: systemPrompt4 },
    { role: "user", content: userMessage }
  ];
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: msgs,
      temperature: 0.1,
      max_tokens: 2e3,
      tools: tools && tools.length > 0 ? tools : void 0
    })
  });
  if (!res.ok) throw new Error(`GLM Error: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}
function cleanJsonResponse(rawStr) {
  let clean = rawStr.trim();
  if (clean.includes("```")) {
    const startIdx = clean.indexOf("```");
    if (startIdx !== -1) {
      const newlineIdx = clean.indexOf("\n", startIdx);
      const contentStart = newlineIdx !== -1 ? newlineIdx + 1 : startIdx + 3;
      const endIdx = clean.indexOf("```", contentStart);
      if (endIdx !== -1) {
        clean = clean.substring(contentStart, endIdx);
      } else {
        clean = clean.substring(contentStart);
      }
    }
  }
  clean = clean.trim();
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(clean);
}

// ../supabase/functions/agent-interpreter/index.ts
var systemPrompt = `You are the Interpreter Agent.
Convert natural-language user intent into a structured architectural brief. 
Analyze the conversation history to determine if the user is asking to create a completely NEW building, or if they are asking to EDIT, CHANGE, or ADD to the existing building.
If it is an edit or modification, set "is_edit" to true and describe the changes in "edit_instructions".
Preserve material intent. If the user asks for a materially planned, realistic, premium, glass, timber, concrete, brick, painted, or similar design, include those requirements in material_requirements.
Must NOT: Generate geometry, create IFC entities.
Expected JSON Output:
{
  "is_edit": boolean,
  "project_type": "string",
  "storeys": [{"name": "string", "elevation": "number", "height": "number"}],
  "room_requirements": [{"name": "string", "suggested_area": "number"}],
  "material_requirements": ["string"],
  "edit_instructions": ["string"]
}`;
async function handleInterpreter(payload) {
  const messages = payload.messages || [];
  const res = await callQwen(systemPrompt, messages, true, "qwen3.7-plus");
  return cleanJsonResponse(res);
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleInterpreter(payload);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
}

// ../supabase/functions/agent-architect/index.ts
var systemPrompt2 = `You are the Architectural Reasoning Agent.
Return ONLY raw JSON. No markdown. No prose.

Mission: convert the brief into a compact, buildable BIM plan.

Spatial laws:
- Rooms are adjacent rectangles in a clean grid.
- Every room has at least one door.
- Main entry opens from exterior into Entry/Living/Circulation.
- Bedrooms/bathrooms connect through Entry/Living/Circulation, not through each other.
- Windows only on exterior walls.
- Keep openings at least 0.45m from wall ends.
- No overlapping doors/windows on the same wall.
- Max 4 rooms per storey unless explicitly requested.

Defaults:
- Height 3m.
- One-bed apartment: LivingKitchen 5x4, Bedroom 4x3.5, Bathroom 2.4x2.2, Entry 2x2.
- Studio: LivingSleeping 5x5, Bathroom 2.4x2.2.
- Door widths: entry 1.0, room 0.9, bathroom 0.8.
- Window widths: living 1.8, bedroom 1.5, bathroom 0.6.
- Wall names: south,east,north,west. offset = distance from wall start.

Materials:
- Always include material_palette with wall, floor, door, window_glass, roof_or_ceiling.

Edits:
- If is_edit=true, return storey_plans=[] and structural_notes with exact target object types and changes.

Silent self-check before output:
1. every room has a door
2. every window is exterior
3. openings do not overlap
4. circulation works
5. materials exist

JSON schema:
{
  "is_edit": boolean,
  "material_palette": {
    "wall": "string",
    "floor": "string",
    "door": "string",
    "window_glass": "string",
    "roof_or_ceiling": "string"
  },
  "storey_plans": [
    {
      "name": "string",
      "height": "number",
      "rooms": [
        {
          "name": "string",
          "width": "number",
          "length": "number",
          "origin": ["number", "number", "number"],
          "doors": [{"wall": "string", "offset": "number", "width": "number"}],
          "windows": [{"wall": "string", "offset": "number", "width": "number"}]
        }
      ]
    }
  ],
  "structural_notes": ["string"]
}`;
var WALLS = ["south", "east", "north", "west"];
function wallLength(room, wall) {
  return wall === "south" || wall === "north" ? Number(room.width || 4) : Number(room.length || 4);
}
function clampOpening(opening, room, defaultWidth) {
  const wall = WALLS.includes(String(opening.wall)) ? String(opening.wall) : "south";
  const width = Math.max(0.6, Math.min(Number(opening.width || defaultWidth), wallLength(room, wall) - 0.9));
  const maxOffset = Math.max(0.45, wallLength(room, wall) - width - 0.45);
  const offset = Math.max(0.45, Math.min(Number(opening.offset || 0.9), maxOffset));
  return { ...opening, wall, width, offset };
}
function rangesOverlap(a0, a1, b0, b1) {
  return Math.max(a0, b0) < Math.min(a1, b1) - 0.05;
}
function isInternalWall(room, wall, rooms) {
  const [x, y] = room.origin || [0, 0, 0];
  const w = Number(room.width || 4);
  const l = Number(room.length || 4);
  return rooms.some((other) => {
    if (other === room) return false;
    const [ox, oy] = other.origin || [0, 0, 0];
    const ow = Number(other.width || 4);
    const ol = Number(other.length || 4);
    if (wall === "south" && Math.abs(y - (oy + ol)) < 0.05) return rangesOverlap(x, x + w, ox, ox + ow);
    if (wall === "north" && Math.abs(y + l - oy) < 0.05) return rangesOverlap(x, x + w, ox, ox + ow);
    if (wall === "west" && Math.abs(x - (ox + ow)) < 0.05) return rangesOverlap(y, y + l, oy, oy + ol);
    if (wall === "east" && Math.abs(x + w - ox) < 0.05) return rangesOverlap(y, y + l, oy, oy + ol);
    return false;
  });
}
function pickDoorWall(room, rooms) {
  return WALLS.find((wall) => isInternalWall(room, wall, rooms)) || WALLS.find((wall) => !isInternalWall(room, wall, rooms)) || "south";
}
function openingsOverlap(a, b) {
  if (a.wall !== b.wall) return false;
  const a0 = Number(a.offset || 0);
  const a1 = a0 + Number(a.width || 0.9);
  const b0 = Number(b.offset || 0);
  const b1 = b0 + Number(b.width || 1.2);
  return rangesOverlap(a0, a1, b0, b1);
}
function repairPlan(plan) {
  if (!plan || plan.is_edit || !Array.isArray(plan.storey_plans)) return plan;
  for (const storey of plan.storey_plans) {
    const rooms = Array.isArray(storey.rooms) ? storey.rooms : [];
    for (const room of rooms) {
      room.width = Math.max(2.2, Number(room.width || 4));
      room.length = Math.max(2.2, Number(room.length || 4));
      room.origin = Array.isArray(room.origin) ? room.origin : [0, 0, 0];
      room.doors = (Array.isArray(room.doors) ? room.doors : []).map((door) => clampOpening(door, room, 0.9));
      room.windows = (Array.isArray(room.windows) ? room.windows : []).map((window) => clampOpening(window, room, 1.2)).filter((window) => !isInternalWall(room, String(window.wall), rooms));
      if (room.doors.length === 0) {
        const wall = pickDoorWall(room, rooms);
        room.doors.push(clampOpening({ wall, offset: wallLength(room, wall) / 2 - 0.45, width: 0.9, height: 2.1 }, room, 0.9));
      }
      room.windows = room.windows.filter((window) => !room.doors.some((door) => openingsOverlap(window, door)));
    }
    const hasExteriorDoor = rooms.some((room) => room.doors?.some((door) => !isInternalWall(room, String(door.wall), rooms)));
    if (!hasExteriorDoor && rooms.length > 0) {
      const target = rooms.find((room) => /living|entry|corridor|kitchen/i.test(String(room.name))) || rooms[0];
      const wall = WALLS.find((candidate) => !isInternalWall(target, candidate, rooms)) || "south";
      target.doors = target.doors || [];
      target.doors.push(clampOpening({ wall, offset: wallLength(target, wall) / 2 - 0.5, width: 1, height: 2.1 }, target, 1));
    }
  }
  plan.material_palette = plan.material_palette || {
    wall: "painted plaster over blockwork",
    floor: "polished concrete or porcelain tile",
    door: "warm wood veneer",
    window_glass: "clear low-e glass",
    roof_or_ceiling: "white gypsum ceiling"
  };
  return plan;
}
async function handleArchitect(brief) {
  let promptStr = JSON.stringify(brief);
  if (brief.reviewHistory) {
    promptStr += `

PREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(brief.reviewHistory)}`;
  }
  const res = await callQwen(systemPrompt2, promptStr, true, "qwen3.7-max-2026-06-08");
  return repairPlan(cleanJsonResponse(res));
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const brief = await req.json();
      const result = await handleArchitect(brief);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
}

// ../supabase/functions/agent-reviewer/index.ts
var systemPrompt3 = `You are the Quality Review Agent.
Inspect the generated IFC model overview and element counts.
Ensure the building contains expected structural elements (IfcWall, IfcSlab, IfcDoor, IfcWindow).
If the counts are missing or absurdly low (e.g. 0 walls), return FAIL.
Expected JSON Output:
{
  "status": "PASS" | "FAIL",
  "issues": ["string"],
  "fix_recommendations": ["string"],
  "retry_required": boolean
}`;
async function handleReviewer(payload) {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");
  const sceneInfo = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId);
  const res = await callQwen(systemPrompt3, JSON.stringify(sceneInfo.resultText), true, "qwen3.7-max-2026-06-08");
  const result = cleanJsonResponse(res);
  result.mcpSessionId = mcpSessionId;
  return result;
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleReviewer(payload);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
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
var CORE_EDIT_TOOLS = /* @__PURE__ */ new Set([
  "export_ifc",
  "get_scene_info",
  "get_ifc_scene_overview",
  "get_object_info",
  "list_styles",
  "create_surface_style",
  "create_pbr_style",
  "apply_style_to_object",
  "update_style",
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
  "execute_ifc_code_tool"
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
      doors: room.doors || [],
      windows: room.windows || []
    }, mcpSessionId);
    mcpSessionId = buildRes.session;
    return { status: "success", result: buildRes, mcpSessionId };
  }
  if (payload.action === "apply_materials") {
    const materialResult = await applyDefaultMaterials(mcpSessionId);
    mcpSessionId = materialResult.session;
    return { status: "success", materialResult, mcpSessionId };
  }
  if (payload.action === "dynamic_edit") {
    const plan = payload.plan;
    const toolFetch = await fetchMcpTools(mcpSessionId);
    mcpSessionId = toolFetch.session;
    const availableTools = toolFetch.tools;
    const availableByName = new Map(availableTools.map((tool) => [tool.function.name, tool]));
    const availableToolsList = availableTools.filter((tool) => !CORE_EDIT_TOOLS.has(tool.function.name)).map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join("\n");
    const qwenPrompt = `You are a Tool Retrieval Intelligence Layer. Extract extra tool names needed for this BIM edit plan. Plan: ${JSON.stringify(plan)} Available Tools: ${availableToolsList} RULES: Return ONLY a comma-separated list of tool names. If none, reply NONE.`;
    const extractedRaw = await callQwen(qwenPrompt, "Extract tools", false, "qwen3.7-plus").catch(() => "NONE");
    const needed = new Set(CORE_EDIT_TOOLS);
    if (extractedRaw && extractedRaw.trim() !== "NONE") {
      extractedRaw.split(",").map((s) => s.trim()).forEach((name) => {
        if (name) needed.add(name);
      });
    }
    const routedTools = [...needed].map((name) => availableByName.get(name)).filter(Boolean);
    const sceneRes = await mcpCallTool("get_scene_info", {
      limit: -1,
      include_bbox: true,
      include_transform: true,
      round_decimals: 3
    }, mcpSessionId);
    mcpSessionId = sceneRes.session;
    const overviewRes = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId).catch(() => null);
    if (overviewRes) mcpSessionId = overviewRes.session;
    const glmPrompt = `You are the BIM Executor for an existing IFC model.
You must perform real model mutations with the provided tools, then the system will export the IFC.
Rules:
1. Use exact GlobalId values from Current IFC Scene State. Never invent GUIDs.
2. For edits, call at least one mutation tool before export: update_*, create_*, delete_*, build_*, apply_style_to_object, update_style, or execute_ifc_code_tool.
3. If the user asks for material changes, create a style if needed and apply it to concrete target GUIDs.
4. If adding new rooms/elements, place them so they do not overlap existing bounding boxes.
5. If adding or moving doors/windows, keep openings on valid walls, away from corners, and do not overlap other openings.
6. Output only tool calls. No prose.`;
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
      const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools, "qwen3.7-plus");
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

// index.ts
var handler = async (event) => {
  const path = event.rawPath || "/";
  const method = event.requestContext?.http?.method || "POST";
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }
  let payload = {};
  if (event.body) {
    try {
      const decodedBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
      payload = JSON.parse(decodedBody);
    } catch (e) {
      console.error("Failed to parse request body:", e);
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON body" })
      };
    }
  }
  try {
    let result = null;
    const cleanPath = path.replace(/\/$/, "");
    if (cleanPath.endsWith("/agent-interpreter")) {
      result = await handleInterpreter(payload);
    } else if (cleanPath.endsWith("/agent-architect")) {
      result = await handleArchitect(payload);
    } else if (cleanPath.endsWith("/agent-reviewer")) {
      result = await handleReviewer(payload);
    } else if (cleanPath.endsWith("/agent-bim")) {
      result = await handleBim(payload);
    } else if (cleanPath.endsWith("/gemini-chat")) {
      if (payload.action === "init") {
        const initSession = await mcpInit(payload.session_id || "");
        const toolsResult = await fetchMcpTools(initSession);
        result = { tools: toolsResult.tools, session_id: toolsResult.session };
      } else if (payload.action === "call_tool") {
        let sId = payload.session_id;
        if (!sId) sId = await mcpInit("");
        const res = await mcpCallTool(payload.name, payload.args || {}, sId);
        result = { result: res.resultText, session_id: sId };
      } else {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid action for gemini-chat endpoint" })
        };
      }
    } else {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Path not found: ${path}` })
      };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error(`Error processing path ${path}:`, err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
