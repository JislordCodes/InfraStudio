import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ══ CONFIG ══
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const MODAL_API_KEY = Deno.env.get("MODAL_API_KEY") || "";
const LLM_MODEL = "zai-org/GLM-5.1-FP8";
const LLM_URL = "https://api.us-west-2.modal.direct/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "9.0" } }
  });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
}

async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await mcpPost({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args }
  }) as Record<string, unknown>;
  return extractText((res?.result as Record<string, unknown>)?.content) || JSON.stringify(res?.result ?? res?.error ?? "done");
}

async function fetchMcpTools(): Promise<any[]> {
  const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as Record<string, unknown>;
  const tools = ((res?.result as any)?.tools || []) as any[];
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: (t.description || "").slice(0, 1024),
      parameters: t.inputSchema || { type: "object", properties: {} }
    }
  }));
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

    if (action === "init") {
      // Initialize MCP and return the tool list + system prompt
      await mcpInit();
      const tools = await fetchMcpTools();
      return new Response(JSON.stringify({
        tools,
        system_prompt: buildSystemPrompt(),
        session_id: mcpSessionId,
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

      // Make sure MCP is initialized
      if (!mcpSessionId) await mcpInit();

      const result = await mcpCallTool(name, args || {});

      // Truncate large results to avoid bloating the chat history
      const truncated = result.length > 3000 ? result.slice(0, 3000) + "... [truncated]" : result;

      return new Response(JSON.stringify({
        result: truncated,
        session_id: mcpSessionId,
      }), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }


    if (action === "chat") {
      const modalKey = Deno.env.get("MODAL_API_KEY");
      if (!modalKey) {
        return new Response(JSON.stringify({ error: "MODAL_API_KEY secret is missing in Edge Function environment" }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      const { messages, tools } = payload;
      
      const res = await fetch(LLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${modalKey}`
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: messages || [],
          ...(tools && { tools, tool_choice: "auto" }),
          temperature: 0.5,
          max_tokens: 8192,
          stream: false
        }),
        signal: AbortSignal.timeout(60000)
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

You are an architect. Think like one. Every room must be FULLY ENCLOSED by walls on all sides. You MUST create exactly 4 walls for a basic rectangular room.

════════════════════════════════════════════════════
CRITICAL RULES
════════════════════════════════════════════════════
- NEVER pass null, None, or omit any parameter. Every parameter MUST have a real value.
- NEVER leave a room open! A room MUST ALWAYS have 4 perimeter walls. Do not stop until all 4 walls are created to enclose the space!
- ALWAYS apply surface styles and materials to every element. No plain white models.
- ALWAYS call export_ifc as the very last step.
- ALWAYS add doors between rooms and at entry points.

════════════════════════════════════════════════════
BUILD WORKFLOW — ALWAYS FOLLOW THIS ORDER
════════════════════════════════════════════════════
1. get_ifc_scene_overview — inspect existing elements
2. Create floor slab (covering the full footprint)
3. Create WALL 1 (South)
4. Create WALL 2 (North)
5. Create WALL 3 (West)
6. Create WALL 4 (East) -> DO NOT SKIP THIS. Confirm all 4 walls enclose the room.
7. Create doors and windows inside walls (Set create_opening: true to automatically cut holes)
8. Create surface styles and apply to ALL elements
9. Call export_ifc — ALWAYS the last tool call
10. Reply with a summary

════════════════════════════════════════════════════
WALL PLACEMENT — HOW TO FORM ENCLOSED ROOMS
════════════════════════════════════════════════════
For a W×L footprint (e.g. 8×6 meters, wall thickness T=0.2):

  Perimeter walls: (You must explicitly call create_wall 4 times)
    South wall: location=[0, 0, 0], length=W, rotation=[0,0,0]
    North wall: location=[0, L, 0], length=W, rotation=[0,0,0]
    West wall:  location=[0, 0, 0], length=L, rotation=[0,0,90.0]
    East wall:  location=[W, 0, 0], length=L, rotation=[0,0,90.0]

Floor slab: polyline=[[0,0,0],[W,0,0],[W,L,0],[0,L,0]], depth=0.2

════════════════════════════════════════════════════
EXACT TOOL SIGNATURES — ALWAYS USE ALL PARAMS
════════════════════════════════════════════════════

create_wall — ALWAYS specify ALL of these:
  name: string — meaningful name e.g. "North Wall", "Bathroom Partition"
  dimensions: { "height": 3.0, "length": 5.0, "thickness": 0.2 }
  location: [x, y, z] — starting corner of the wall
  rotation: [0.0, 0.0, 0.0] — CRITICAL: USE DEGREES! e.g., use [0,0,90.0] for walls running in Y direction
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
  location: [x, y, z] — EXACTLY on the wall line. For a wall along X-axis, y must match wall y.
  rotation: [0.0, 0.0, 0.0] — CRITICAL: MUST EXACTLY MATCH THE HOST WALL'S ROTATION! If the wall is rotated [0,0,90.0], the door MUST be rotated [0,0,90.0].
  frame_properties: { "frame_depth": 0.05, "frame_thickness": 0.05 }
  panel_properties: { "panel_depth": 0.035, "panel_width": 0.84 }
  wall_guid: "guid_of_host_wall"
  create_opening: true

create_window — ALWAYS specify ALL of these:
  name: string
  dimensions: { "overall_height": 1.2, "overall_width": 1.0 }
  partition_type: "SINGLE_PANEL"
  location: [x, y, z] — EXACTLY on the wall line (e.g., Z=1.0 for sill height).
  rotation: [0.0, 0.0, 0.0] — CRITICAL: MUST EXACTLY MATCH THE HOST WALL'S ROTATION! If the wall is rotated [0,0,90.0], the window MUST be rotated [0,0,90.0] or it will float in the air.
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
HOW TO PLAN ANY BUILDING — MANDATORY THINKING PROCESS
════════════════════════════════════════════════════
Before making ANY tool call, you MUST think through these steps for EVERY request:

STEP A — DETERMINE THE FOOTPRINT:
  Read the user's request carefully. Decide the overall rectangular footprint W×L.
  If the user says "a room", pick a realistic size (e.g. 6×5m for a bedroom, 8×6m for a living room).
  If the user says "a house", pick a full house footprint (e.g. 12×10m).
  If the user specifies dimensions, use exactly those.

STEP B — PLAN EVERY ROOM:
  Divide the footprint into rooms. For each room, define its X and Y range:
    Room 1: x=[0 → Xdiv], y=[0 → L]    (the main/larger room)
    Room 2: x=[Xdiv → W], y=[0 → Ydiv]  (a smaller room like bathroom)
    Room 3: x=[Xdiv → W], y=[Ydiv → L]  (another room like toilet)
  Every room MUST be fully enclosed by walls on ALL 4 sides (exterior + partition walls).

STEP C — COMPUTE WALL COORDINATES:
  Perimeter (these ALWAYS exist for any enclosed building):
    South wall: location=[0, 0, 0],   length=W,   rotation=[0,0,0]
    North wall: location=[0, L, 0],   length=W,   rotation=[0,0,0]
    West wall:  location=[0, 0, 0],   length=L,   rotation=[0,0,1.5708]
    East wall:  location=[W, 0, 0],   length=L,   rotation=[0,0,1.5708]
  Partition walls (to divide rooms):
    Vertical partition at x=Xdiv:   location=[Xdiv, 0, 0], length=L, rotation=[0,0,1.5708]
    Horizontal partition at y=Ydiv: location=[Xdiv, Ydiv, 0], length=(W-Xdiv), rotation=[0,0,0]
  ALL walls: height=3.0, thickness=0.2

STEP D — PLAN DOORS AND WINDOWS:
  Every room needs at least one door for access.
  Door opening z-position: half the door height (e.g. z=1.05 for a 2.1m door)
  Window opening z-position: typically 1.0-1.5m above floor
  Door/window location MUST be along the wall they sit in.
  For a door on a south wall (runs in X): location=[X_pos_along_wall, 0, z]
  For a door on a west wall (runs in Y):  location=[0, Y_pos_along_wall, z]
  For a door on a partition at x=Xdiv:    location=[Xdiv, Y_pos, z]

STEP E — PLAN MATERIALS:
  Create a surface style for EVERY material type used (concrete, brick, glass, tile, etc.)
  Apply the appropriate style to EVERY element. No element should be left unstyled.

STEP F — EXECUTE: Now call tools in this order:
  1. initialize_project → 2. create_slab → 3. all create_wall calls → 4. create_opening for each door/window → 5. create_door / create_window → 6. create_surface_style → 7. apply_style_to_object → 8. create_roof (if needed) → 9. export_ifc

IMPORTANT RULES FOR ANY REQUEST:
- If the user asks for "a room" → build 4 walls forming a closed rectangle. No open sides.
- If the user asks for multiple rooms → every room must be enclosed. Use partition walls.
- If the user asks for specific room types (bedroom, kitchen, bathroom) → use appropriate sizes.
- If the user doesn't specify dimensions → use realistic architectural dimensions.
- ALWAYS add an entry door. ALWAYS add windows for natural light.
- NEVER leave any wall gap. Walls must meet at corners precisely.
- NEVER skip applying materials/styles. The model must look realistic.

Think deeply. Be precise. Build a complete, realistic, fully enclosed building.`;
}
