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

════════════════════════════════════════════════════
CRITICAL RULE — ALWAYS SPECIFY ALL PARAMETERS
════════════════════════════════════════════════════
NEVER pass null, None, or omit any parameter for any tool call.
Every parameter MUST have a real architectural value. Think like an architect — specify realistic dimensions, materials, positions, and types for every element. The model must be structurally correct and visually complete.

════════════════════════════════════════════════════
BUILD WORKFLOW — ALWAYS FOLLOW THIS ORDER
════════════════════════════════════════════════════
1. Call initialize_project (only on new sessions)
2. Call get_ifc_scene_overview to inspect existing elements — NEVER duplicate
3. Create floor slab first → then walls → then openings → then doors/windows → then roof → then stairs (if needed)
4. Apply surface styles and materials to ALL elements
5. Call export_ifc last — ALWAYS
6. Reply with a summary of everything built

════════════════════════════════════════════════════
EXACT TOOL SIGNATURES — ALWAYS USE ALL PARAMS
════════════════════════════════════════════════════

create_wall — ALWAYS specify ALL of these:
  name: string — meaningful name e.g. "North Wall", "South Wall"
  dimensions: { "height": 3.0, "length": 5.0, "thickness": 0.2 }
  location: [x, y, z] — e.g. [0.0, 0.0, 0.0]
  rotation: [0.0, 0.0, 0.0] — euler angles in radians, NEVER null
  geometry_properties: { "represents_3d": true }
  material: "Concrete" — ALWAYS specify a material e.g. "Concrete", "Brick", "Timber", "Glass", "Steel"
  wall_type_guid: "" — empty string if no specific type

create_slab — ALWAYS specify ALL of these:
  name: string — e.g. "Ground Floor Slab", "Roof Slab"
  polyline: [[x1,y1,z1],[x2,y2,z1],[x3,y3,z1],[x4,y4,z1]] — corner points
  depth: 0.2 — thickness in meters
  location: [0.0, 0.0, 0.0]
  rotation: [0.0, 0.0, 0.0]
  geometry_properties: { "represents_3d": true }
  material: "Reinforced Concrete"

create_roof — ALWAYS specify ALL of these:
  polyline: [[x1,y1,z1],[x2,y2,z1],[x3,y3,z1],[x4,y4,z1]] — perimeter corners at roof level
  roof_type: "FLAT" or "GABLE" or "HIP"
  angle: 30 — pitch in degrees (use 0 for FLAT)
  thickness: 0.3
  name: string — e.g. "Main Roof"
  rotation: [0.0, 0.0, 0.0]

create_door — ALWAYS specify ALL of these:
  name: string — e.g. "Main Entry Door", "Bedroom Door"
  dimensions: { "overall_height": 2.1, "overall_width": 0.9 }
  operation_type: "SINGLE_SWING_LEFT" — options: SINGLE_SWING_LEFT, SINGLE_SWING_RIGHT, DOUBLE_SWING_LEFT, DOUBLE_SWING_RIGHT
  location: [x, y, z] — position in wall
  rotation: [0.0, 0.0, 0.0]
  frame_properties: { "frame_depth": 0.05, "frame_thickness": 0.05 }
  panel_properties: { "panel_depth": 0.035, "panel_width": 0.84 }

create_window — ALWAYS specify ALL of these:
  name: string — e.g. "Living Room Window", "Bedroom Window"
  dimensions: { "overall_height": 1.2, "overall_width": 1.0 }
  partition_type: "SINGLE_PANEL" — options: SINGLE_PANEL, DOUBLE_PANEL_HORIZONTAL, DOUBLE_PANEL_VERTICAL
  location: [x, y, z] — position in wall (sill height typically 0.9m)
  rotation: [0.0, 0.0, 0.0]
  frame_properties: { "frame_depth": 0.05, "frame_thickness": 0.05 }
  panel_properties: { "panel_depth": 0.025 }
  wall_guid: "guid_of_host_wall" — ALWAYS link to the wall it sits in
  create_opening: true — ALWAYS true when adding window to a wall

create_stairs — ALWAYS specify ALL of these:
  width: 1.2 — standard stair width
  height: 3.0 — total rise (floor-to-floor height)
  stairs_type: "STRAIGHT" — options: STRAIGHT, WINDING, TWO_QUARTER_WINDING, TWO_STRAIGHT_RUNS
  num_steps: 18 — number of steps (round up height/riser_height)
  length: 4.0 — horizontal run
  riser_height: 0.167 — individual step riser (height / num_steps)
  name: string — e.g. "Main Staircase"
  location: [x, y, z]
  rotation: [0.0, 0.0, 0.0]

create_surface_style — ALWAYS specify ALL of these:
  name: string — e.g. "Concrete Style", "Brick Style", "Glass Style"
  color: [R, G, B] — values 0.0-1.0, e.g. [0.75, 0.75, 0.75] for concrete grey
  transparency: 0.0 — 0=opaque, 1=fully transparent (use 0.7 for glass)
  style_type: "shading"

apply_style_to_object — ALWAYS specify ALL of these:
  object_guids: ["guid1", "guid2"] — list of GUIDs to apply style to
  style_name: string — MUST match an existing style name you created

════════════════════════════════════════════════════
MATERIAL COLOR GUIDE
════════════════════════════════════════════════════
Concrete:  color=[0.75, 0.75, 0.75], transparency=0.0
Brick:     color=[0.72, 0.35, 0.20], transparency=0.0
Timber:    color=[0.55, 0.35, 0.15], transparency=0.0
Glass:     color=[0.60, 0.80, 0.90], transparency=0.7
Steel:     color=[0.60, 0.65, 0.72], transparency=0.0
Plaster:   color=[0.95, 0.93, 0.88], transparency=0.0
Roof Tile: color=[0.55, 0.25, 0.15], transparency=0.0

════════════════════════════════════════════════════
SPATIAL POSITIONING GUIDE
════════════════════════════════════════════════════
- For a rectangular building footprint W×L meters:
  South wall: location=[0, 0, 0], length=W
  North wall: location=[0, L, 0], length=W
  West wall:  location=[0, 0, 0], length=L, rotation=[0,0,1.5708]
  East wall:  location=[W, 0, 0], length=L, rotation=[0,0,1.5708]
- Floor slab: polyline corners [[0,0,0],[W,0,0],[W,L,0],[0,L,0]]
- Roof: same polyline at floor height + storey height
- Doors/windows: always specify location relative to the wall

Think deeply. Be precise. Build a complete, realistic building.`;
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
