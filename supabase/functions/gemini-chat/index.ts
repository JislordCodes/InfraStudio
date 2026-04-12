import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// NVIDIA NIM API
const LLM_API_KEY = Deno.env.get("NVIDIA_API_KEY") || "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";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LLM_MODEL = "meta/llama-3.1-70b-instruct";
const LLM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RAG_TAG = "[INFRASTUDIO_RAG_DONE]";
const ERR_TAG = "[INFRASTUDIO_EXEC_ERROR]";

// ══ MCP CLIENT ══
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
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const s = res.headers.get("mcp-session-id"); if (s) mcpSessionId = s;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    return l ? JSON.parse(l.slice(5).trim()) : {};
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function mcpInit(): Promise<void> {
  await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "7.0" } } });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
  log("MCP ready");
}

async function mcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  log("CALL " + name + "(" + JSON.stringify(args).slice(0, 300) + ")");
  const res = await mcpPost({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) as Record<string, unknown>;
  const text = extractText((res?.result as Record<string, unknown>)?.content);
  if (text) {
    log("=> " + name + ": " + text.slice(0, 400));
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  if (res?.error) {
    const errMsg = JSON.stringify(res.error).slice(0, 200);
    log("ERR " + name + ": " + errMsg);
    return { success: false, error: errMsg };
  }
  return { raw: JSON.stringify(res?.result ?? "done") };
}

// ══ TOOL CATALOG ══
let cachedToolCatalog = "";
async function fetchToolCatalog(): Promise<string> {
  if (cachedToolCatalog) return cachedToolCatalog;
  try {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as Record<string, unknown>;
    const tools = ((res?.result as any)?.tools || []) as Array<Record<string, unknown>>;
    cachedToolCatalog = tools.map(t => {
      const name = t.name as string;
      const desc = ((t.description as string) || "").slice(0, 150);
      const props = ((t.inputSchema as any)?.properties as Record<string, unknown>) || {};
      return `- ${name}(${Object.keys(props).join(", ")}): ${desc}`;
    }).join("\n");
    log(`Fetched ${tools.length} tools`);
    return cachedToolCatalog;
  } catch (e) {
    log("Tool catalog fetch failed: " + e);
    return "";
  }
}

// ══ HELPERS ══
function buildRagQuery(userRequest: string): string {
  const lower = userRequest.toLowerCase();
  const parts: string[] = ["ifcopenshell api"];
  if (lower.includes("wall")) parts.push("create wall IfcWall representation placement");
  if (lower.includes("door")) parts.push("create door IfcDoor fill opening void");
  if (lower.includes("window")) parts.push("create window IfcWindow fill opening");
  if (lower.includes("roof")) parts.push("create roof IfcRoof");
  if (lower.includes("slab") || lower.includes("floor")) parts.push("create slab IfcSlab");
  if (lower.includes("stair")) parts.push("IfcStairFlight");
  if (lower.includes("column")) parts.push("IfcColumn");
  if (lower.includes("beam")) parts.push("IfcBeam");
  if (lower.includes("glass") || lower.includes("material") || lower.includes("wood") || lower.includes("wooden") || lower.includes("concrete")) {
    parts.push("material IfcMaterial add_surface_style");
  }
  parts.push("assign_container IfcBuildingStorey");
  return parts.join(" ");
}

function isComplexRequest(userMsg: string): boolean {
  const lower = userMsg.toLowerCase();
  if (lower.match(/(house|building|structure|multiple|and |with |,)/i)) return true;
  let kw = 0;
  if (lower.includes("wall")) kw++; if (lower.includes("door")) kw++;
  if (lower.includes("window")) kw++; if (lower.includes("roof")) kw++;
  if (lower.includes("slab") || lower.includes("floor")) kw++;
  if (lower.includes("stair")) kw++;
  return kw > 1;
}

function extractErrorSummary(result: Record<string, unknown>): string {
  if (typeof result.traceback === "string") return result.traceback.slice(0, 800);
  if (typeof result.error === "string") return result.error.slice(0, 800);
  if (typeof result.message === "string") return result.message.slice(0, 800);
  return JSON.stringify(result).slice(0, 600);
}

function extractFailingFunction(error: string): string {
  for (const fn of ["add_layer","add_surface_style","add_opening","add_filling","assign_container","assign_representation","create_entity","add_wall_representation","add_door_representation","add_window_representation"]) {
    if (error.includes(fn)) return fn;
  }
  return "unknown";
}

// ══ COMPRESS RAG ══
function compressRagResults(rawRag: string): string {
  try {
    const parsed = JSON.parse(rawRag);
    const results = parsed.results || parsed.hits || (Array.isArray(parsed) ? parsed : []);
    if (!Array.isArray(results) || results.length === 0) return rawRag.slice(0, 3000);
    
    const compressed = results.slice(0, 8).map((r: any, i: number) => {
      const name = r.function || r.name || r.function_name || r.title || `result_${i}`;
      const desc = (r.description || r.content || "").slice(0, 500);
      const params = r.parameters || r.params || r.args;
      let paramStr = "";
      if (params) {
        if (typeof params === "string") paramStr = params.slice(0, 300);
        else if (Array.isArray(params)) paramStr = params.map((p: any) => `${p.name || p}: ${p.type || 'any'}${p.required ? ' (required)' : ''}`).join(", ");
        else paramStr = JSON.stringify(params).slice(0, 300);
      }
      let exampleStr = "";
      if (r.examples && Array.isArray(r.examples) && r.examples.length > 0) {
        exampleStr = "\n   Examples:\n   " + r.examples.join("\n   ").slice(0, 1000);
      }
      const module = r.module || r.category || "";
      return `[${i+1}] ${module ? module + "." : ""}${name}(${paramStr})\n   ${desc}${exampleStr}`;
    });
    
    return compressed.join("\n\n");
  } catch {
    return rawRag.slice(0, 3000);
  }
}

// ══ LLM CALLER (FOR FALLBACK / SIMPLE QUERIES) ══
const TOOLS_SCHEMA = [{
  type: "function",
  function: {
    name: "call_mcp_tool",
    description: "Call a backend MCP tool by name.",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        arguments: { type: "object" }
      },
      required: ["tool_name", "arguments"]
    }
  }
}];

