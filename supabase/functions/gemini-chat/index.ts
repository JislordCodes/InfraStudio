import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { GoogleAuth } from "npm:google-auth-library";
// ══ CONFIG ══
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LLM_MODEL = "gemini-3.1-pro-preview";
const LOCATION = "global"; // Can also be us-central1 depending on API availability

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
      const { messages, tools } = payload;
      
      const saJsonString = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY") || "{}";
      const saJson = JSON.parse(saJsonString);
      
      if (!saJson.project_id) {
        return new Response(JSON.stringify({ error: "Missing or invalid GCP_SERVICE_ACCOUNT_KEY" }), {
          status: 500, headers: { ...CORS, "Content-Type": "application/json" }
        });
      }

      const auth = new GoogleAuth({
        credentials: {
          client_email: saJson.client_email,
          private_key: saJson.private_key,
        },
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      
      const client = await auth.getClient();
      const tokenObj = await client.getAccessToken();
      const accessToken = tokenObj?.token || "";
      
      const PROJECT_ID = saJson.project_id;
      // Vertex AI OpenAI-compatible endpoint
      const LLM_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/openapi/chat/completions`;

      // Vertex AI supports native OpenAI-compatible tool calling
      const res = await fetch(LLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: messages || [],
          ...(tools && tools.length > 0 && { tools, tool_choice: "auto" }),
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
  return `You are InfraStudio — an expert AI BIM architect.

COORDINATE SYSTEM: X=East, Y=North, Z=Up. Units: METERS. Rotation in RADIANS (90deg = 1.5708).

CRITICAL: TWO-PHASE BUILD (MANDATORY)
You MUST build in TWO phases. Do NOT batch everything in one call.

PHASE 1 — Structure (call FIRST, wait for results):
  create_slab + create_wall x4.
  STOP. Wait for responses. Extract wall_guid from each create_wall response.

PHASE 2 — Details (call AFTER you have real GUIDs):
  create_door(wall_guid=REAL_GUID, create_opening=true, ...)
  create_window(wall_guid=REAL_GUID, create_opening=true, ...)
  create_surface_style x N
  apply_style_to_object
  export_ifc (ALWAYS last)

wall_guid MUST be the REAL alphanumeric GUID from create_wall response. NEVER use placeholder text.

ENCLOSED ROOM: 4 walls forming closed rectangle.
For WxL room: South=[0,0,0] len=W rot=0, North=[0,L,0] len=W rot=0, West=[0,0,0] len=L rot=1.5708, East=[W,0,0] len=L rot=1.5708.
All walls: height=3.0, thickness=0.2.

DOOR/WINDOW: create_door and create_window accept wall_guid + create_opening=true. Auto cuts hole + fills. Door Z=0.0. Window Z=1.0.
Rotation MUST match host wall. Do NOT call create_opening or fill_opening separately.

PARAMETERS: NEVER null/None/empty. material="Concrete"/"Timber"/"Steel"/"Brick".
COLORS: Concrete=[0.75,0.75,0.75] Brick=[0.72,0.35,0.20] Wood=[0.55,0.35,0.15] Glass=[0.60,0.80,0.90] transparency=0.7

EDITING: get_scene_info -> use GUIDs -> do NOT call initialize_project -> export_ifc`;
}

