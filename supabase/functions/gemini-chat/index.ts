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
function buildSystemPrompt(toolCatalog: string): string {
  return `You are a BIM Agent for InfraStudio. You create and manage IFC building models.

HOW TO USE TOOLS:
Call call_mcp_tool(tool_name, arguments) with the exact tool name and a JSON arguments object.
Example: call_mcp_tool("create_wall", { "name": "W1", "length": 5.0, "height": 3.0, "thickness": 0.2, "location": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0] })
Always use metric units (meters).

AVAILABLE MCP TOOLS (from backend):
${toolCatalog}

DECISION LOGIC:

1. SIMPLE SINGLE ELEMENTS (wall, door, window, slab, stairs, roof):
   Use the individual MCP tools directly. Example: create_wall, create_door, create_slab, etc.

2. COMPLEX STRUCTURES (buildings, columns, beams, grids, multi-storey, structural systems):
   These have NO individual tools. You MUST:
   a) First call search_ifc_knowledge or find_ifc_function to learn HOW to create the element via ifcopenshell.api
   b) Then use execute_ifc_code_tool to run a SINGLE Python script that creates everything at once
   c) If you don't know the exact ifcopenshell API call, use search_ifc_knowledge("create column representation") or similar

3. UNKNOWN ELEMENTS (anything not in the tool list above):
   Use search_ifc_knowledge(query) or find_ifc_function(operation, object_type) to discover how to build it.
   Then use execute_ifc_code_tool with the discovered API calls.

RULES FOR execute_ifc_code_tool:
- The sandbox has these functions PRE-INJECTED (no import needed):
  get_ifc_file() → returns the active IFC file
  get_or_create_body_context(ifc_file) → returns 3D geometry context
  save_and_load_ifc() → saves and reloads (ALWAYS call at end)
- NEVER create ifcopenshell.file(), IfcProject, IfcSite, or IfcBuilding — they already exist
- Get the existing building: building = ifc_file.by_type("IfcBuilding")[0]
- Use correct IFC classes: IfcColumn for columns, IfcBeam for beams, IfcSlab for slabs, IfcWall for walls
- ALWAYS call save_and_load_ifc() exactly once at the end

IMPORTANT RULES:
- Vector arguments (location, rotation, start_point, end_point) MUST be arrays of floats like [0.0, 0.0, 0.0]
- For openings: create_opening first, then create_door/create_window, then fill_opening
- Styles: create_surface_style first, then apply_style_to_object with IFC GUIDs
- NEVER use execute_blender_code to create visible geometry — only IFC entities appear in the viewer

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
        const tName = call.args?.tool_name?.toString() || "unknown";
        const tArgs = call.args?.arguments || {};
        
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
    
    // Fetch tool catalog from MCP backend (cached after first call)
    const toolCatalog = await fetchToolCatalog();
    const systemPrompt = buildSystemPrompt(toolCatalog);

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
