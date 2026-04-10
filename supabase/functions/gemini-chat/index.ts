import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const LLM_API_KEY = Deno.env.get("MODAL_API_KEY") || "";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LLM_MODEL = "zai-org/GLM-5.1-FP8";
const LLM_URL = "https://api.us-west-2.modal.direct/v1/chat/completions";

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
// SYSTEM PROMPT 
// ═══════════════════════════════════════════
function buildSystemPrompt(toolCatalog: string): string {
  return `You are a BIM Agent for InfraStudio. You create and manage IFC building models.

HOW TO USE TOOLS:
Call call_mcp_tool(tool_name, arguments) with the exact tool name and a JSON arguments object. Always use metric units (meters).

AVAILABLE MCP TOOLS (from backend):
\${toolCatalog}

══════════════════════════════════════════════════════════
MANDATORY DECISION RULE — READ THIS BEFORE EVERY RESPONSE
══════════════════════════════════════════════════════════

Before you do ANYTHING, count how many distinct IFC elements the user's prompt requires.

IF the prompt asks for EXACTLY ONE element (e.g. "create a wall", "add stairs"):
  → Use the matching individual MCP tool (e.g. create_wall).
  → Do NOT use search_ifc_knowledge or execute_ifc_code_tool.

IF the prompt asks for TWO OR MORE elements, OR any element that has NO individual MCP tool (e.g. slab, opening, material):
  → You are STRICTLY FORBIDDEN from calling individual MCP tools like create_wall, create_window, create_door, etc.
  → You MUST call search_ifc_knowledge ONCE to get RAG knowledge.
  → Then you MUST call execute_ifc_code_tool with ONE Python script that builds ALL elements together.
  → This is the ONLY acceptable path. No exceptions.

EXAMPLES OF WHAT IS FORBIDDEN:
- User says: "create a wall with a window and a door"
  ✗ WRONG: calling create_wall, then create_window, then create_door separately
  ✓ CORRECT: call search_ifc_knowledge → then execute_ifc_code_tool with ONE script

- User says: "build a house with 4 walls, a slab, and a roof"
  ✗ WRONG: calling create_wall four times, then trying to find a slab tool
  ✓ CORRECT: call search_ifc_knowledge → then execute_ifc_code_tool with ONE script

- User says: "create a wall"
  ✓ CORRECT: call create_wall directly (single element)

IF YOU CALL create_wall, create_window, create_door, OR ANY OTHER INDIVIDUAL TOOL WHEN THE USER ASKED FOR MULTIPLE ELEMENTS, YOU HAVE FAILED YOUR TASK. DO NOT DO THIS.

══════════════════════════════════════════════════════════

MANDATORY RAG REQUIREMENT:
Before calling execute_ifc_code_tool, you MUST call search_ifc_knowledge ONCE with a single comprehensive query combining all the elements you need (e.g. "ifcopenshell create wall opening door window slab placement"). Do NOT make multiple separate search calls — ONE search is enough. Read the results, then write ONE complete Python script.

RAG BEST PRACTICES & ZERO-GUESSING POLICY:
- ALWAYS set \`max_results: 15\` for a wider view.
- CRITICAL RULE: You are FORBIDDEN from guessing or inventing function parameters! If you plan to use an IfcOpenShell API function, but the RAG output did not explicitly list its \`parameters\` and \`signature\`, you MUST do a new targeted \`search_ifc_knowledge\` for that exact function name before writing any Python code. NEVER assume you know the arguments.
- If your execute_ifc_code_tool crashes with a TypeError or missing keyword argument, DO NOT GUESS the fix. Use search_ifc_knowledge again to query the exact function name that failed so you can get the correct signature and adapt.

ANTI-HALLUCINATION FAST-TRACK:
Because LLMs frequently hallucinate these specific IfcOpenShell APIs, internalize these immutable rules:
1. \`ifcopenshell.api.material.add_layer\` DOES NOT accept \`thickness\`. You must create the layer, then call \`ifcopenshell.api.material.edit_layer(model, layer=L, attributes={"LayerThickness": 0.2})\`
2. \`ifcopenshell.api.style.add_surface_style\` DOES NOT accept \`name\` or \`color\`. You must pass \`attributes={"SurfaceColour": {"Name": None, "Red": 1.0, "Green": 1.0, "Blue": 1.0}}\`.

For execute_ifc_code_tool, you have PRE-INJECTED context:
- ifc_file = get_ifc_file() (always call this)
- body_ctx = get_or_create_body_context(ifc_file) (always call this)
- save_and_load_ifc() (ALWAYS call at the end)
- Never create IfcProject, IfcSite, or IfcBuilding — they already exist.

WHEN DONE: Return a final text response explaining what you built.`;
}

