import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════
interface Opening { type: "door" | "window"; name: string; width: number; height: number; offset: number; sill_height?: number; }
interface ElementStyle { name: string; color: [number, number, number]; transparency?: number; }
interface WallElement { type: "wall"; name: string; start: [number, number, number]; end: [number, number, number]; height: number; thickness: number; openings?: Opening[]; style?: ElementStyle; }
interface SlabElement { type: "slab"; name: string; outline: [number, number, number][]; thickness: number; style?: ElementStyle; }
interface RoofElement { type: "roof"; name: string; outline: [number, number, number][]; roof_type: string; angle: number; thickness: number; style?: ElementStyle; }
interface StairsElement { type: "stairs"; name: string; location: [number, number, number]; num_risers: number; riser_height: number; tread_depth: number; width: number; direction?: [number, number, number]; }
type BuildingElement = WallElement | SlabElement | RoofElement | StairsElement;
interface BuildingPlan { project_name: string; description: string; elements: BuildingElement[]; }
interface PlanResponse { type: "chat" | "building"; reply?: string; plan?: BuildingPlan; }

// ═══════════════════════════════════════════
// MCP CLIENT
// ═══════════════════════════════════════════
let mcpSessionId = "";
const debugLog: string[] = [];
function log(msg: string) { console.log(msg); debugLog.push(msg); }

function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (Array.isArray(item)) { const r = extractText(item); if (r) return r; }
      else if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
      }
    }
  }
  return undefined;
}

async function mcpPost(body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
  const s = res.headers.get("mcp-session-id"); if (s) mcpSessionId = s;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    return l ? JSON.parse(l.slice(5).trim()) : {};
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function mcpInit(): Promise<void> {
  await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "3.0" } } });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
  log("MCP ready");
}

async function mcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  log("CALL " + name + "(" + JSON.stringify(args).slice(0, 200) + ")");
  const res = await mcpPost({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) as Record<string, unknown>;
  const text = extractText((res?.result as Record<string, unknown>)?.content);
  if (text) {
    log("=> " + name + ": " + text.slice(0, 200));
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  if (res?.error) {
    const errMsg = JSON.stringify(res.error).slice(0, 200);
    log("ERR " + name + ": " + errMsg);
    return { success: false, error: errMsg };
  }
  return { raw: JSON.stringify(res?.result ?? "done") };
}

function getGuid(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) { if (typeof obj[k] === "string" && (obj[k] as string).length > 5) return obj[k] as string; }
  for (const k of ["result", "wall", "data"]) {
    const nested = obj[k] as Record<string, unknown> | undefined;
    if (nested) { for (const kk of keys) { if (typeof nested[kk] === "string") return nested[kk] as string; } }
  }
  return undefined;
}

// ═══════════════════════════════════════════
// RAG SERVICE - IFC Knowledge Fallback
// ═══════════════════════════════════════════
async function ragSearch(query: string): Promise<string> {
  try {
    const r = await mcpTool("search_ifc_knowledge", { query, max_results: 3 });
    if (r.status === "not_ready") {
      log("RAG not ready, trying init...");
      await mcpTool("ensure_ifc_knowledge_ready", { timeout_seconds: 10 });
      const r2 = await mcpTool("search_ifc_knowledge", { query, max_results: 3 });
      return JSON.stringify(r2);
    }
    return JSON.stringify(r);
  } catch (e) {
    log("RAG unavailable: " + String(e).slice(0, 100));
    return "RAG unavailable";
  }
}

async function ragFindFunction(operation: string, objectType: string): Promise<string> {
  try {
    const r = await mcpTool("find_ifc_function", { operation, object_type: objectType });
    return JSON.stringify(r);
  } catch { return "RAG unavailable"; }
}

// ═══════════════════════════════════════════
// CODE EXECUTION - Universal Fallback
// ═══════════════════════════════════════════
async function execBlenderCode(code: string): Promise<Record<string, unknown>> {
  log("EXEC_CODE (" + code.length + " chars)");
  return await mcpTool("execute_blender_code", { code });
}

// Create opening in wall via native MCP tool
async function createOpening(
  wallGuid: string, width: number, height: number, depth: number,
  location: [number, number, number], name: string
): Promise<string | undefined> {
  const r = await mcpTool("create_opening", {
    wall_guid: wallGuid, width, height, depth, location, name, opening_type: "OPENING"
  });
  const guid = getGuid(r, "opening_guid", "guid");
  if (guid) return guid;
  log("WARN: Opening created but GUID not captured");
  return undefined;
}

// Fill opening with element via native MCP tool
async function fillOpening(openingGuid: string, elementGuid: string): Promise<boolean> {
  const r = await mcpTool("fill_opening", {
    opening_guid: openingGuid, element_guid: elementGuid
  });
  const raw = JSON.stringify(r);
  return raw.includes('"success": true') || raw.includes('"success":true');
}

