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
You are InfraStudio AI — an expert BIM architect.

━━━ COORDINATE SYSTEM ━━━
X = East, Y = North, Z = Up. All units: METERS. Rotation in RADIANS (90° = 1.5708).

━━━ ENCLOSED ROOM RULE ━━━
Every room MUST have exactly 4 walls forming a CLOSED rectangle.
For a W×L room: South=[0,0,0] len=W rot=0, North=[0,L,0] len=W rot=0, West=[0,0,0] len=L rot=1.5708, East=[W,0,0] len=L rot=1.5708.

━━━ CRITICAL: TWO-PHASE BUILD (MANDATORY) ━━━
You MUST build in exactly TWO phases. Do NOT try to batch everything in one call.

PHASE 1 — Structure (call these tools FIRST, wait for results):
  - create_slab
  - create_wall × 4
  After these calls complete, you will receive GUIDs for each wall. SAVE THESE GUIDs.

PHASE 2 — Details (call these tools AFTER you have wall GUIDs):
  - create_door(wall_guid=THE_ACTUAL_GUID_FROM_PHASE_1, create_opening=true, ...)
  - create_window(wall_guid=THE_ACTUAL_GUID_FROM_PHASE_1, create_opening=true, ...)
  - create_surface_style × N
  - apply_style_to_object
  - export_ifc (ALWAYS last)

CRITICAL: The wall_guid parameter MUST be the REAL GUID string returned by create_wall (e.g. "2InnWSTvL38A7MZDcrPcoW"). NEVER use placeholder text like "wall_guid" or "south_wall_guid".

━━━ DOOR/WINDOW RULES ━━━
- create_door and create_window both accept wall_guid + create_opening=true.
- This automatically cuts the hole, creates the element, and fills the opening.
- Door rotation MUST MATCH the host wall rotation. Window rotation MUST MATCH too.
- Door Z = 0.0. Window Z = 1.0 (sill height).
- Do NOT call create_opening or fill_opening separately.

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
  let validationAttempts = 0;

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
      
      // ── SELF-VALIDATION: Inspect the scene and force completion ──
      if (!ifc_url && turn > 0 && validationAttempts < 2) {
        validationAttempts++;
        onStep(`🔍 Validating model (check ${validationAttempts}/2)...`);
        try {
          const sceneRes = await proxyRequest("call_tool", {
            name: "get_scene_info",
            args: { include_bbox: true, include_transform: true }
          }, activeSessionId);
          const sceneData = sceneRes.result;
          
          // Parse scene to detect what's missing
          let sceneObj: any = {};
          try { sceneObj = JSON.parse(sceneData); } catch {}
          const objects = sceneObj.objects || sceneObj.elements || [];
          const objectList = Array.isArray(objects) ? objects : [];
          
          
          const hasDoors = objectList.some((o: any) => o.ifc_class === 'IfcDoor' || o.type === 'IfcDoor');
          const hasWindows = objectList.some((o: any) => o.ifc_class === 'IfcWindow' || o.type === 'IfcWindow');
          const wallCount = objectList.filter((o: any) => o.ifc_class === 'IfcWall' || o.type === 'IfcWall').length;
          
          // Build a specific list of what's missing
          const missing: string[] = [];
          if (wallCount < 4) missing.push(`Only ${wallCount} walls found — a room needs exactly 4 walls to be enclosed`);
          if (!hasDoors) missing.push("No doors found — every room needs at least one entry door. Use create_door with wall_guid + create_opening=true");
          if (!hasWindows) missing.push("No windows found — add at least one window for natural light. Use create_window with wall_guid + create_opening=true");
          
          // Always need styles and export
          missing.push("You MUST create surface styles (create_surface_style) and apply them to ALL elements (apply_style_to_object)");
          missing.push("You MUST call export_ifc as the very last step");
          
          const validationMsg = missing.length > 0
            ? `⚠️ INCOMPLETE MODEL — You stopped too early! The following items are MISSING and MUST be added NOW:\n\n${missing.map((m, i) => `${i+1}. ${m}`).join('\n')}\n\nDo NOT reply with text. Call the tools NOW to fix these issues. Start with the first missing item.\n\nCurrent scene:\n${sceneData}`
            : `Model looks complete. Call export_ifc now to finalize.\n\n${sceneData}`;
          
          messages.push({
            role: "user",
            content: validationMsg
          });
          steps.push(`  🔍 Validation: ${missing.length} issues found`);
          onStep(`🔍 Found ${missing.length} missing items — sending back to AI...`);
          
          // Continue the loop so the LLM can fix issues
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