async function callLLMSimple(messages: any[], steps: string[]): Promise<any> {
  const MAX_RETRIES = 2;
  const PER_ATTEMPT_TIMEOUT = 60000; 
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT);
      try {
        const res = await fetch(LLM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LLM_API_KEY}`
          },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages,
            tools: TOOLS_SCHEMA,
            tool_choice: "auto",
            temperature: 0.6,
            max_tokens: 2048,
            stream: false
          }),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (res.ok) {
          const parsed = await res.json();
          return parsed;
        }
        throw new Error(`API ${res.status}: ${await res.text()}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      lastError = String(e);
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`LLM failed: ${lastError.slice(0, 200)}`);
}

function parseToolCall(message: any): { name: string; args: any } | null {
  let calls = message.tool_calls || [];
  if (calls.length === 0 && typeof message.content === "string" && message.content.includes("<tool_call>")) {
    const parts = message.content.split("<tool_call>");
    for (let i = 1; i < parts.length; i++) {
      const t = parts[i];
      const nameMatch = t.match(/^\s*([a-zA-Z0-9_]+)/);
      if (!nameMatch) continue;
      const argsOb: Record<string, any> = {};
      const argRex = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>(.*?)<\/arg_value>/gs;
      let m; while ((m = argRex.exec(t)) !== null) { let v = m[2]; try { v = JSON.parse(v); } catch (e) {} argsOb[m[1]] = v; }
      calls.push({ function: { name: nameMatch[1], arguments: JSON.stringify(argsOb) } });
    }
  }
  if (calls.length === 0) return null;
  const call = calls[0].function;
  let parsedArgs: any = {};
  try { parsedArgs = JSON.parse(call.arguments || "{}"); } catch (e) {}
  let tName = parsedArgs?.tool_name || call.name;
  let tArgs = parsedArgs?.arguments || parsedArgs;
  while (tName === "call_mcp_tool" && tArgs?.tool_name) { tName = tArgs.tool_name; tArgs = tArgs.arguments || {}; }
  return { name: tName, args: tArgs };
}

