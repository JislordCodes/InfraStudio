import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ══ CONFIG ══
const LLM_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LLM_MODEL = "gemma-4-31b-it";
const LLM_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ══ LOGGING ══
const debugLog: string[] = [];
function log(msg: string) { console.log(msg); debugLog.push(msg); }

// ══ MCP CLIENT ══
let mcpSessionId = "";

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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  const s = res.headers.get("mcp-session-id");
  if (s) mcpSessionId = s;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    return l ? JSON.parse(l.slice(5).trim()) : {};
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function mcpInit(): Promise<void> {
  await mcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "8.0" } }
  });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
  log("MCP ready");
}

async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<string> {
  log(`CALL ${name}(${JSON.stringify(args).slice(0, 200)})`);
  const res = await mcpPost({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args }
  }) as Record<string, unknown>;
  const text = extractText((res?.result as Record<string, unknown>)?.content) || JSON.stringify(res?.result ?? res?.error ?? "done");
  log(`=> ${name}: ${text.slice(0, 300)}`);
  return text;
}

// ══ FETCH FULL TOOL LIST FOR THE LLM ══
let cachedMcpTools: any[] = [];
async function fetchMcpTools(): Promise<any[]> {
  if (cachedMcpTools.length > 0) return cachedMcpTools;
  try {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as Record<string, unknown>;
    const tools = ((res?.result as any)?.tools || []) as any[];
    // Convert MCP tool schema → OpenAI function schema
    cachedMcpTools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: (t.description || "").slice(0, 1024),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    }));
    log(`Loaded ${cachedMcpTools.length} MCP tools for LLM`);
    return cachedMcpTools;
  } catch (e) {
    log("Failed to load tool catalog: " + e);
    return [];
  }
}

// ══ SYSTEM PROMPT ══
function buildSystemPrompt(): string {
  return `You are InfraStudio — an expert AI BIM architect. Your job is to build complete, realistic, architectural IFC models by calling the available MCP tools.

IMPORTANT RULES:
1. Always call initialize_project first ONLY if this is a brand new conversation (the user has not built anything yet).
2. THINK DEEPLY before calling each tool. Consider spatial relationships, structural logic, and realistic dimensions.
3. Build STEP BY STEP: initialize → create structure → add walls → add openings → add doors/windows → add slabs/roofs → add stairs if needed → apply materials/styles → export.
4. NEVER skip geometry steps. Every element needs to be fully created with correct parameters.
5. After all elements are created, ALWAYS call export_ifc to save and return the model.
6. Be realistic: a simple house has 4+ walls, at least 1 floor slab, a roof, 1+ doors, windows.
7. Check what already exists in the scene using get_ifc_scene_overview before adding more elements to avoid duplication.
8. Name elements meaningfully (e.g. "North Wall", "Entry Door", "Ground Floor Slab").
9. You MUST keep calling tools until the building is complete and exported. Do not stop early.
10. After export_ifc succeeds, reply with a concise summary of what you built.`;
}

// ══ AGENTIC TOOL-CALLING LOOP ══
async function runAgentLoop(
  messages: any[],
  tools: any[],
  steps: string[]
): Promise<{ reply: string; ifc_url?: string; steps: string[] }> {
  const MAX_TURNS = 30;
  let ifc_url: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    log(`Agent turn ${turn + 1}/${MAX_TURNS}`);

    // Call LLM with full tool schema
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.5,
        max_tokens: 4096,
        stream: false
      }),
      signal: AbortSignal.timeout(90000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const llmData = await res.json();
    const choice = llmData.choices?.[0];
    if (!choice) throw new Error("No LLM response choice");

    const assistantMsg = choice.message;
    // Strip <thought> tags from content if present
    if (assistantMsg.content) {
      assistantMsg.content = assistantMsg.content.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim();
    }

    messages.push(assistantMsg);

    const finishReason = choice.finish_reason;
    const toolCalls = assistantMsg.tool_calls || [];

    // No tool calls → agent is done
    if (toolCalls.length === 0 || finishReason === "stop") {
      const reply = assistantMsg.content || "I have completed building your IFC model.";
      return { reply, ifc_url, steps };
    }

    // Execute each tool call
    for (const call of toolCalls) {
      const toolName = call.function?.name;
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(call.function?.arguments || "{}");
      } catch {
        toolArgs = {};
      }

      steps.push(`🔧 ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);

      let toolResult = "";
      try {
        toolResult = await mcpCallTool(toolName, toolArgs);

        // Track IFC URL from export_ifc
        if (toolName === "export_ifc") {
          try {
            const parsed = JSON.parse(toolResult);
            if (parsed.file_url) ifc_url = parsed.file_url;
            else if (parsed.success && parsed.ifc_url) ifc_url = parsed.ifc_url;
          } catch {}
        }

        steps.push(`  ✓ ${toolResult.slice(0, 100)}`);
      } catch (e) {
        toolResult = JSON.stringify({ error: String(e) });
        steps.push(`  ✗ Error: ${String(e).slice(0, 100)}`);
      }

      // Feed tool result back into the conversation
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResult
      });
    }
  }

  return { reply: "Building complete (max turns reached).", ifc_url, steps };
}

// ══ HTTP HANDLER ══
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!LLM_API_KEY) return new Response(JSON.stringify({ error: "No API key configured" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });

  debugLog.length = 0;

  try {
    const payload = await req.json() as any;
    mcpSessionId = payload.session_id || "";

    const incomingMsgs: any[] = payload.messages || [];
    if (!incomingMsgs.length) {
      return new Response(JSON.stringify({ error: "No messages provided" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // Strip any internal helper tags from history if passed from frontend
    const cleanHistory = incomingMsgs
      .filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .filter(m => !m.content?.includes("[INFRASTUDIO_RAG_DONE]") && !m.content?.includes("[INFRASTUDIO_EXEC_ERROR]"))
      .map(m => ({ role: m.role, content: m.content || "", ...(m.tool_calls && { tool_calls: m.tool_calls }), ...(m.tool_call_id && { tool_call_id: m.tool_call_id }) }));

    // Init MCP
    await mcpInit();

    // Fetch all available tools
    const tools = await fetchMcpTools();

    // Build message array: system + clean history
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...cleanHistory
    ];

    const steps: string[] = [];

    log(`Starting agent loop | ${tools.length} tools | ${messages.length} messages`);

    const result = await runAgentLoop(messages, tools, steps);

    const responseBody = {
      status: "completed",
      reply: result.reply,
      ifc_url: result.ifc_url,
      steps: result.steps,
      success: true,
      session_id: mcpSessionId,
      debug: debugLog
    };

    return new Response(JSON.stringify(responseBody), {
      headers: { ...CORS, "Content-Type": "application/json" }
    });

  } catch (err) {
    log("FATAL: " + err);
    return new Response(JSON.stringify({
      error: String(err).slice(0, 800),
      debug: debugLog,
      status: "error"
    }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
});
