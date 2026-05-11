import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ══ CONFIG ══
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const QWEN_API_KEY = Deno.env.get("QWEN_API_KEY") ?? "";
const LLM_MODEL = "qwen-max-latest";
const LLM_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ══ MCP CLIENT ══

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

async function mcpPost(body: unknown, clientSessionId: string): Promise<{ data: unknown; session: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (clientSessionId) headers["mcp-session-id"] = clientSessionId;
  
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  
  const returnedSession = res.headers.get("mcp-session-id") || clientSessionId;
  const text = await res.text();
  
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    const data = l ? JSON.parse(l.slice(5).trim()) : {};
    return { data, session: returnedSession };
  }
  
  try { 
    return { data: JSON.parse(text), session: returnedSession }; 
  } catch { 
    return { data: { raw: text }, session: returnedSession }; 
  }
}

async function mcpInit(clientSessionId: string): Promise<string> {
  const res1 = await mcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "9.0" } }
  }, clientSessionId);
  
  const newSession = res1.session;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, newSession).catch(() => {});
  
  return newSession;
}

async function mcpCallTool(name: string, args: Record<string, unknown>, clientSessionId: string): Promise<{ resultText: string, session: string }> {
  const res = await mcpPost({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args }
  }, clientSessionId);
  
  const payload = res.data as Record<string, unknown>;
  const resultText = extractText((payload?.result as Record<string, unknown>)?.content) || JSON.stringify(payload?.result ?? payload?.error ?? "done");
  
  return { resultText, session: res.session };
}

async function fetchMcpTools(clientSessionId: string): Promise<{ tools: any[], session: string }> {
  const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, clientSessionId);
  const data = res.data as Record<string, unknown>;
  const tools = ((data?.result as any)?.tools || []) as any[];
  
  return {
    tools: tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: (t.description || "").slice(0, 1024),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}