// ══ FILTERED CATALOG ══
const HIDDEN_TOOLS = ["create_wall", "create_door", "create_window", "create_slab", "create_roof", "create_opening", "fill_opening", "create_trimesh_ifc", "create_polyline_walls"];
function filterCatalog(catalog: string): string {
  return catalog.split("\n").filter(l => !HIDDEN_TOOLS.some(t => l.startsWith(`- ${t}(`))).join("\n");
}

// ════════════════════════════════════════════
// ACTION: TURN 1: RAG SEARCH 
// ════════════════════════════════════════════
async function turn1_rag(
  userMsg: string,
  isNewSession: boolean,
  toolCatalog: string,
  steps: string[]
): Promise<{ new_messages: any[]; steps: string[] }> {
  if (isNewSession) {
    try { await mcpTool("initialize_project", { project_name: "InfraStudio Project" }); } catch (e) { log("Init warn: " + e); }
  }

  const ragQuery = buildRagQuery(userMsg);
  log(`RAG query: ${ragQuery}`);
  steps.push("🔍 Searching IFC knowledge base...");

  let ragContent = "RAG unavailable.";
  try {
    const ragResult = await mcpTool("search_ifc_knowledge", { query: ragQuery, max_results: 8 });
    ragContent = JSON.stringify(ragResult);
    steps.push("✓ Used: search_ifc_knowledge (8 results)");
  } catch (e) {
    log("RAG failed: " + e);
    steps.push("⚠ RAG search failed");
  }

  const compressed = compressRagResults(ragContent);
  const embeddedMsg = `${RAG_TAG}\n=== IFC API REFERENCE ===\n${compressed}\n=== END REFERENCE ===\n[CATALOG]:${filterCatalog(toolCatalog)}`;

  return { new_messages: [{ role: "assistant", content: embeddedMsg }], steps };
}

// ════════════════════════════════════════════
// ACTION: TURN 2: GENERATE STREAM
// ════════════════════════════════════════════
async function turn2_generate(
  userMsg: string,
  ragContext: string,
  codeError: string,
  filteredCatalog: string,
  allMsgs: any[]
): Promise<Response> {
  const isFixAttempt = !!codeError;

  const systemPrompt = `You are an expert BIM Agent. Create IFC models using Python + IfcOpenShell.
OUTPUT ONLY THE RAW PYTHON SCRIPT wrapped in \`\`\`python ... \`\`\` codeblocks. Do not write text explanations or pleasantries.

Pre-injected context (already available in your script):
- ifc_file = get_ifc_file()
- body_ctx = get_or_create_body_context(ifc_file)
- axis_ctx = get_or_create_axis_context(ifc_file)
- container = get_default_container()
- save_and_load_ifc()  # call at end
- IfcProject/IfcSite/IfcBuilding exist. Do NOT recreate them.

Rules:
1. add_layer() has NO thickness param. Use edit_layer(layer=L, attributes={"LayerThickness": 0.2})
2. add_surface_style() has NO name param. Use attributes={"SurfaceColour":{"Name":null,"Red":1.0,"Green":1.0,"Blue":1.0}}
3. add_opening(opening=op, element=wall) then add_filling(opening=op, element=door)
${isFixAttempt ? "\nFIX THE ERROR below. Do not repeat the same mistake." : "\nWrite the code NOW. Do NOT search."}\n\nAvailable tools:\n${filteredCatalog}`;

  // Copy messages from frontend history
  const messages = [{ role: "system", content: systemPrompt }];
  
  // Clean up history to ensure good context length and structure
  for (let i = 0; i < allMsgs.length; i++) {
     messages.push({ role: allMsgs[i].role, content: allMsgs[i].content });
  }

  const enforcementRule = `CRITICAL RULES TO FOLLOW:
1. NEVER create a new project file. DO NOT CALL project.create_file(). Use the global \`ifc_file\`.
2. ALL elements (walls, doors, etc.) MUST have 3D geometry representations added via geometry.add_*_representation. Refer to the Examples section in the RAG contexts for exactly how to do this.
3. Write proper multi-line python code with indentation. Do not put everything in one line.
`;

  // Inject the RAG reference (and explicit instruction) into the very final user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role === "user") {
      let suffix = `\n\nRewrite the python script completely to fix the error.`;
      if (!isFixAttempt) suffix = `\n\nGenerate the complete python script now.`;
      
      lastMsg.content = `API Reference (Includes Examples):\n${ragContext}\n\n` + lastMsg.content + `\n\n${enforcementRule}` + suffix;
  }

  log(`Streaming LLM... NIM ${LLM_MODEL} | HistoryLen: ${messages.length}`);

  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.6,
        top_p: 0.95,
        max_tokens: 8192,
        stream: true
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(`data: [API ERROR] ${err}\n\n`, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
    }

    // Proxy the stream natively back to the client!
    return new Response(res.body, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
  } catch (err) {
    return new Response(`data: [FETCH ERROR] ${String(err)}\n\n`, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
  }
}