// ═══════════════════════════════════════════
// PLANNER - Gemini with Full Tool Awareness
// ═══════════════════════════════════════════
const PLANNER_PROMPT = `You are a highly capable BIM Agent for InfraStudio.
You have access to 56 backend MCP tools via a single generic function: call_mcp_tool(tool_name, arguments)

Your Goal: Fulfill the user's design or query requests by actively chaining together tools.

HOW TO USE TOOLS:
- Always pass the EXACT tool name as "tool_name", and its parameters as a JSON object in "arguments".
- Example: to create a wall, call_mcp_tool("create_two_point_wall", { "start_point": [0,0,0], "end_point": [5,0,0], "height": 3, "thickness": 0.2, "name": "W1" })
- Wait for the result before making the next call. The system will process your call and hand you the result.
- ALWAYS use metric units (meters).
- If creating an opening, first use create_opening, get the opening_guid, then use create_door/create_window to get the element_guid, then fill_opening(opening_guid, element_guid).

AVAILABLE TOOLS:
--- CREATION ---
- initialize_project(project_name)
- create_wall(name, length, height, thickness, location, rotation)
- create_two_point_wall(name, start_point, end_point, height, thickness)
- create_polyline_walls(name, points, height, thickness)
- create_door(name, dimensions{width,height}, location, operation_type)
- create_window(name, dimensions{width,height}, location, partition_type)
- create_slab(name, outline_points, thickness)
- create_roof(name, polyline, roof_type, angle, thickness)
- create_stairs(name, location, num_risers, riser_height, tread_depth, width)
- create_mesh_ifc(vertices, faces, name)
- create_trimesh_ifc(vertices, faces, name, ifc_class)

--- OPENINGS ---
- create_opening(width, height, depth, location, wall_guid, opening_type, name)
- fill_opening(opening_guid, element_guid)

--- STYLES ---
- create_surface_style(name, color[r,g,b], transparency)
- create_pbr_style(name, diffuse_color[r,g,b], metallic, roughness)
- apply_style_to_object(object_guids, style_name)
- apply_style_to_material(material_name, style_name)
- list_styles()
- update_style(style_name, ...)
- remove_style(style_name)

--- QUERY & UPDATE ---
- get_scene_info()
- get_ifc_scene_overview()
- get_blender_object_info(object_name)
- get_selected_objects()
- get_object_info(object_name)
- get_wall_properties(wall_guid) / update_wall(wall_guid, ...)
- get_door_properties(door_guid) / update_door(door_guid, ...)
- get_window_properties(window_guid) / update_window(window_guid, ...)
- get_slab_properties(slab_guid) / update_slab(slab_guid, ...)
- get_door_operation_types() / get_window_partition_types() / get_stairs_types() / get_roof_types()
- list_ifc_entities(ifc_class)
- delete_stairs(stairs_guids) / delete_roof(...)

--- RAG / KNOWLEDGE ---
- search_ifc_knowledge(query, max_results)
- find_ifc_function(operation, object_type)
- get_ifc_function_details(function_name)
- get_ifc_module_info(module_name)

--- FALLBACK CODE EXECUTION ---
- execute_blender_code(code) - Raw Python in Blender
- execute_ifc_code_tool(code) - IFC OpenShell context

CRITICAL RULES FOR YOU:
1. OPENINGS ALIGNMENT: 
   When creating an opening void in a wall via create_opening, you MUST use the exact SAME 'location' coordinates when subsequently calling create_door or create_window. If you create the door at [0,0,0] but the opening is at [2,0,0], the door will not fit! Compute the 3D Math offset correctly.
2. STYLING:
   If the user asks for a specific color (like a 'red wall' or 'wooden surface'):
   a. Create the wall/object first.
   b. Call create_surface_style(name, color, transparency) with the [R,G,B] requested.
   c. Call apply_style_to_object(object_guids=[...], style_name) on the GUID!
   NOTE: apply_style_to_object ONLY works with IFC GUIDs (from create_wall, create_trimesh_ifc, etc.). It does NOT work on raw Blender object names!
3. STRICT VECTOR TYPES:
   Any argument named 'location', 'rotation', 'start_point', or 'end_point' MUST be an array of floats (e.g., [0.0, 0.0, 0.0]). NEVER pass a single scalar integer/float (e.g. rotation: 0), as it will trigger a validation crash in the MCP typed schema!
4. ROUTING LOGIC - READ THIS FIRST BEFORE CHOOSING TOOLS:
   
   SIMPLE REQUESTS (single element, e.g. "add a wall", "place a door"):
   Use individual tools: create_wall, create_door, create_window, create_slab, create_stairs, create_roof
   
   COMPLEX REQUESTS (buildings, structures, grids, multi-storey, anything with columns/beams/slabs together):
   MUST use execute_ifc_code_tool with ONE Python script. NEVER use individual tools for these.
   See Rule 6 below for the exact template.
   
   How to decide: If the request mentions ANY of these words, it is COMPLEX and MUST use execute_ifc_code_tool:
   "building", "storey", "floor", "column", "beam", "grid", "structure", "framework", "structural"

5. RAW BLENDER OBJECTS vs IFC ENTITIES:
   Objects created via execute_blender_code (bpy.ops) are RAW BLENDER OBJECTS. They will NEVER appear in the 3D viewer.
   The viewer ONLY renders IFC entities. NEVER use execute_blender_code to create visible geometry.
   
   
6. BUILDING STRUCTURES (columns, beams, slabs, multi-storey) - ABSOLUTELY CRITICAL:

   RULE A: ANY request involving columns, beams, grids, multi-storey, or structural systems MUST use execute_ifc_code_tool with a SINGLE Python script. NEVER use individual tool calls (create_wall, create_slab, etc.) for these.

   RULE B: NEVER use create_wall to make columns or beams. Columns are IfcColumn. Beams are IfcBeam. Walls are IfcWall. Using the wrong IFC class produces broken geometry.

   RULE C: If execute_ifc_code_tool fails, DO NOT fall back to individual tools. Instead, fix the script and try execute_ifc_code_tool again.

   RULE D: NEVER create a new ifcopenshell.file(). NEVER create IfcProject, IfcSite, or IfcBuilding - they already exist.

   RULE E: The functions get_ifc_file(), get_or_create_body_context(), save_and_load_ifc() are PRE-INJECTED into the sandbox. Call them directly. No import from blender_addon needed.

   RULE F: ALWAYS use geometry.add_wall_representation for ANY box geometry (columns, beams, slabs). It creates a solid 3D box. Parameters: length, thickness, height.
   - Column 0.3x0.3x3.5m: length=0.3, thickness=0.3, height=3.5
   - Slab 15x15x0.25m: length=15.0, thickness=15.0, height=0.25
   - Beam 5x0.3x0.4m: length=5.0, thickness=0.3, height=0.4

   RULE G: ALWAYS call save_and_load_ifc() exactly ONCE at the very end. Never in the middle.

   RULE H: For slabs, ALWAYS define proper dimensions. Never leave polyline or dimensions as None.

   PYTHON SCRIPT TEMPLATE (follow this exactly):
   import ifcopenshell.api as api

   ifc_file = get_ifc_file()
   body_ctx = get_or_create_body_context(ifc_file)
   building = ifc_file.by_type("IfcBuilding")[0]

   storey = api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name="Ground Floor")
   api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])

   for x in range(3):
       for y in range(3):
           col = api.run("root.create_entity", ifc_file, ifc_class="IfcColumn", name=f"Col_{x}_{y}")
           api.run("spatial.assign_container", ifc_file, products=[col], relating_structure=storey)
           rep = api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=0.3, thickness=0.3, height=3.5)
           api.run("geometry.assign_representation", ifc_file, product=col, representation=rep)
           api.run("geometry.edit_object_placement", ifc_file, product=col, matrix=[[1.0,0.0,0.0,0.0],[0.0,1.0,0.0,0.0],[0.0,0.0,1.0,0.0],[float(x*5.0), float(y*5.0), 0.0, 1.0]])

   ground_slab = api.run("root.create_entity", ifc_file, ifc_class="IfcSlab", name="Ground Slab")
   api.run("spatial.assign_container", ifc_file, products=[ground_slab], relating_structure=storey)
   slab_rep = api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=10.0, thickness=10.0, height=0.25)
   api.run("geometry.assign_representation", ifc_file, product=ground_slab, representation=slab_rep)
   api.run("geometry.edit_object_placement", ifc_file, product=ground_slab, matrix=[[1.0,0.0,0.0,0.0],[0.0,1.0,0.0,0.0],[0.0,0.0,1.0,0.0],[0.0, 0.0, 0.0, 1.0]])

   roof_slab = api.run("root.create_entity", ifc_file, ifc_class="IfcSlab", name="Roof Slab")
   api.run("spatial.assign_container", ifc_file, products=[roof_slab], relating_structure=storey)
   roof_rep = api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=10.0, thickness=10.0, height=0.25)
   api.run("geometry.assign_representation", ifc_file, product=roof_slab, representation=roof_rep)
   api.run("geometry.edit_object_placement", ifc_file, product=roof_slab, matrix=[[1.0,0.0,0.0,0.0],[0.0,1.0,0.0,0.0],[0.0,0.0,1.0,0.0],[0.0, 0.0, 3.5, 1.0]])

   save_and_load_ifc()
   END OF TEMPLATE

WHEN TO STOP:
Once you have executed all necessary tool calls and completed the user's intent, return a final text response explaining what you did. Do NOT return text if you are still building.`;

