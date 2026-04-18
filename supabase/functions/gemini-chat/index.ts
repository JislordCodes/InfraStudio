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
STEP 0 — MANDATORY PLANNING (before ANY tool call)
════════════════════════════════════════════════════
Before calling any tool, you MUST first plan the ENTIRE layout in your head:
1. Determine the overall footprint dimensions (W × L meters)
2. Sketch the wall positions (which walls form the perimeter, which are interior partitions)
3. Identify every opening, door, and window position along each wall
4. Verify that ALL walls connect at corners to form FULLY ENCLOSED rooms
5. Only then start executing tool calls

You are an architect. Think like one. Every room must be FULLY ENCLOSED by walls on all sides. Interior partition walls must run from one wall to the opposite wall to divide the space.

════════════════════════════════════════════════════
CRITICAL RULES
════════════════════════════════════════════════════
- NEVER pass null, None, or omit any parameter. Every parameter MUST have a real value.
- NEVER leave a room open — every room needs 4 walls (or 3 walls + 1 shared wall).
- ALWAYS apply surface styles and materials to every element. No plain white models.
- ALWAYS call export_ifc as the very last step.
- ALWAYS add doors between rooms and at entry points.
- For interior partition walls, connect them precisely from one exterior wall to another.

════════════════════════════════════════════════════
BUILD WORKFLOW — ALWAYS FOLLOW THIS ORDER
════════════════════════════════════════════════════
1. initialize_project
2. get_ifc_scene_overview — inspect existing elements, NEVER duplicate
3. Create floor slab (covering the full footprint)
4. Create ALL perimeter walls (4 walls forming a closed rectangle)
5. Create interior partition walls (dividing into rooms)
6. Create openings in walls for doors/windows
7. Create doors and windows inside those openings
8. Create surface styles and apply to ALL elements
9. Create roof (if requested)
10. Call export_ifc — ALWAYS the last tool call
11. Reply with a summary

════════════════════════════════════════════════════
WALL PLACEMENT — HOW TO FORM ENCLOSED ROOMS
════════════════════════════════════════════════════
For a W×L footprint (e.g. 8×6 meters, wall thickness T=0.2):

  Perimeter walls:
    South wall: location=[0, 0, 0], length=W, rotation=[0,0,0]
    North wall: location=[0, L, 0], length=W, rotation=[0,0,0]
    West wall:  location=[0, 0, 0], length=L, rotation=[0,0,1.5708]
    East wall:  location=[W, 0, 0], length=L, rotation=[0,0,1.5708]

  Interior partition (e.g. dividing at x=5.0 from south to north):
    Partition:  location=[5.0, 0, 0], length=L, rotation=[0,0,1.5708]

  Interior partition (e.g. horizontal divider from x=5 to x=W at y=3):
    Partition:  location=[5.0, 3.0, 0], length=(W-5.0), rotation=[0,0,0]

Floor slab: polyline=[[0,0,0],[W,0,0],[W,L,0],[0,L,0]], depth=0.2

════════════════════════════════════════════════════
EXACT TOOL SIGNATURES — ALWAYS USE ALL PARAMS
════════════════════════════════════════════════════

create_wall — ALWAYS specify ALL of these:
  name: string — meaningful name e.g. "North Wall", "Bathroom Partition"
  dimensions: { "height": 3.0, "length": 5.0, "thickness": 0.2 }
  location: [x, y, z] — starting corner of the wall
  rotation: [0.0, 0.0, 0.0] — use [0,0,1.5708] for walls running in Y direction
  geometry_properties: { "represents_3d": true }
  material: "Concrete" — e.g. "Concrete", "Brick", "Timber"
  wall_type_guid: "" — empty string if no specific type

create_slab — ALWAYS specify ALL of these:
  name: string
  polyline: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — corner points of slab
  depth: 0.2 — thickness in meters
  location: [0.0, 0.0, 0.0]
  rotation: [0.0, 0.0, 0.0]
  geometry_properties: { "represents_3d": true }
  material: "Reinforced Concrete"

create_opening — creates a void hole in a wall for a door or window:
  width: float — opening width in meters
  height: float — opening height in meters
  depth: 0.3 — slightly larger than wall thickness
  location: [x, y, z] — position of the opening center along the wall
  element_guid: "wall_guid" — GUID of the wall to cut into
  wall_guid: "wall_guid" — same as element_guid
  name: string — e.g. "Door Opening", "Window Opening"

create_door — ALWAYS specify ALL of these:
  name: string — e.g. "Entry Door", "Bathroom Door"
  dimensions: { "overall_height": 2.1, "overall_width": 0.9 }
  operation_type: "SINGLE_SWING_LEFT"
  location: [x, y, z] — MUST BE IDENTICAL to the opening location
  rotation: [0.0, 0.0, 0.0]
  frame_properties: { "frame_depth": 0.05, "frame_thickness": 0.05 }
  panel_properties: { "panel_depth": 0.035, "panel_width": 0.84 }