function sanitizeGeneratedCode(code: string): string {
  // 1. Validate if we have a single line
  const lines = code.split("\n").map(l => l.trimEnd());
  // Count non-empty, non-comment lines
  const meaningfulLines = lines.filter(l => l.trim().length > 0 && !l.trim().startsWith("#"));
  
  if (meaningfulLines.length <= 1 && code.includes("import ") && code.length > 50) {
     throw new Error("Invalid Python syntax: code generated as a single line without newlines. Please rewrite with proper newlines and indentation.");
  }

  // 2. Filter out project.create_file
  const filteredLines = lines.filter(l => !l.includes("project.create_file"));

  // 3. Prepend mandatory structure
  const preamble = [
    "import ifcopenshell",
    "import ifcopenshell.api",
    "ifc_file = get_ifc_file()",
    "body_ctx = get_or_create_body_context(ifc_file)",
    "axis_ctx = get_or_create_axis_context(ifc_file)",
    "container = get_default_container()",
    "unit_scale = calculate_unit_scale(ifc_file)",
    ""
  ];

  // Check if save_and_load_ifc() is there, if not append it
  let finalCode = [...preamble, ...filteredLines].join("\n");
  if (!finalCode.includes("save_and_load_ifc()")) {
      finalCode += "\n\nsave_and_load_ifc()\n";
  }

  return finalCode;
}

// ════════════════════════════════════════════
// ACTION: TURN 3: EXECUTE
// ════════════════════════════════════════════
async function turn3_execute(code: string, sessionID: string): Promise<Record<string, unknown>> {
  mcpSessionId = sessionID || "";
  await mcpInit();
  
  log(`Executing python code (~${code.length} chars)`);
  let execResult: Record<string, unknown> = {};
  let sanitizedCode = code;

  try {
    sanitizedCode = sanitizeGeneratedCode(code);
    execResult = await mcpTool("execute_ifc_code_tool", { code: sanitizedCode });
  } catch (e) {
    execResult = { success: false, error: String(e), status: "error" };
  }

  const isExecError = execResult.success === false || !!execResult.error || execResult.status === "error";

  if (!isExecError) {
    // Post execution validation checking geometry representation
    try {
      const validationScript = `
import json
import ifcopenshell
ifc_file = get_ifc_file()
shapes = ifc_file.by_type("IfcShapeRepresentation")
print(json.dumps({"shape_count": len(shapes)}))
`;
      const valRes = await mcpTool("execute_ifc_code_tool", { code: validationScript });
      const valStr = ((valRes as any).output || "").trim();
      let hasGeometry = false;
      try {
        const valData = JSON.parse(valStr);
        if (valData.shape_count && valData.shape_count > 0) hasGeometry = true;
      } catch (e) { log("Validation JSON parse fail: " + e); }
      
      if (!hasGeometry) {
         const errorSummary = "SUCCESS BUT EMPTY GEOMETRY: The code ran without errors, but the IFC file contains zero 3D geometry shape representations. You MUST use functions like `geometry.add_wall_representation(...)` and `geometry.assign_representation(...)` to attach 3D meshes to your elements so they appear in the 3D viewer.";
         const failingFn = "missing_geometry_representation";
         const fixExtra = "Check the examples in the RAG contexts for exactly how to add geometric representations.";
         return { status: "pending_turn", errorSummary, failingFn, fixExtra, success: false };
      }
    } catch (e) { log("Validation query failed: " + e); }

    let ifc_url: string | undefined;
    try {
      const ex = await mcpTool("export_ifc", { session_id: mcpSessionId || "default" });
      if ((ex as any).success) ifc_url = (ex as any).file_url;
    } catch (e) { log("Export err: " + e); }
    
    return { status: "completed", reply: "I successfully built your IFC model.", ifc_url, success: true };
  }

  // ERROR RECOVERY
  const errorSummary = extractErrorSummary(execResult);
  const failingFn = extractFailingFunction(errorSummary);
  log(`Exec failed: ${failingFn}`);
  
  let fixExtra = "";
  try {
    const fixRag = await mcpTool("search_ifc_knowledge", { query: `ifcopenshell ${failingFn} correct parameters`, max_results: 5 });
    fixExtra = compressRagResults(JSON.stringify(fixRag));
  } catch (e) {}

  return { status: "pending_turn", errorSummary, failingFn, fixExtra, success: false };
}

