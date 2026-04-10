import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") || "sk-f02a2c9778704fe8af1b12e297ec44e0";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const DASHSCOPE_MODEL = "qwen3.6-plus";
const DASHSCOPE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

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

CRITICAL RULES FOR PERFORMANCE:
To prevent system timeouts, you must minimize the number of tool calls.
1. Single Elements: For simple tasks (e.g., "add one wall"), use the direct tools above.
2. Multiple Elements (COMPLEX TASKS): For ANY request needing multiple objects, you MUST use execute_ifc_code_tool to write ONE Python script that builds EVERYTHING.
3. Missing Tools: If no direct tool exists, use execute_ifc_code_tool.

MANDATORY RAG REQUIREMENT:
Before calling execute_ifc_code_tool, you MUST call search_ifc_knowledge ONCE with a single comprehensive query combining all the elements you need (e.g. "ifcopenshell create wall opening door window slab placement"). Do NOT make multiple separate search calls — ONE search is enough. Read the results, then write ONE complete Python script.

RAG BEST PRACTICES & ZERO-GUESSING POLICY:
- By default, search_ifc_knowledge returns 5 results. ALWAYS set \`max_results: 15\` for a wider view.
- CRITICAL RULE: You are FORBIDDEN from guessing or inventing function parameters! If you plan to use an IfcOpenShell API function, but the RAG output did not explicitly list its \`parameters\` and \`signature\`, you MUST do a new targeted \`search_ifc_knowledge\` for that exact function name before writing any Python code. NEVER assume you know the arguments.
- If your execute_ifc_code_tool crashes with a TypeError or missing keyword argument, DO NOT GUESS the fix. Use search_ifc_knowledge again to query the exact function name that failed so you can get the correct signature and adapt.

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
async function executeAgentLoop(history: any[], systemPrompt: string): Promise<{ reply: string; steps: string[]; hasChanges: boolean; reasoning_details?: string | null }> {
  const steps: string[] = [];
  let modelHistory = [...history];
  let loopCount = 0;
  let hasChanges = false;
  const startTime = Date.now();
  const TIME_LIMIT_MS = 125000; // 125s limits to ensure it finishes before frontend drops
  
  while (loopCount < 5) {
    // TIME GUARD: if we're past 125s, stop immediately and return what we have
    const elapsed = Date.now() - startTime;
    if (elapsed > TIME_LIMIT_MS) {
      log(`⏱ TIME GUARD: ${Math.round(elapsed/1000)}s elapsed, stopping to avoid gateway timeout`);
      break;
    }
    
    loopCount++;
    log(`--- Agent Turn ${loopCount} (${Math.round(elapsed/1000)}s elapsed) ---`);
    
    // Calculate remaining time for this DashScope call
    const remainingMs = Math.max(TIME_LIMIT_MS - elapsed, 30000);
    
    const openRouterMessages = [
       { role: "system", content: systemPrompt },
       ...modelHistory
    ];
    
    log(`Calling DashScope API... messages count: ${openRouterMessages.length}`);
    const res = await fetch(DASHSCOPE_URL, {
      method: "POST", headers: { 
         "Content-Type": "application/json",
         "Authorization": `Bearer ${DASHSCOPE_API_KEY}`,
         "HTTP-Referer": "https://infrastudio.tools",
         "X-Title": "InfraStudio"
      },
      body: JSON.stringify({
        model: DASHSCOPE_MODEL,
        messages: openRouterMessages,
        tools: OPENROUTER_TOOLS,
        tool_choice: "auto",
        enable_thinking: false
      }),
      signal: AbortSignal.timeout(remainingMs)
    });
    
    if (!res.ok) {
       const errBody = await res.text().catch(() => "N/A");
       throw new Error(`DashScope API Error: ${res.status} - ${errBody}`);
    }
    
    const json = await res.json();
    const message = json?.choices?.[0]?.message;
    if (!message) {
      log("No message choices returned.");
      break;
    }
    
    modelHistory.push(message);
    
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
        
        modelHistory.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify(callResult)
        });
      }
      
      // After executing code, if we already have changes and are past 80s, skip the summary turn
      const elapsedAfterTool = Date.now() - startTime;
      if (hasChanges && elapsedAfterTool > 80000) {
        log(`⏱ TIME GUARD: ${Math.round(elapsedAfterTool/1000)}s elapsed with changes, skipping summary to preserve time for export`);
        return { reply: "Building complete! Your IFC model has been generated with the requested elements.", steps, hasChanges, reasoning_details: null };
      }
      
      continue;
    }
    
    if (message.content) {
      log(`Final AI Answer received.`);
      return { 
        reply: message.content, 
        steps, 
        hasChanges,
        reasoning_details: message.reasoning_content || message.reasoning_details || null
      };
    }
    
    break;
  }
  
  // If we ran out of turns but have changes, still return success
  if (hasChanges) {
    return { reply: "Building complete! Your IFC model has been generated.", steps, hasChanges, reasoning_details: null };
  }
  return { reply: "I hit a constraint (either time or loop limit) and couldn't complete the task. Often this happens if my code encounters an error I couldn't fix in time.", steps, hasChanges, reasoning_details: null };
}

// ═══════════════════════════════════════════
// HTTP HANDLER
// ═══════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!DASHSCOPE_API_KEY) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  debugLog.length = 0;
  mcpSessionId = "";
  try {
    const payloadMsgs = (await req.json() as any).messages || [];
    if (!payloadMsgs.length) return new Response(JSON.stringify({ error: "No messages" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    
    // Map initial history from frontend to OpenAI format: role/content
    const history = payloadMsgs.map((m: any) => {
      const role = (m.role === "assistant" || m.role === "model") ? "assistant" : "user";
      const obj: any = { role, content: m.content || "" };
      if (m.reasoning_details) {
        obj.reasoning_details = m.reasoning_details;
        obj.reasoning_content = m.reasoning_details;
      }
      return obj;
    });

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
    
    // Initialize MCP and get tool catalog
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
    if (result.reasoning_details) body.reasoning_details = result.reasoning_details;
    if (ifc_url) body.ifc_url = ifc_url;
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    log("FATAL: " + err);
    // Return 200 with the error inside JSON, so the frontend UI can explicitly show "Rate Limit Exceeded" instead of just "non-2xx"
    return new Response(JSON.stringify({ error: String(err).slice(0, 800), debug: debugLog }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
