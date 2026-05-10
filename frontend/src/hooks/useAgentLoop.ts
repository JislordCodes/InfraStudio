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
- A door at the CENTER of a 5m wall starting at [0,0,0]: opening location = [2.05, 0.0, 0.0]
- A window at height 0.9m from floor: opening location z = 0.9.
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
- For "material": always pass a string like "Concrete", "Timber", "Steel", "Glass".
- For "dimensions": always pass an object like {"height": 3.0, "length": 5.0, "thickness": 0.2}.
- For "location": always pass [x, y, z] like [0.0, 0.0, 0.0].
- For "rotation": always pass [rx, ry, rz] in radians like [0.0, 0.0, 0.0].
- For "geometry_properties": always pass {"represents_3d": true}.

━━━ DOOR & WINDOW WORKFLOW (CRITICAL!) ━━━

To place a door or window IN a wall, you MUST follow this exact 3-step process.
If you skip any step, the door will clip through the wall with no hole.

STEP A — CUT THE OPENING:
  Call create_opening to cut a void in the wall:
    create_opening(
      wall_guid = "<wall_guid from create_wall>",
      width = 0.9,        // door width
      height = 2.1,       // door height  
      depth = 0.3,        // slightly > wall thickness
      location = [2.05, 0.0, 0.0],  // position along wall
      opening_type = "OPENING",
      name = "Door Opening"
    )
  → Extract "opening_guid" from the response.

STEP B — CREATE THE ELEMENT:
  Call create_door or create_window.
  → Extract "guid" or "element_guid" from the response.

STEP C — FILL THE OPENING:
  Call fill_opening to link the door/window into the void:
    fill_opening(
      opening_guid = "<opening_guid from Step A>",
      element_guid = "<door_guid from Step B>"
    )

This 3-step process is MANDATORY for doors and windows. Without it:
- No hole is cut in the wall
- The door/window clips through solid geometry
- The IFC file is structurally incorrect

━━━ MATERIAL & STYLE WORKFLOW ━━━

After creating elements, style them:

STEP 1 — CREATE STYLE: Call create_surface_style with RGB color:
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

STEP 2 — APPLY STYLE: Call apply_style_to_object(object_guids, style_name).

STEP 3 — EXPORT: After ALL elements are built and styled, call export_ifc ONCE.

━━━ FULL EXAMPLE: "Concrete wall with wooden door" ━━━

1. create_wall(name="Main Wall", dimensions={"height":3,"length":5,"thickness":0.2}, location=[0,0,0], material="Concrete") → wall_guid
2. create_opening(wall_guid=wall_guid, width=0.9, height=2.1, depth=0.3, location=[2.05,0,0]) → opening_guid
3. create_door(name="Front Door", height=2.1, width=0.9, location=[2.05,0,0], material="Timber") → door_guid
4. fill_opening(opening_guid=opening_guid, element_guid=door_guid)
5. create_surface_style(name="Concrete Style", color=[0.65,0.65,0.65])
6. apply_style_to_object(object_guids=wall_guid, style_name="Concrete Style")
7. create_surface_style(name="Wood Door Style", color=[0.55,0.35,0.17])
8. apply_style_to_object(object_guids=door_guid, style_name="Wood Door Style")
9. export_ifc()

━━━ SELF-VALIDATION ━━━

After creating all elements and BEFORE exporting, you will receive a scene validation
report from get_scene_info showing every object's position, bounding box, and IFC class.
Review it carefully:
- Are all requested elements present? (e.g. wall + opening + door)
- Do bounding boxes make sense? (a 5m wall should have ~5m X dimension)
- Are doors/windows inside their parent wall's bounding box?
- Are there any elements at [0,0,0] that should be elsewhere?
If something looks wrong, fix it by calling the appropriate tools, then verify again.

━━━ THINKING PROCESS ━━━

Before calling any tool, plan:
1. What elements are needed?
2. What are their exact dimensions?
3. Where does each element go (x, y, z)?
4. What material and color does each need?
5. For doors/windows: where is the opening in the wall? What are the 3 steps (open → create → fill)?

Then execute step by step.
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
      
      // ── SELF-VALIDATION: Inspect the scene before export ──
      // Only validate if the LLM actually built something (not just a text reply)
      if (!ifc_url && turn > 0) {
        onStep("🔍 Validating model before export...");
        try {
          const sceneRes = await proxyRequest("call_tool", {
            name: "get_scene_info",
            args: { include_bbox: true, include_transform: true }
          }, activeSessionId);
          const sceneData = sceneRes.result;
          
          // Feed scene info back to LLM for self-check
          messages.push({
            role: "user",
            content: `VALIDATION CHECK — Here is the current scene state. Review it and confirm everything looks correct. If there are issues (missing elements, wrong positions, overlapping geometry), fix them now. If everything is correct, call export_ifc to finalize.\n\nScene data:\n${sceneData}`
          });
          steps.push(`  🔍 Scene validated (${JSON.parse(sceneData).count || '?'} objects)`);
          onStep("🔍 Scene validation sent to AI for review...");
          
          // Continue the loop so the LLM can review and either fix or export
          continue;
        } catch (e) {
          console.warn("Scene validation failed (non-fatal):", e);
        }
      }
      
      // Auto-export the IFC to guarantee the 3D viewer updates
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

