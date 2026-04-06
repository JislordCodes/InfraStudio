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
  await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "4.0" } } });
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

// ═══════════════════════════════════════════
// DYNAMIC TOOL DISCOVERY
// ═══════════════════════════════════════════
let cachedToolCatalog = "";

async function fetchToolCatalog(): Promise<string> {
  if (cachedToolCatalog) return cachedToolCatalog;
  try {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as Record<string, unknown>;
    const result = res?.result as Record<string, unknown>;
    const tools = (result?.tools || []) as Array<Record<string, unknown>>;
    
    const catalog = tools.map((t: Record<string, unknown>) => {
      const name = t.name as string;
      const desc = ((t.description as string) || "").slice(0, 150);
      const schema = t.inputSchema as Record<string, unknown>;
      const props = schema?.properties as Record<string, unknown> || {};
      const params = Object.keys(props).join(", ");
      return `- ${name}(${params}): ${desc}`;
    }).join("\n");
    
    cachedToolCatalog = catalog;
    log(`Fetched ${tools.length} tools from MCP backend`);
    return catalog;
  } catch (e) {
    log("Failed to fetch tool catalog: " + e);
    return "Tool catalog unavailable. Use search_ifc_knowledge to discover available operations.";
  }
}

// ═══════════════════════════════════════════
// SYSTEM PROMPT - Minimal, RAG-Driven
// ═══════════════════════════════════════════
function buildSystemPrompt(toolCatalog: string, ragContext: string = "", isComplex: boolean = false): string {
  const ragSection = ragContext
    ? `\nIFC API KNOWLEDGE (pre-fetched from RAG — USE THESE API CALLS in your code):\n${ragContext}\n`
    : "";

  if (isComplex) {
    // COMPLEX MODE: Force a single execute_ifc_code_tool script for entire building
    return `You are a BIM Agent for InfraStudio. You create IFC building models.

HOW TO CALL TOOLS:
Call call_mcp_tool(tool_name, arguments) with a JSON arguments object.
Always use metric units (meters).

FOR THIS REQUEST: You MUST create the ENTIRE building in ONE execute_ifc_code_tool call.
Do NOT use individual tools like create_wall, create_slab, create_door.
Write a SINGLE Python script that creates ALL elements at once.
${ragSection}
WORKING EXAMPLE — A complete building script using the REAL ifcopenshell API:

import ifcopenshell.api as api
import numpy as np

ifc_file = get_ifc_file()
body_ctx = get_or_create_body_context(ifc_file)
building = ifc_file.by_type("IfcBuilding")[0]

storey = api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name="Ground Floor")
api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])

# === COLUMN (use profile + profile_representation) ===
profile = api.run("profile.add_parameterized_profile", ifc_file, ifc_class="IfcRectangleProfileDef")
profile.XDim = 0.3
profile.YDim = 0.3
col = api.run("root.create_entity", ifc_file, ifc_class="IfcColumn", name="Col1")
rep = api.run("geometry.add_profile_representation", ifc_file, context=body_ctx, profile=profile, depth=3.5)
api.run("geometry.assign_representation", ifc_file, product=col, representation=rep)
matrix = np.eye(4); matrix[:, 3] = [0.0, 0.0, 0.0, 1.0]
api.run("geometry.edit_object_placement", ifc_file, product=col, matrix=matrix)
api.run("spatial.assign_container", ifc_file, relating_structure=storey, products=[col])

# === BEAM (use profile + profile_representation with horizontal orientation) ===
bprofile = api.run("profile.add_parameterized_profile", ifc_file, ifc_class="IfcRectangleProfileDef")
bprofile.XDim = 0.3
bprofile.YDim = 0.3
beam = api.run("root.create_entity", ifc_file, ifc_class="IfcBeam", name="Beam1")
rep = api.run("geometry.add_profile_representation", ifc_file, context=body_ctx, profile=bprofile, depth=5.0,
    placement_zx_axes=([1.0, 0.0, 0.0], [0.0, 0.0, -1.0]))
api.run("geometry.assign_representation", ifc_file, product=beam, representation=rep)
matrix = np.eye(4); matrix[:, 3] = [0.0, 0.0, 3.5, 1.0]
api.run("geometry.edit_object_placement", ifc_file, product=beam, matrix=matrix)
api.run("spatial.assign_container", ifc_file, relating_structure=storey, products=[beam])

# === WALL (use add_wall_representation) ===
wall = api.run("root.create_entity", ifc_file, ifc_class="IfcWall", name="Wall1")
rep = api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=5.0, height=3.0, thickness=0.2)
api.run("geometry.assign_representation", ifc_file, product=wall, representation=rep)
matrix = np.eye(4); matrix[:, 3] = [0.0, 0.0, 0.0, 1.0]
api.run("geometry.edit_object_placement", ifc_file, product=wall, matrix=matrix)
api.run("spatial.assign_container", ifc_file, relating_structure=storey, products=[wall])

# === SLAB (use add_wall_representation as flat extrusion for sized slabs) ===
# NOTE: add_slab_representation only takes depth — it does NOT accept length or width.
# For a slab with specific XY dimensions, use add_wall_representation as a flat shape:
slab = api.run("root.create_entity", ifc_file, ifc_class="IfcSlab", name="FloorSlab")
rep = api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=10.0, height=10.0, thickness=0.25)
api.run("geometry.assign_representation", ifc_file, product=slab, representation=rep)
matrix = np.eye(4); matrix[:, 3] = [0.0, 0.0, 0.0, 1.0]
api.run("geometry.edit_object_placement", ifc_file, product=slab, matrix=matrix)
api.run("spatial.assign_container", ifc_file, relating_structure=storey, products=[slab])

save_and_load_ifc()

CRITICAL RULES FOR execute_ifc_code_tool:

PRE-INJECTED FUNCTIONS (call directly, no import needed):
- get_ifc_file() → returns the active IFC file
- get_or_create_body_context(ifc_file) → returns the Body/MODEL_VIEW context
- save_and_load_ifc() → saves and reloads the model (ALWAYS call at the end)

FORBIDDEN:
- NEVER call api.run("project.create_file") — project already exists
- NEVER create IfcProject, IfcSite, or IfcBuilding — they already exist
- NEVER call ifc_file.write("...") — use save_and_load_ifc() instead
- NEVER call api.run("context.add_context") — use get_or_create_body_context() instead
- NEVER invent functions like create_extruded_box or create_matrix — they do NOT exist

MANDATORY:
- Start with: ifc_file = get_ifc_file() and body_ctx = get_or_create_body_context(ifc_file)
- End with: save_and_load_ifc()
- Use api.run("geometry.add_wall_representation", ...) for walls
- Use api.run("geometry.add_profile_representation", ...) for columns/beams
- Use api.run("geometry.add_slab_representation", ...) for slabs
- Use api.run("geometry.edit_object_placement", ..., matrix=np.eye(4)) for placement
- Use api.run("spatial.assign_container", ..., products=[element]) to assign to storey

WHEN DONE: Return a text response explaining what you built.`;
  }

  // SIMPLE MODE: individual MCP tools for single elements
  return `You are a BIM Agent for InfraStudio. You create and manage IFC building models.

HOW TO USE TOOLS:
Call call_mcp_tool(tool_name, arguments) with the exact tool name and a JSON arguments object.
Example: call_mcp_tool("create_wall", { "name": "W1", "length": 5.0, "height": 3.0, "thickness": 0.2, "location": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0] })
Always use metric units (meters).

AVAILABLE MCP TOOLS (from backend):
${toolCatalog}

RULES:
- Vector arguments (location, rotation, start_point, end_point) MUST be arrays of floats like [0.0, 0.0, 0.0]
- For openings: create_opening first, then create_door/create_window, then fill_opening
- Styles: create_surface_style first, then apply_style_to_object with IFC GUIDs
- If the requested element has no individual tool, use search_ifc_knowledge or find_ifc_function first, then execute_ifc_code_tool.

WHEN DONE: Return a text response explaining what you built.`;
}