// ══ HTTP HANDLER ══
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!LLM_API_KEY) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  debugLog.length = 0;

  try {
    const payload = (await req.json() as any);
    const action = payload.action; 

    // ACTION: turn3_execute
    if (action === "turn3_execute") {
       const res = await turn3_execute(payload.code || "", payload.session_id || "");
       res.debug = debugLog;
       res.session_id = mcpSessionId;
       return new Response(JSON.stringify(res), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // OTHER ACTIONS
    mcpSessionId = payload.session_id || "";
    const allMsgs: any[] = payload.messages || [];
    if (!allMsgs.length) return new Response(JSON.stringify({ error: "No messages" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

    const steps: string[] = [];
    const userMsg = [...allMsgs].reverse().find(m => m.role === "user")?.content || "";
    
    // ACTION: turn1_rag
    if (action === "turn1_rag") {
      await mcpInit();
      const toolCatalog = await fetchToolCatalog();
      const result = await turn1_rag(userMsg, payload.isNewSession || false, toolCatalog, steps);
      return new Response(JSON.stringify({ status: "pending_turn", new_messages: result.new_messages, steps, debug: debugLog, session_id: mcpSessionId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ACTION: turn2_generate (SSE Stream)
    if (action === "turn2_generate") {
      const ragContext = payload.ragContext || "";
      const filteredCatalog = payload.filteredCatalog || "";
      const codeError = payload.codeError || "";
      return await turn2_generate(userMsg, ragContext, codeError, filteredCatalog, allMsgs);
    }

    // LEGACY FALLBACK
    await mcpInit();
    const isComplex = isComplexRequest(userMsg);
    log(`v125 | Complex=${isComplex} | provider=NVIDIA_NIM_STREAM`);
    
    if (!isComplex) {
      const toolCatalog = await fetchToolCatalog();
      if (allMsgs.filter(m => m.role === "user").length === 1) {
        try { await mcpTool("initialize_project", { project_name: "InfraStudio Project" }); } catch (e) {}
      }
      const sysPrompt = `Call call_mcp_tool(tool_name, arguments) to create IFC elements.\nTOOLS:\n${toolCatalog}`;
      const llmMsgs = [{ role: "system", content: sysPrompt }, ...allMsgs.filter(m => ["user", "assistant"].includes(m.role))];
      const parsed = await callLLMSimple(llmMsgs, steps);
      const tc = parseToolCall(parsed.choices[0].message);
      if (!tc) return new Response(JSON.stringify({ status: "completed", reply: parsed.choices[0].message.content || "Done.", steps, session_id: mcpSessionId }), { headers: { ...CORS, "Content-Type": "application/json" } });

      let toolResult: Record<string, unknown>;
      try { toolResult = await mcpTool(tc.name, tc.args); } catch (e) { toolResult = { error: String(e) }; }
      const isErr = toolResult.success === false || !!toolResult.error;
      steps.push(`${isErr ? "✗" : "✓"} ${tc.name}`);
      let ifc_url: string | undefined;
      if (!isErr) try { const ex = await mcpTool("export_ifc", { session_id: mcpSessionId }); if ((ex as any).success) ifc_url = (ex as any).file_url; } catch (e) {}

      const body: any = { status: "pending_turn", new_messages: [{ role: "assistant", content: `Tool ${tc.name}: ${JSON.stringify(toolResult).slice(0, 300)}` }], steps, session_id: mcpSessionId };
      if (ifc_url) body.ifc_url = ifc_url;
      return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Client must supply action='turn1_rag' for complex queries." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (err) {
    log("FATAL: " + err);
    return new Response(JSON.stringify({ error: String(err).slice(0, 800), debug: debugLog }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
