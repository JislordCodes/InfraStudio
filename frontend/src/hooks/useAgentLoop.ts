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

// ══ SYSTEM PROMPT ══
const ARCHITECT_PROMPT = `
You are InfraStudio AI — an expert BIM architect agent.

━━━ TOOL SELECTION ━━━
Always use the HIGHEST-LEVEL tool available:
| Goal                    | Tool                |
|-------------------------|---------------------|
| Full building           | build_building      |
| Floor plan (rooms)      | build_floor_plan    |
| Single room             | build_room          |
| Wall + openings         | build_wall_assembly |
| Individual element only | create_* tools      |

━━━ build_room USAGE ━━━
build_room creates ALL geometry in one call: walls, floor slab, doors and windows.
NEVER call create_wall or create_slab separately when building a room.

Example:
build_room({
  room_name: "Office",
  width: 4.0, length: 5.0, height: 3.0,
  wall_thickness: 0.2, origin: [0,0,0],
  floor_slab: true,
  doors: [{wall: "south", offset: 1.0, width: 0.9, height: 2.1}],
  windows: [{wall: "east", offset: 1.5, width: 1.2, height: 1.2, sill_height: 0.9}]
})

━━━ RULES ━━━
- NEVER compute wall coordinates or rotations yourself.
- Wall positions use cardinal names: "south", "east", "north", "west".
- offset = distance from the START of the named wall in meters.
- After building, always call export_ifc as the last step.
`;

// ══ DYNAMIC TOOL ROUTER ══
// The orchestration tools (build_room, build_building, etc.) handle EVERYTHING
// for room/building creation. Low-level tools are ONLY added when the user
// explicitly wants to modify a SINGLE element on an EXISTING model.
//
// Default: 8 tools. Max: ~12 tools. Never all 60.

const ALWAYS_EXPOSED = new Set([
  "build_room",           // creates a full room: 4 walls + slab + doors + windows
  "build_floor_plan",     // creates multiple rooms on one floor
  "build_building",       // creates full multi-storey building
  "build_wall_assembly",  // creates a wall with openings
  "get_scene_info",
  "get_ifc_scene_overview",
  "export_ifc",
  "initialize_project",
]);

// ── SEMANTIC TOOL RETRIEVAL (QWEN INTELLIGENCE LAYER) ──
// 1. We send the user prompt + tool list explicitly to Alibaba's Qwen (qwen3.6-max-preview).
// 2. Qwen acts as the Intelligence Layer to extract exactly the tools needed.
// 3. We return those tools to the main Agent Loop (which uses Gemini).

async function routeToolsWithQwen(allTools: any[], userMessage: string): Promise<any[]> {
  const needed = new Set<string>(ALWAYS_EXPOSED);
  
  const availableToolsList = allTools
    .filter(t => !ALWAYS_EXPOSED.has(t.function?.name || t.name))
    .map(t => `- ${t.function?.name || t.name}: ${(t.function?.description || t.description || "").slice(0, 100)}`)
    .join("\n");

  const routerPrompt = `You are a Tool Retrieval Intelligence Layer.
Your job is to analyze the user's architectural request and extract the names of the specific tools needed from the database.

User Request: "${userMessage}"

Available Tools Database:
${availableToolsList}

RULES:
1. ONLY return a comma-separated list of tool names from the database above.
2. If the user is asking to build a full room or building, DO NOT extract low-level tools like create_wall or create_door (they are handled automatically).
3. If the user is asking to add a SPECIFIC element to an EXISTING model (e.g., "add a roof", "insert a window"), extract the relevant tools.
4. Reply with ONLY the comma-separated tool names. Nothing else. No markdown. If none, reply "NONE".`;

  const QWEN_API_KEY = import.meta.env.VITE_QWEN_API_KEY;
  if (!QWEN_API_KEY) {
    console.warn("⚠️ VITE_QWEN_API_KEY is missing! The Intelligence Layer requires an Alibaba API key. Falling back to all tools.");
    return allTools;
  }

  try {
    // Calling Alibaba DashScope OpenAI-compatible API
    const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${QWEN_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen3.6-max-preview", // Explicitly using Qwen as the Layer 1 Router
        messages: [{ role: "user", content: routerPrompt }],
        temperature: 0.1
      })
    });

    if (!res.ok) {
      throw new Error(`Qwen API Error: ${await res.text()}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0]?.message?.content || "";
    
    if (choice && choice.trim() !== "NONE") {
      const extractedToolNames = choice.split(",").map((s: string) => s.trim());
      for (const name of extractedToolNames) {
        if (name) needed.add(name);
      }
    }
  } catch (e) {
    console.error("Qwen Tool Router failed:", e);
    return allTools; // Fallback to all tools if Qwen fails
  }

  return allTools.filter(t => needed.has(t.function?.name || t.name));
}

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

  const orchestrationTools = tools.filter((t: any) => ALWAYS_EXPOSED.has(t.function?.name || t.name));
  onStep(`✅ Ready — ${orchestrationTools.length} orchestration tools loaded`);

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

    // ── Pre-flight Semantic Tool Router ──
    // Extracts only the tools needed for this specific message using Alibaba Qwen
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')?.content || userMessage;
    
    onStep(`🧠 Qwen Intelligence Layer analyzing intent...`);
    const routedTools = await routeToolsWithQwen(tools, lastUserMsg);
    
    onStep(`🎯 Qwen extracted ${routedTools.length}/${tools.length} relevant tools for Gemini`);

    const response = await proxyRequest("chat", { messages, tools: routedTools }, activeSessionId);

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