// Define the generic tool for Gemini
const GEMINI_TOOLS = [{
  functionDeclarations: [{
    name: "call_mcp_tool",
    description: "Call an MCP backend tool by its name. Use this to create or query BIM objects, search the IFC knowledge base via RAG, execute IFC code, etc. It returns the raw result.",
    parameters: {
      type: "OBJECT",
      properties: {
        tool_name: { type: "STRING", description: "The exact name of the tool (e.g. create_wall, search_ifc_knowledge, execute_ifc_code_tool)" },
        arguments: { type: "OBJECT", description: "A JSON object of arguments keyed by name." }
      },
      required: ["tool_name", "arguments"]
    }
  }]
}];

// ═══════════════════════════════════════════
// AGENT EXECUTION LOOP
// ═══════════════════════════════════════════
async function executeAgentLoop(history: any[], systemPrompt: string): Promise<{ reply: string; steps: string[]; hasChanges: boolean }> {
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
        systemInstruction: { parts: [{ text: systemPrompt }] },
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
        let tName = call.args?.tool_name?.toString() || "";
        let tArgs = call.args?.arguments || {};
        
        // Guard: AI sometimes double-wraps — call_mcp_tool(call_mcp_tool(...))
        // Unwrap it so the real tool name reaches the backend
        while (tName === "call_mcp_tool" && tArgs && (tArgs as any).tool_name) {
          log(`Unwrapping nested call_mcp_tool → ${(tArgs as any).tool_name}`);
          tName = (tArgs as any).tool_name.toString();
          tArgs = (tArgs as any).arguments || {};
        }
        
        // Skip if tool name is empty or invalid
        if (!tName || tName === "unknown" || tName === "call_mcp_tool") {
          log(`Skipping invalid tool name: "${tName}"`);
          callResult = { success: false, error: `Invalid tool name: "${tName}". Use a specific tool name like execute_ifc_code_tool, create_wall, etc.` };
          steps.push(`✗ Skipped: invalid tool name`);
        } else {
          try {
            const mRes = await mcpTool(tName, tArgs);
            callResult = mRes;
            
            if (mRes.success === false || mRes.error) {
              steps.push(`✗ Failed: ${tName}`);
            } else {
              steps.push(`✓ Used: ${tName}`);
              if (tName.startsWith("create_") || tName.startsWith("update_") || tName.startsWith("delete_") || tName.startsWith("apply_") || tName.startsWith("fill_") || tName.startsWith("initialize_") || tName === "execute_ifc_code_tool") {
                hasChanges = true;
              }
            }
          } catch(e) {
            log(`Tool Execution Error: ${e}`);
            callResult = { success: false, error: String(e) };
            steps.push(`✗ Error: ${tName}`);
          }
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
    
    const history = payloadMsgs.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }]
    }));

    await mcpInit();
    
    // If this is the first message in a new conversation, reset the IFC project
    // so old geometry from previous sessions doesn't accumulate
    if (payloadMsgs.length === 1) {
      log("New session detected (1 message) — resetting IFC project");
      try {
        await mcpTool("initialize_project", { project_name: "InfraStudio Project" });
        log("Fresh project initialized");
      } catch (e) {
        log("Project init warning: " + e);
      }
    }
    
    // Fetch tool catalog from MCP backend (cached after first call)
    const toolCatalog = await fetchToolCatalog();
    
    // Auto-detect complex requests and pre-fetch RAG knowledge
    const lastMsg = payloadMsgs[payloadMsgs.length - 1]?.content?.toLowerCase() || "";
    const complexKeywords = ["building", "storey", "story", "floor", "column", "beam", "grid", "structure", "structural", "framework", "multi", "house", "office"];
    const isComplex = complexKeywords.some(k => lastMsg.includes(k));
    
    let ragContext = "";
    if (isComplex) {
      log("Complex request detected — auto-fetching RAG knowledge");
      try {
        // Run 2 targeted RAG queries IN PARALLEL to stay within timeout
        const [geomResult, profileResult] = await Promise.allSettled([
          mcpTool("search_ifc_knowledge", { query: "add wall representation add profile representation geometry", max_results: 5 }),
          mcpTool("search_ifc_knowledge", { query: "edit object placement spatial assign container", max_results: 5 }),
        ]);
        
        const ragParts: string[] = [];
        for (const settled of [geomResult, profileResult]) {
          if (settled.status === "fulfilled" && settled.value) {
            const result = settled.value as any;
            if (result.status === "success" && result.results) {
              for (const r of result.results as any[]) {
                if (r.description) ragParts.push(r.description);
                if (r.signature) ragParts.push(`Signature: ${r.signature}`);
                if (r.examples && r.examples.length > 0) ragParts.push(`Example:\n${r.examples[0]}`);
              }
            }
          }
        }
        
        if (ragParts.length > 0) {
          ragContext = ragParts.join("\n\n---\n\n");
        }
        log(`RAG knowledge fetched: ${ragParts.length} results, ${ragContext.length} chars`);
      } catch (e) {
        log("RAG pre-fetch warning: " + e);
      }
    }
    
    const systemPrompt = buildSystemPrompt(toolCatalog, ragContext, isComplex);

    const result = await executeAgentLoop(history, systemPrompt);

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