// ══ HTTP HANDLER — MCP PROXY ══
// The frontend runs the LLM (Puter.js + Claude, free).
// This Edge Function is just a proxy for MCP tool operations.
//
// Actions:
//   { action: "init" }         → initializes MCP session, returns tools + system prompt
//   { action: "call_tool", name: "...", args: {...} }  → executes a tool, returns result

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }

  try {
    const payload = await req.json();
    const action = payload.action || "init";
    const inboundSessionId = payload.session_id || "";

    if (action === "init") {
      // Initialize MCP and return the tool list + system prompt
      const initSession = await mcpInit(inboundSessionId);
      const toolsResult = await fetchMcpTools(initSession);
      
      return new Response(JSON.stringify({
        tools: toolsResult.tools,
        system_prompt: buildSystemPrompt(),
        session_id: toolsResult.session,
      }), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    if (action === "call_tool") {
      const { name, args } = payload;
      if (!name) {
        return new Response(JSON.stringify({ error: "Missing tool name" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      // If no session passed, init one implicitly and then call
      let activeSession = inboundSessionId;
      if (!activeSession) {
        activeSession = await mcpInit("");
      }

      const { resultText, session } = await mcpCallTool(name, args || {}, activeSession);

      // Truncate large results to avoid bloating the chat history
      const truncated = resultText.length > 3000 ? resultText.slice(0, 3000) + "... [truncated]" : resultText;

      return new Response(JSON.stringify({
        result: truncated,
        session_id: session,
      }), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }


    if (action === "chat") {
      const apiKey = Deno.env.get("QWEN_API_KEY") || "";
      const { messages, tools } = payload;

      // Qwen supports native OpenAI-compatible tool calling
      const res = await fetch(LLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: messages || [],
          ...(tools && tools.length > 0 && { tools, tool_choice: "auto" }),
          max_tokens: 4096,
          enable_thinking: false
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `LLM API error ${res.status}: ${errText.slice(0, 300)}` }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      const llmData = await res.json();
      return new Response(JSON.stringify(llmData), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err).slice(0, 800),
      status: "error"
    }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
});

// ══ SYSTEM PROMPT ══
function buildSystemPrompt(): string {
  return `You are InfraStudio — an expert AI BIM architect. You build complete, realistic IFC models by calling MCP tools.

════════════════════════════════════════════════════
COORDINATE SYSTEM
════════════════════════════════════════════════════
Right-hand rule: X = East, Y = North, Z = Up. All units: METERS.
Rotation is in RADIANS: 90° = 1.5708 rad.

A wall along the X-axis: rotation=[0, 0, 0]
A wall along the Y-axis: rotation=[0, 0, 1.5708]

════════════════════════════════════════════════════
CRITICAL RULE: ENCLOSED ROOMS
════════════════════════════════════════════════════
Every room MUST have exactly 4 walls forming a CLOSED rectangle. No open sides. EVER.

For a room W meters wide × L meters deep:
  South wall: location=[0, 0, 0],   length=W, rotation=[0, 0, 0]
  North wall: location=[0, L, 0],   length=W, rotation=[0, 0, 0]
  West wall:  location=[0, 0, 0],   length=L, rotation=[0, 0, 1.5708]
  East wall:  location=[W, 0, 0],   length=L, rotation=[0, 0, 1.5708]

All walls: height=3.0, thickness=0.2. Floor slab covers entire footprint.

════════════════════════════════════════════════════
DOORS AND WINDOWS — ONE-STEP METHOD (MANDATORY)
════════════════════════════════════════════════════
IMPORTANT: Both create_door and create_window support automatic opening creation.
Just pass wall_guid and create_opening=true. The backend will:
  1. Cut the opening hole in the wall
  2. Create the door/window element
  3. Fill the opening with the element
ALL IN ONE STEP. You do NOT need to call create_opening or fill_opening separately.

For a door in a wall along X-axis (e.g. South wall starting at [0,0,0], length=6):
  create_door(
    name="Entry Door",
    dimensions={"overall_height": 2.1, "overall_width": 0.9},
    operation_type="SINGLE_SWING_LEFT",
    location=[3.0, 0.0, 0.0],
    rotation=[0.0, 0.0, 0.0],
    wall_guid="<south_wall_guid>",
    create_opening=true
  )

For a window in a wall along Y-axis (e.g. West wall starting at [0,0,0], rotation 90°):
  create_window(
    name="West Window",
    dimensions={"overall_height": 1.5, "overall_width": 1.2},
    partition_type="SINGLE_PANEL",
    location=[0.0, 2.5, 1.0],
    rotation=[0.0, 0.0, 1.5708],
    wall_guid="<west_wall_guid>",
    create_opening=true
  )

PLACEMENT RULES:
- Door/window location MUST be ON the wall line (same x or y as wall start).
- Door/window rotation MUST EXACTLY MATCH the host wall's rotation.
- Door Z = 0.0 (floor level). Window Z = sill height (typically 1.0m).
- Do NOT call create_opening or fill_opening separately — use the one-step method above.

════════════════════════════════════════════════════
BUILD WORKFLOW — ALWAYS THIS ORDER
════════════════════════════════════════════════════
1. initialize_project (only for new sessions)
2. create_slab (floor covering full footprint)
3. create_wall × 4 (forming closed rectangle)
4. create_door / create_window with wall_guid + create_opening=true
5. create_surface_style for each material
6. apply_style_to_object for every element
7. export_ifc (ALWAYS the final step)

════════════════════════════════════════════════════
TOOL PARAMETER RULES
════════════════════════════════════════════════════
- NEVER pass null, None, or empty strings. Every parameter needs a real value.
- dimensions: always an object like {"height": 3.0, "length": 5.0, "thickness": 0.2}
- location: always [x, y, z] like [0.0, 0.0, 0.0]
- rotation: always [rx, ry, rz] in RADIANS like [0.0, 0.0, 0.0]
- material: a string like "Concrete", "Timber", "Steel", "Brick"

════════════════════════════════════════════════════
MATERIAL COLOR GUIDE
════════════════════════════════════════════════════
Concrete:   [0.75, 0.75, 0.75], transparency=0.0
Brick:      [0.72, 0.35, 0.20], transparency=0.0
Wood/Timber:[0.55, 0.35, 0.15], transparency=0.0
Glass:      [0.60, 0.80, 0.90], transparency=0.7
Steel:      [0.60, 0.65, 0.72], transparency=0.0
Plaster:    [0.95, 0.93, 0.88], transparency=0.0

════════════════════════════════════════════════════
EDITING EXISTING ELEMENTS
════════════════════════════════════════════════════
When the user wants modifications:
1. Call get_scene_info to see all elements + GUIDs
2. Use the GUIDs to reference elements for updates
3. Do NOT call initialize_project — that would erase everything
4. Call export_ifc after changes

════════════════════════════════════════════════════
COMPLETE EXAMPLE: "Create a room with a door and window"
════════════════════════════════════════════════════
Plan: 6m × 5m room, door on south wall, window on west wall.

Step 1: create_slab(name="Floor", polyline=[[0,0],[6,0],[6,5],[0,5]], depth=0.2, location=[0,0,0], rotation=[0,0,0], material="Reinforced Concrete")
Step 2: create_wall(name="South Wall", dimensions={"height":3,"length":6,"thickness":0.2}, location=[0,0,0], rotation=[0,0,0], material="Concrete") → south_guid
Step 3: create_wall(name="North Wall", dimensions={"height":3,"length":6,"thickness":0.2}, location=[0,5,0], rotation=[0,0,0], material="Concrete")
Step 4: create_wall(name="West Wall", dimensions={"height":3,"length":5,"thickness":0.2}, location=[0,0,0], rotation=[0,0,1.5708], material="Concrete") → west_guid
Step 5: create_wall(name="East Wall", dimensions={"height":3,"length":5,"thickness":0.2}, location=[6,0,0], rotation=[0,0,1.5708], material="Concrete")
Step 6: create_door(name="Entry Door", dimensions={"overall_height":2.1,"overall_width":0.9}, location=[3,0,0], rotation=[0,0,0], wall_guid=south_guid, create_opening=true)
Step 7: create_window(name="West Window", dimensions={"overall_height":1.5,"overall_width":1.2}, location=[0,2.5,1.0], rotation=[0,0,1.5708], wall_guid=west_guid, create_opening=true)
Step 8: Create surface styles + apply to all elements
Step 9: export_ifc()

Think carefully. Be precise with coordinates. Build complete, enclosed, realistic architecture.`;
}
