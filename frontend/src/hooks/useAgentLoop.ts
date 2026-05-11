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
You are InfraStudio AI — an expert BIM architect. You think methodically about spatial layout before calling tools.

━━━ COORDINATE SYSTEM ━━━
X = East, Y = North, Z = Up. All units: METERS. Rotation in RADIANS (90° = 1.5708).

━━━ ENCLOSED ROOM RULE ━━━
Every room MUST have exactly 4 walls forming a CLOSED rectangle:
  South: location=[0, 0, 0],   length=W, rotation=[0, 0, 0]
  North: location=[0, L, 0],   length=W, rotation=[0, 0, 0]
  West:  location=[0, 0, 0],   length=L, rotation=[0, 0, 1.5708]
  East:  location=[W, 0, 0],   length=L, rotation=[0, 0, 1.5708]

━━━ ONE-STEP DOOR/WINDOW METHOD (MANDATORY) ━━━
Both create_door and create_window accept wall_guid + create_opening=true.
This automatically: cuts the opening, creates the element, fills the opening.

EXAMPLE — Door in south wall (X-axis wall):
  create_door(
    name="Entry Door",
    dimensions={"overall_height": 2.1, "overall_width": 0.9},
    operation_type="SINGLE_SWING_LEFT",
    location=[3.0, 0.0, 0.0],  // Z=0 for doors
    rotation=[0.0, 0.0, 0.0],  // MUST MATCH WALL ROTATION
    wall_guid="<wall_guid>",
    create_opening=true
  )

EXAMPLE — Window in west wall (Y-axis wall, rotated 90°):
  create_window(
    name="West Window",
    dimensions={"overall_height": 1.5, "overall_width": 1.2},
    partition_type="SINGLE_PANEL",
    location=[0.0, 2.5, 1.0],  // Z=1.0 for sill height
    rotation=[0.0, 0.0, 1.5708],  // MUST MATCH WALL ROTATION
    wall_guid="<wall_guid>",
    create_opening=true
  )

KEY RULES:
- Door/window rotation MUST EXACTLY MATCH the host wall's rotation.
- Door Z = 0.0. Window Z = sill height (typically 1.0m).
- Do NOT call create_opening or fill_opening separately.

━━━ BUILD ORDER ━━━
1. create_slab → 2. create_wall × 4 → 3. create_door/create_window with wall_guid → 4. styles → 5. export_ifc

━━━ PARAMETER RULES ━━━
- NEVER pass null/None/empty. Every param needs a real value.
- dimensions: {"height": 3.0, "length": 5.0, "thickness": 0.2}
- location: [x, y, z] — rotation: [rx, ry, rz] in RADIANS
- material: "Concrete", "Timber", "Steel", "Brick"

━━━ MATERIAL COLORS ━━━
Concrete: [0.75, 0.75, 0.75] | Brick: [0.72, 0.35, 0.20] | Wood: [0.55, 0.35, 0.15]
Glass: [0.60, 0.80, 0.90], transparency=0.7 | Steel: [0.60, 0.65, 0.72]

━━━ EDITING ━━━
For modifications: get_scene_info → use GUIDs → do NOT call initialize_project → export_ifc
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
  onAssistantMessage?: (msg: any) => void,
  onToolResult?: (msg: any) => void
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

  // For follow-up messages, inject current scene state so LLM knows existing elements
  if (previousMessages.length > 0) {
    onStep("🔎 Loading current model state for editing...");
    try {
      const sceneRes = await proxyRequest("call_tool", {
        name: "get_scene_info",
        args: { include_bbox: true, include_transform: true }
      }, activeSessionId);
      const sceneData = sceneRes.result;
      messages.push({
        role: "user",
        content: `[SYSTEM: Current model state for reference — use these GUIDs to edit existing elements]\n${sceneData}`
      });
      onStep("✅ Model state loaded");
    } catch (e) {
      console.warn("Scene state load failed (non-fatal):", e);
    }
  }

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

      // Persist tool result so follow-up messages have access to GUIDs
      if (onToolResult) {
        onToolResult({
          role: "tool",
          tool_call_id: call.id,
          content: toolResult,
        });
      }
    }
  }

  return {
    reply: "Building complete (max turns reached).",
    ifc_url,
    steps,
    mcp_session_id: activeSessionId
  };
}

