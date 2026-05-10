/**
 * Client-side agentic loop.
 * - Edge Function handles: init (MCP), call_tool (MCP), chat (LLM)
 * - Enforces strict material/style workflow and spatial reasoning
 */

// ══ CONFIG ══
const EDGE_PROXY_URL = "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1/gemini-chat";
const MAX_TURNS = 25;

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

// ══ EDGE FUNCTION PROXY ══

async function proxyRequest(action: string, payload: Record<string, unknown> = {}, clientSessionId: string = ''): Promise<any> {
  const res = await fetch(EDGE_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({
      action,
      session_id: clientSessionId,
      ...payload
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Proxy Error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  
  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
    throw new Error(`Edge Proxy Error: ${errMsg}`);
  }

  return data;
}

// ══ ARGUMENT SANITIZER ══
// Recursively strip null, undefined, "none", "null" values from tool arguments
// so the MCP backend always receives real values.
function sanitizeArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' && (val.toLowerCase() === 'none' || val.toLowerCase() === 'null' || val === '')) continue;
    if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
      const nested = sanitizeArgs(val as Record<string, unknown>);
      if (Object.keys(nested).length > 0) clean[key] = nested;
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

// ══ ENHANCED SYSTEM PROMPT ══
const ARCHITECT_PROMPT = `
You are InfraStudio AI — an expert BIM architect and IFC engineer. You think carefully and methodically about spatial relationships, real-world dimensions, and material properties before calling any tool.

━━━ SPATIAL REASONING RULES ━━━

COORDINATE SYSTEM: Right-hand rule. X = East, Y = North, Z = Up. All units are METERS.
- A standard residential storey is 3.0m floor-to-floor.
- A standard door is 0.9m wide × 2.1m tall.
- A standard window is 1.2m wide × 1.5m tall, sill height 0.9m from floor.
- A standard wall is 0.2m thick (interior) or 0.3m thick (exterior).

PLACEMENT LOGIC — Think step by step:
- Walls along the X-axis: rotation [0, 0, 0]. Location [x, y, 0] where x is the START point.
- Walls along the Y-axis: rotation [0, 0, 1.5708] (90° in radians).
- A door at the CENTER of a 5m wall: door location offset = (5.0 - 0.9) / 2 = 2.05m from wall start.
- A window at height 0.9m from floor: set the window's Z location to 0.9.
- Multiple walls forming a room: compute each wall's start/end coordinates so corners meet precisely.

DIMENSION DEFAULTS — Always provide explicit numeric values:
- Wall: height=3.0, length=5.0, thickness=0.2
- Door: height=2.1, width=0.9
- Window: height=1.5, width=1.2
- Column: height=3.0, diameter=0.3
- Slab: thickness=0.2

━━━ TOOL PARAMETER RULES ━━━

EVERY parameter you pass to a tool MUST have an explicit, meaningful value.
- NEVER pass null, None, empty string, or omit required fields.
- For "material": always pass a material name string like "Concrete", "Timber", "Steel", "Glass".
- For "dimensions": always pass an object like {"height": 3.0, "length": 5.0, "thickness": 0.2}.
- For "location": always pass [x, y, z] coordinates like [0.0, 0.0, 0.0].
- For "rotation": always pass [rx, ry, rz] in radians like [0.0, 0.0, 0.0].
- For "geometry_properties": always pass {"represents_3d": true}.

━━━ MANDATORY BUILD WORKFLOW ━━━

For EVERY building element you create, follow ALL 4 steps:

STEP 1 — CREATE: Call the creation tool (create_wall, create_door, create_window, etc.)
  → Read the JSON response and extract the "guid" or "element_guid" field.

STEP 2 — STYLE: Call create_surface_style with the correct RGB color:
  | Material   | RGB Color                | Transparency |
  |------------|--------------------------|-------------|
  | Concrete   | [0.65, 0.65, 0.65]       | 0.0         |
  | Wood       | [0.55, 0.35, 0.17]       | 0.0         |
  | Glass      | [0.7, 0.85, 1.0]         | 0.6         |
  | Steel      | [0.6, 0.6, 0.65]         | 0.0         |
  | Brick      | [0.72, 0.32, 0.2]        | 0.0         |
  | Marble     | [0.92, 0.91, 0.88]       | 0.0         |
  | Aluminium  | [0.75, 0.75, 0.78]       | 0.0         |
  | Plaster    | [0.9, 0.88, 0.82]        | 0.0         |
  → Give each style a descriptive name like "Concrete Wall Style".

STEP 3 — APPLY: Call apply_style_to_object with:
  - object_guids = the GUID from Step 1
  - style_name = the name from Step 2

STEP 4 — EXPORT: After ALL elements are created and styled, call export_ifc ONCE as the final action.

NEVER skip Steps 2-3. Without them, elements appear as plain white in the 3D viewer.
NEVER say "I've finished" without calling export_ifc first.

━━━ THINKING PROCESS ━━━

Before calling any tool, briefly plan:
1. What elements are needed?
2. What are their exact dimensions in meters?
3. Where does each element go (x, y, z)?
4. What material and color does each element need?
5. How do elements connect spatially (walls meeting at corners, doors centered in walls)?

Then execute your plan step by step using tools.
`;

// ══ MAIN AGENT LOOP ══
export interface AgentResult {
  reply: string;
  ifc_url?: string;
  steps: string[];
  mcp_session_id?: string;
}

export async function runQwenAgentLoop(
  userMessage: string,
  previousMessages: any[],
  clientSessionId: string,
  onStep: (step: string) => void,
  onAssistantMessage?: (msg: any) => void
): Promise<AgentResult> {
  // 1. Initialize MCP via Edge proxy
  onStep("🔌 Connecting to backend proxy...");
  
  const initData = await proxyRequest("init", {}, clientSessionId);
  const tools = initData.tools || [];
  const systemPrompt = (initData.system_prompt || "") + ARCHITECT_PROMPT;
  const activeSessionId = initData.session_id || clientSessionId;

  onStep(`✅ Loaded ${tools.length} tools`);

  // 2. Reset the backend IFC project for new sessions to prevent stale data
  if (previousMessages.length === 0) {
    onStep("🗑️ Resetting IFC project for fresh session...");
    try {
      await proxyRequest("call_tool", { 
        name: "initialize_project", 
        args: { project_name: "InfraStudio Session" } 
      }, activeSessionId);
      onStep("✅ Fresh IFC project initialized");
    } catch (e) {
      console.warn("initialize_project failed (non-fatal):", e);
    }
  }

  const systemMsg = { role: "system", content: systemPrompt };
  const userMsg = { role: "user", content: userMessage };
  
  const messages = previousMessages.length > 0 
    ? [systemMsg, ...previousMessages, userMsg] 
    : [systemMsg, userMsg];

  const steps: string[] = [];
  let ifc_url: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    onStep(`🤖 Agent thinking (turn ${turn + 1}/${MAX_TURNS})...`);

    // Call LLM via Edge Function
    const response = await proxyRequest("chat", { messages, tools }, activeSessionId);

    const choice = response.choices?.[0];
    if (!choice) throw new Error("No response choice from LLM");

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (onAssistantMessage) {
        onAssistantMessage(assistantMsg);
    }

    const toolCalls = assistantMsg.tool_calls || [];

    if (toolCalls.length === 0) {
      const reply = assistantMsg.content || "I have completed building your IFC model.";
      
      // Auto-export the IFC to guarantee the 3D viewer updates even if LLM forgot
      onStep("📦 Auto-exporting IFC model to update 3D scene...");
      try {
        const exportRes = await proxyRequest("call_tool", { name: "export_ifc", args: {} }, activeSessionId);
        const parsed = JSON.parse(exportRes.result);
        if (parsed.file_url) ifc_url = parsed.file_url;
        else if (parsed.success && parsed.ifc_url) ifc_url = parsed.ifc_url;
        steps.push(`  ✓ Auto-export completed`);
      } catch (e) {
        console.error("Auto-export failed:", e);
        steps.push(`  ✗ Auto-export failed`);
      }

      return { reply, ifc_url, steps, mcp_session_id: activeSessionId };
    }

    // Execute tool calls via Edge proxy (MCP operations)
    for (const call of toolCalls) {
      const toolName = call.function?.name;
      let toolArgs: Record<string, unknown> = {};
      try {
        const raw = JSON.parse(call.function?.arguments || "{}");
        toolArgs = sanitizeArgs(raw); // Strip null/none/empty values
      } catch {
        toolArgs = {};
      }

      const stepMsg = `🔧 ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`;
      steps.push(stepMsg);
      onStep(stepMsg);

      let toolResult = "";
      try {
        const proxyRes = await proxyRequest("call_tool", { name: toolName, args: toolArgs }, activeSessionId);
        toolResult = proxyRes.result;

        if (toolName === "export_ifc") {
          try {
            const parsed = JSON.parse(toolResult);
            if (parsed.file_url) ifc_url = parsed.file_url;
            else if (parsed.success && parsed.ifc_url) ifc_url = parsed.ifc_url;
          } catch { /* ignore parse errors */ }
        }

        steps.push(`  ✓ ${toolResult.slice(0, 120)}`);
        onStep(`  ✓ ${toolName} done`);
      } catch (e) {
        toolResult = JSON.stringify({ error: String(e) });
        steps.push(`  ✗ Error: ${String(e).slice(0, 100)}`);
        onStep(`  ✗ ${toolName} failed`);
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResult,
      });
    }
  }

  return {
    reply: "Building complete (max turns reached).",
    ifc_url,
    steps,
    mcp_session_id: activeSessionId
  };
}

