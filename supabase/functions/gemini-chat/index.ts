import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ══ CONFIG ══
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LLM_MODEL = "gemini-3.1-pro-preview";
const LOCATION = "global";

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
        // Trim description hard to 256 chars - saves significant tokens
        description: (t.description || "").slice(0, 256),
        // Only include non-empty parameters
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}

function buildSystemPrompt(): string {
  return `You are a helpful expert IFC architect agent. You have tools available to modify the model.

TOOL SELECTION — Always pick the HIGHEST-LEVEL tool that fits:

| User wants...          | Use this tool                              |
|------------------------|--------------------------------------------|
| Full building          | build_building (storeys + rooms + roof)    |
| Multiple rooms         | build_floor_plan (rooms array)             |
| One room               | build_room (walls + slab + openings)       |
| Wall + openings        | build_wall_assembly (wall + doors/windows) |
| Just a wall/slab/roof  | create_wall / create_slab / create_roof    |

COORDINATE SYSTEM:
- Origin = south-west corner of rooms
- Width = X-axis (west → east), Length = Y-axis (south → north)
- Wall names: "south", "east", "north", "west"
- Door/window "offset" = distance from the START of the named wall

CRITICAL RULES:
1. NEVER calculate wall coordinates yourself — the orchestration tools handle ALL geometry.
2. NEVER compute rotations in radians — use cardinal wall names ("south", "east", etc.)
3. NEVER track GUIDs between calls for room/building creation — the backend manages them internally.
4. You MUST wait for tool responses to get real GUIDs before referencing them in follow-up calls.
5. NEVER use placeholder text like <wall_guid>. ALWAYS use real 22-character GUIDs returned by tools.

For execute_ifc_code_tool (advanced use only):
- ifc_file = get_ifc_file() (always call this)
- body_ctx = get_or_create_body_context(ifc_file) (always call this)  
- save_and_load_ifc() (ALWAYS call at the end)
- Never create IfcProject, IfcSite, or IfcBuilding — they already exist.
`;
}

// ══ VERTEX AI AUTH via WEB CRYPTO ══
function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
async function mintAccessToken(saJson: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const tokenUri = saJson.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: saJson.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const rawKey = saJson.private_key || "";
  const privateKey = rawKey.split("\\n").join("\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(sig))}`;

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });

  if (!resp.ok) throw new Error(`Failed to mint GCP access token: ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

// ── SEMANTIC TOOL RETRIEVAL (QWEN INTELLIGENCE LAYER) ──
const ALWAYS_EXPOSED = new Set([
  "build_room", "build_floor_plan", "build_building", "build_wall_assembly",
  "get_scene_info", "get_ifc_scene_overview", "export_ifc", "initialize_project",
  "create_surface_style", "apply_style_to_object" // Style tools are always needed
]);

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

  const qwenKey = Deno.env.get("QWEN_API_KEY");
  if (!qwenKey) {
    console.warn("QWEN_API_KEY missing. Falling back to all tools.");
    return allTools;
  }

  try {
    const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-max", // DashScope's alias for the largest Qwen model
        messages: [{ role: "user", content: routerPrompt }],
        temperature: 0.1
      })
    });

    if (res.ok) {
      const data = await res.json();
      const choice = data.choices?.[0]?.message?.content || "";
      if (choice && choice.trim() !== "NONE") {
        const extractedToolNames = choice.split(",").map((s: string) => s.trim());
        for (const name of extractedToolNames) {
          if (name) needed.add(name);
        }
      }
    }
  } catch (e) {
    console.error("Qwen Tool Router failed:", e);
    return allTools;
  }

  return allTools.filter(t => needed.has(t.function?.name || t.name));
}

// ══ HTTP HANDLER ══
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const payload = await req.json();
    const action = payload.action || "init";
    const inboundSessionId = payload.session_id || "";

    if (action === "init") {
      const initSession = await mcpInit(inboundSessionId);
      const toolsResult = await fetchMcpTools(initSession);
      return new Response(JSON.stringify({ tools: toolsResult.tools, system_prompt: buildSystemPrompt(), session_id: toolsResult.session }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (action === "call_tool") {
      const { name, args } = payload;
      let activeSession = inboundSessionId;
      if (!activeSession) activeSession = await mcpInit("");
      const { resultText, session } = await mcpCallTool(name, args || {}, activeSession);
      const truncated = resultText.length > 3000 ? resultText.slice(0, 3000) + "... [truncated]" : resultText;
      return new Response(JSON.stringify({ result: truncated, session_id: session }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (action === "chat") {
      const { messages, tools } = payload;
      const saJsonString = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY") || "{}";
      const saJson = JSON.parse(saJsonString);
      if (!saJson.project_id) throw new Error("Missing GCP_SERVICE_ACCOUNT_KEY");
      
      const accessToken = await mintAccessToken(saJson);

      // -- Layer 1: Intelligence Router (Qwen) --
      let routedTools = tools || [];
      if (tools && tools.length > 0) {
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user")?.content || "";
        if (lastUserMsg) {
          console.log("Routing tools semantically with Qwen...");
          routedTools = await routeToolsWithQwen(tools, lastUserMsg);
          console.log(`Qwen extracted ${routedTools.length}/${tools.length} relevant tools`);
        }
      }

      const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
      const url = `https://${host}/v1/projects/${saJson.project_id}/locations/${LOCATION}/endpoints/openapi/chat/completions`;

      const openaiBody: any = {
        model: "zai-org/glm-5-maas",
        messages: messages,
        temperature: 0.1
      };
      
      if (routedTools.length > 0) {
        openaiBody.tools = routedTools;
      }

      // Retry with exponential backoff on 429 (rate limit)
      let responseData: any;
      const retryDelays = [5000, 15000, 30000];
      let lastError = "";
      let succeeded = false;

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
          body: JSON.stringify(openaiBody)
        });

        if (res.ok) {
          responseData = await res.json();
          succeeded = true;
          break;
        }

        const errText = await res.text();
        lastError = errText;

        if (res.status === 429 && attempt < retryDelays.length) {
          const wait = retryDelays[attempt];
          console.log(`429 rate limit hit, retrying in ${wait/1000}s (attempt ${attempt + 1}/${retryDelays.length})...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        throw new Error(`Vertex OpenAPI Error: ${res.status} ${errText}`);
      }

      if (!succeeded) throw new Error(`Vertex OpenAPI Error (after retries): ${lastError}`);

      let activeSession = inboundSessionId;
      if (!activeSession) activeSession = await mcpInit("");

      responseData.session_id = activeSession;
      return new Response(JSON.stringify(responseData), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), status: "error" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