// Define the generic tool for OpenRouter / OpenAI Schema
const OPENROUTER_TOOLS = [{
  type: "function",
  function: {
    name: "call_mcp_tool",
    description: "Call an MCP backend tool by its name. Use this to create or query BIM objects, search the IFC knowledge base via RAG, execute IFC code, etc. It returns the raw result.",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "The exact name of the tool (e.g. create_wall, search_ifc_knowledge, execute_ifc_code_tool)" },
        arguments: { type: "object", description: "A JSON object of arguments keyed by name." }
      },
      required: ["tool_name", "arguments"]
    }
  }
}];

// ═══════════════════════════════════════════
// AGENT EXECUTION LOOP
// ═══════════════════════════════════════════
async function executeAgentTurn(history: any[], systemPrompt: string): Promise<{ status: "pending_turn"|"completed"; new_messages: any[]; steps: string[]; hasChanges: boolean; reasoning_details?: string | null }> {
  const steps: string[] = [];
  let hasChanges = false;
  
  const openRouterMessages = [
     { role: "system", content: systemPrompt },
     ...history
  ];
  
  log(`Calling LLM API... messages count: ${openRouterMessages.length}`);
  
  // -- RETRY LOOP for transient Modal failures (502, 503, 429, timeouts) --
  // IMPORTANT: Supabase Edge Functions have a HARD 150s wall clock limit (HTTP 546).
  // Worst case: MCP init(5s) + attempt1(55s) + backoff(3s) + attempt2(55s) = 118s < 150s ✓
  const MAX_LLM_RETRIES = 2;
  let lastError = "";
  let json: any = null;
  
  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    try {
      log(`LLM attempt ${attempt}/${MAX_LLM_RETRIES}...`);
      const res = await fetch(LLM_URL, {
        method: "POST", headers: { 
           "Content-Type": "application/json",
           "Authorization": `Bearer ${LLM_API_KEY}`,
           "HTTP-Referer": "https://infrastudio.tools",
           "X-Title": "InfraStudio"
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: openRouterMessages,
          tools: OPENROUTER_TOOLS,
          tool_choice: "auto",
          enable_thinking: false
        }),
        signal: AbortSignal.timeout(55000) // 55s — must fit within Supabase 150s limit
      });
      
      if (res.ok) {
        const parsed = await res.json();
        const msg = parsed?.choices?.[0]?.message;
        
        // Handle empty GLM responses (no content AND no tool_calls)
        if (!msg || (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0))) {
          lastError = "Model returned empty response (no content, no tool_calls)";
          log(`Empty response on attempt ${attempt}. ${attempt < MAX_LLM_RETRIES ? "Retrying..." : "Giving up."}`);
          if (attempt < MAX_LLM_RETRIES) {
            steps.push(`⚠ LLM retry ${attempt}/${MAX_LLM_RETRIES} (empty response)`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw new Error(lastError);
        }
        
        json = parsed;
        break; // Success — exit retry loop
      }
      
      // Transient errors worth retrying
      const errBody = await res.text().catch(() => "N/A");
      lastError = `Modal API Error: ${res.status} - ${errBody}`;
      
      if ([502, 503, 429].includes(res.status) && attempt < MAX_LLM_RETRIES) {
        const waitSec = attempt * 3; // 3s, 6s backoff
        log(`Transient ${res.status} on attempt ${attempt}. Retrying in ${waitSec}s...`);
        steps.push(`⚠ LLM retry ${attempt}/${MAX_LLM_RETRIES} (${res.status})`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      
      throw new Error(lastError);
      
    } catch (e: any) {
      lastError = String(e);
      const isTimeout = lastError.includes("TimeoutError") || lastError.includes("abort") || lastError.includes("timed out");
      const isUpstream = lastError.includes("502") || lastError.includes("503") || lastError.includes("upstream");
      
      if ((isTimeout || isUpstream) && attempt < MAX_LLM_RETRIES) {
        const waitSec = attempt * 3;
        log(`Network error on attempt ${attempt}: ${lastError.slice(0, 100)}. Retrying in ${waitSec}s...`);
        steps.push(`⚠ LLM retry ${attempt}/${MAX_LLM_RETRIES} (network)`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw new Error(`LLM failed after ${attempt} attempts: ${lastError.slice(0, 300)}`);
    }
  }
  
  if (!json) {
    throw new Error(`LLM failed after ${MAX_LLM_RETRIES} attempts: ${lastError.slice(0, 300)}`);
  }
  
  const message = json.choices[0].message;
  
  const new_messages = [message];
  
  // -- GLM-5.1 RAW TOKEN SYNTHESIS --
  // HF Router sometimes fails to parse Zhipu's proprietary <tool_call> tags into the standard tool_calls array.
  // We manually intercept these tokens in the text content and synthesize a valid tool_calls object.
  if ((!message.tool_calls || message.tool_calls.length === 0) && typeof message.content === "string" && message.content.includes("<tool_call>")) {
    message.tool_calls = [];
    const parts = message.content.split("<tool_call>");
    for (let i = 1; i < parts.length; i++) {
      const t = parts[i];
      const nameMatch = t.match(/^\s*([a-zA-Z0-9_]+)/);
      if (!nameMatch) continue;
      const fnName = nameMatch[1];
      
      const argsOb: Record<string, any> = {};
      const argRegex = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>(.*?)<\/arg_value>/gs;
      let match;
      while ((match = argRegex.exec(t)) !== null) {
        let valRaw = match[2];
        try { valRaw = JSON.parse(valRaw); } catch(e) {} // Attempt to decode nested JSON if it's stringified
        argsOb[match[1]] = valRaw;
      }
      
      message.tool_calls.push({
        id: "call_" + Math.random().toString(36).substr(2, 9),
        type: "function",
        function: {
          name: fnName,
          arguments: JSON.stringify(argsOb)
        }
      });
    }
    log(`Synthesized ${message.tool_calls.length} GLM tool calls from raw response content.`);
  }
  
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      const callId = toolCall.id;
      const call = toolCall.function;
      log(`AI Wants to call: ${call.name}`);
      
      let callResult: any;
      if (call.name === "call_mcp_tool") {
        let parsedArgs: any = {};
        try { parsedArgs = JSON.parse(call.arguments || "{}"); } catch(e) {}
        
        let tName = parsedArgs?.tool_name?.toString() || "";
        let tArgs = parsedArgs?.arguments || {};
        
        while (tName === "call_mcp_tool" && tArgs && tArgs.tool_name) {
          log(`Unwrapping nested call_mcp_tool -> ${tArgs.tool_name}`);
          tName = tArgs.tool_name.toString();
          tArgs = tArgs.arguments || {};
        }
        
        if (!tName || tName === "unknown" || tName === "call_mcp_tool") {
          log(`Skipping invalid tool name: "${tName}"`);
          callResult = { success: false, error: `Invalid tool name: "${tName}". Use a specific tool name.` };
          steps.push(`✗ Skipped: invalid tool name`);
        } else {
          try {
            const mRes = await mcpTool(tName, tArgs);
            callResult = mRes;
            
            if (mRes.success === false || mRes.error || mRes.status === "error") {
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
      
      new_messages.push({
        role: "tool",
        tool_call_id: callId,
        content: JSON.stringify(callResult)
      });
    }
    
    return { status: "pending_turn", new_messages, steps, hasChanges, reasoning_details: message.reasoning_content };
  }
  
  if (message.content) {
    log(`Final AI Answer received.`);
    return { 
      status: "completed",
      new_messages,
      steps, 
      hasChanges,
      reasoning_details: message.reasoning_content
    };
  }
  
  return { status: "completed", new_messages: [{role: "assistant", content: "I encountered an error."}], steps, hasChanges, reasoning_details: null };
}

// ═══════════════════════════════════════════
// HTTP HANDLER
// ═══════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!LLM_API_KEY) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  debugLog.length = 0;
  mcpSessionId = "";
  try {
    const payloadMsgs = (await req.json() as any).messages || [];
    if (!payloadMsgs.length) return new Response(JSON.stringify({ error: "No messages" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    
    // We expect the frontend to provide the perfectly formatted history array now.
    const history = payloadMsgs;

    await mcpInit();
    
    // If there is exactly 1 user message, it's a new session. Reset project.
    if (history.length === 1 && history[0].role === "user") {
      log("New session detected (1 user message) — resetting IFC project");
      try {
        await mcpTool("initialize_project", { project_name: "InfraStudio Project" });
      } catch (e) {
        log("Project init warning: " + e);
      }
    }
    
    const toolCatalog = await fetchToolCatalog();
    const systemPrompt = buildSystemPrompt(toolCatalog);

    const result = await executeAgentTurn(history, systemPrompt);

    let ifc_url: string | undefined;
    // Export IFC if we completed and had changes
    if (result.hasChanges) {
      try {
        log("Changes detected in this turn, exporting IFC...");
        const ex = await mcpTool("export_ifc", { session_id: mcpSessionId || "default" });
        if ((ex as any).success && (ex as any).file_url) {
          ifc_url = (ex as any).file_url as string;
          log("Export success");
        }
      } catch (e) { log("Export err: " + e); }
    }

    const body: Record<string, unknown> = {
      status: result.status,
      new_messages: result.new_messages,
      steps: result.steps,
      debug: debugLog
    };
    if (result.status === "completed") {
      body.reply = result.new_messages[0]?.content || "Done.";
    }
    if (result.reasoning_details) body.reasoning_details = result.reasoning_details;
    if (ifc_url) body.ifc_url = ifc_url;
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    log("FATAL: " + err);
    // Return 200 with the error inside JSON, so the frontend UI can explicitly show "Rate Limit Exceeded" instead of just "non-2xx"
    return new Response(JSON.stringify({ error: String(err).slice(0, 800), debug: debugLog }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