// Define the generic tool for Gemini
const GEMINI_TOOLS = [{
  functionDeclarations: [{
    name: "call_mcp_tool",
    description: "Call an MCP backend tool by its name. Use this to create or query BIM objects, run RAG, etc. It returns the raw result.",
    parameters: {
      type: "OBJECT",
      properties: {
        tool_name: { type: "STRING", description: "The exact name of the tool (e.g. create_two_point_wall)" },
        arguments: { type: "OBJECT", description: "A JSON object of arguments keyed by name." }
      },
      required: ["tool_name", "arguments"]
    }
  }]
}];

// ═══════════════════════════════════════════
// AGENT EXECUTION LOOP
// ═══════════════════════════════════════════
async function executeAgentLoop(history: any[]): Promise<{ reply: string; steps: string[]; hasChanges: boolean }> {
  const steps: string[] = [];
  let modelHistory = [...history];
  let loopCount = 0;
  let hasChanges = false;
  
  while (loopCount < 100) {
    loopCount++;
    log(`--- Agent Turn ${loopCount} ---`);
    
    const res = await fetch(GEMINI_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PLANNER_PROMPT }] },
        contents: modelHistory,
        tools: GEMINI_TOOLS,
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    
    if (!res.ok) throw new Error(`Gemini API Error: ${res.status}`);
    const json = await res.json();
    const candidate = json?.candidates?.[0];
    if (!candidate || !candidate.content) break;
    
    modelHistory.push(candidate.content);
    
    const parts = candidate.content.parts || [];
    const textPart = parts.find((p: any) => p.text);
    const fnCallPart = parts.find((p: any) => p.functionCall);
    
    if (fnCallPart && fnCallPart.functionCall) {
      const call = fnCallPart.functionCall;
      log(`AI Wants to call: ${call.name}`);
      
      let callResult: any;
      if (call.name === "call_mcp_tool") {
        const tName = call.args?.tool_name?.toString() || "unknown";
        const tArgs = call.args?.arguments || {};
        
        try {
          const mRes = await mcpTool(tName, tArgs);
          callResult = mRes;
          
          if (mRes.success === false || mRes.error) {
            steps.push(`✗ Failed: ${tName}`);
          } else {
            steps.push(`✓ Used: ${tName}`);
            if (tName.startsWith("create_") || tName.startsWith("update_") || tName.startsWith("delete_") || tName.startsWith("apply_") || tName.startsWith("fill_") || tName.startsWith("initialize_")) {
              hasChanges = true;
            }
          }
        } catch(e) {
          log(`Tool Execution Error: ${e}`);
          callResult = { success: false, error: String(e) };
          steps.push(`✗ Error: ${tName}`);
        }
      } else {
        callResult = { error: "Unknown function" };
      }
      
      modelHistory.push({
        role: "function",
        parts: [{
          functionResponse: {
            name: call.name,
            response: callResult
          }
        }]
      });
      continue;
    }
    
    if (textPart && textPart.text) {
      log(`Final AI Answer: ${textPart.text.substring(0, 100)}...`);
      return { reply: textPart.text, steps, hasChanges };
    }
    
    break;
  }
  
  return { reply: "I completed my logic loop but did not return a final text response.", steps, hasChanges };
}

// ═══════════════════════════════════════════
// HTTP HANDLER
// ═══════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!GEMINI_API_KEY) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  debugLog.length = 0;
  mcpSessionId = "";
  try {
    const payloadMsgs = (await req.json() as any).messages || [];
    if (!payloadMsgs.length) return new Response(JSON.stringify({ error: "No messages" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    
    // Convert incoming [role: user/assistant] payload into Gemini [role: user/model] history
    const history = payloadMsgs.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }]
    }));

    await mcpInit();

    const result = await executeAgentLoop(history);

    let ifc_url: string | undefined;
    if (result.hasChanges) {
      try {
        log("Changes detected, exporting IFC...");
        const ex = await mcpTool("export_ifc", { session_id: mcpSessionId || "default" });
        if ((ex as any).success && (ex as any).file_url) {
          ifc_url = (ex as any).file_url as string;
          log("Export success");
        }
      } catch (e) { log("Export err: " + e); }
    }

    const body: Record<string, unknown> = { reply: result.reply, steps: result.steps, debug: debugLog };
    if (ifc_url) body.ifc_url = ifc_url;
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    log("FATAL: " + err);
    return new Response(JSON.stringify({ error: String(err).slice(0, 400), debug: debugLog }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