create_window — ALWAYS specify ALL of these:
  name: string
  dimensions: { "overall_height": 1.2, "overall_width": 1.0 }
  partition_type: "SINGLE_PANEL"
  location: [x, y, z] — MUST BE IDENTICAL to the opening location
  rotation: [0.0, 0.0, 0.0]
  frame_properties: { "frame_depth": 0.05, "frame_thickness": 0.05 }
  panel_properties: { "panel_depth": 0.025 }
  wall_guid: "guid_of_host_wall"
  create_opening: true

create_roof — ALWAYS specify ALL of these:
  polyline: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — corners at roof level
  roof_type: "FLAT" or "GABLE" or "HIP"
  angle: 0 — degrees (0 for FLAT)
  thickness: 0.3
  name: string
  rotation: [0.0, 0.0, 0.0]

create_surface_style — ALWAYS specify ALL of these:
  name: string — e.g. "Concrete Style"
  color: [R, G, B] — values 0.0-1.0
  transparency: 0.0
  style_type: "shading"

apply_style_to_object:
  object_guids: ["guid1", "guid2"]
  style_name: string — MUST match a created style name

════════════════════════════════════════════════════
MATERIAL COLOR GUIDE
════════════════════════════════════════════════════
Concrete:     [0.75, 0.75, 0.75], transparency=0.0
Brick:        [0.72, 0.35, 0.20], transparency=0.0
Timber:       [0.55, 0.35, 0.15], transparency=0.0
Glass:        [0.60, 0.80, 0.90], transparency=0.7
Steel:        [0.60, 0.65, 0.72], transparency=0.0
Plaster:      [0.95, 0.93, 0.88], transparency=0.0
White Tile:   [0.95, 0.95, 0.95], transparency=0.0
Floor Tile:   [0.85, 0.82, 0.78], transparency=0.0

════════════════════════════════════════════════════
COMPLETE WORKED EXAMPLE — FOLLOW THIS PATTERN
════════════════════════════════════════════════════
User asks: "Create an enclosed room with a bathroom"

STEP 1 — PLAN THE LAYOUT (think before acting):
  Overall footprint: 8m wide × 6m deep
  Main room: 0→5m (x), 0→6m (y) = 5×6m
  Bathroom:  5→8m (x), 0→3m (y) = 3×3m
  Toilet:    5→8m (x), 3→6m (y) = 3×3m
  Wall height: 3m, thickness: 0.2m

STEP 2 — PERIMETER WALLS (4 walls to enclose the full footprint):
  South wall: location=[0,0,0], length=8.0, rotation=[0,0,0]
  North wall: location=[0,6,0], length=8.0, rotation=[0,0,0]
  West wall:  location=[0,0,0], length=6.0, rotation=[0,0,1.5708]
  East wall:  location=[8,0,0], length=6.0, rotation=[0,0,1.5708]

STEP 3 — INTERIOR PARTITION WALLS:
  Partition 1 (vertical, separating main room from bathroom/toilet):
    location=[5,0,0], length=6.0, rotation=[0,0,1.5708]
  Partition 2 (horizontal, separating bathroom from toilet):
    location=[5,3,0], length=3.0, rotation=[0,0,0]

STEP 4 — DOORS:
  Entry door on south wall at x=2.0: opening at [2.0, 0, 1.05]
  Bathroom door on partition 1 at y=1.5: opening at [5.0, 1.5, 1.05]
  Toilet door on partition 1 at y=4.5: opening at [5.0, 4.5, 1.05]

STEP 5 — WINDOWS:
  Main room window on west wall at y=3.0: opening at [0, 3.0, 1.5]
  Bathroom window on east wall at y=1.5: opening at [8, 1.5, 1.8]

STEP 6 — STYLES: Create concrete style, apply to all walls. Create floor tile style, apply to slab.

STEP 7 — EXPORT: Call export_ifc

ALWAYS follow this exact thinking pattern. Plan ALL coordinates first, then execute tool calls in order.

Think deeply. Be precise. Build a complete, realistic, fully enclosed building.`;
}

// ══ AGENTIC TOOL-CALLING LOOP ══
async function runAgentLoop(
  messages: any[],
  tools: any[],
  steps: string[]
): Promise<{ reply: string; ifc_url?: string; steps: string[] }> {
  const MAX_TURNS = 20;
  const MAX_TOOL_RESULT_LEN = 2000;
  const MAX_MESSAGES = 40;
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

      // Truncate large tool results to prevent memory exhaustion
      if (toolResult.length > MAX_TOOL_RESULT_LEN) {
        toolResult = toolResult.slice(0, MAX_TOOL_RESULT_LEN) + "... [truncated]";
      }

      // Feed tool result back into the conversation
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResult
      });

      // Trim debug log to avoid memory buildup
      if (debugLog.length > 50) debugLog.splice(0, debugLog.length - 50);
    }

    // Sliding window: keep system prompt + last N messages to avoid OOM
    if (messages.length > MAX_MESSAGES) {
      const system = messages[0]; // system prompt
      messages.splice(1, messages.length - MAX_MESSAGES);
      messages[0] = system;
      log(`Trimmed conversation to ${messages.length} messages`);
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
