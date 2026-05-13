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

      let systemText = "";
      const contents: any[] = [];
      const toolCallMap = new Map<string, string>();

      for (const msg of messages || []) {
        if (msg.role === "system") {
          systemText += msg.content + "\n";
        } else if (msg.role === "user") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else if (msg.role === "assistant") {
          const parts: any[] = [];
          if (msg.content) parts.push({ text: msg.content });
          if (msg.tool_calls) {
            for (const call of msg.tool_calls) {
              toolCallMap.set(call.id, call.function.name);
              const argsObj = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : call.function.arguments;
              const p: any = { functionCall: { name: call.function.name, args: argsObj } };
              if (call.x_thought_signature) p.thought_signature = call.x_thought_signature;
              if (call.x_thoughtSignature) p.thoughtSignature = call.x_thoughtSignature;
              parts.push(p);
            }
          }
          contents.push({ role: "model", parts });
        } else if (msg.role === "tool") {
          const name = toolCallMap.get(msg.tool_call_id) || "unknown_tool";
          let parsedResult;
          try { parsedResult = JSON.parse(msg.content); } catch { parsedResult = { result: msg.content }; }
          
          const part = { functionResponse: { name, response: { result: parsedResult } } };
          
          // Group consecutive tool messages into a single 'function' role content
          const lastContent = contents[contents.length - 1];
          if (lastContent && lastContent.role === "function") {
            lastContent.parts.push(part);
          } else {
            contents.push({ role: "function", parts: [part] });
          }
        }
      }

      const body: any = { contents };
      if (systemText.trim()) body.systemInstruction = { parts: [{ text: systemText.trim() }] };
      if (tools && tools.length > 0) {
        body.tools = [{ functionDeclarations: tools.map((t: any) => t.function) }];
      }

      const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
      const url = `https://${host}/v1/projects/${saJson.project_id}/locations/${LOCATION}/publishers/google/models/${LLM_MODEL}:generateContent`;

      // Retry with exponential backoff on 429 (rate limit)
      let geminiData: any;
      const retryDelays = [5000, 15000, 30000];
      let lastError = "";
      let succeeded = false;

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
          body: JSON.stringify(body)
        });

        if (res.ok) {
          geminiData = await res.json();
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

        throw new Error(`Vertex API Error: ${errText}`);
      }

      if (!succeeded) throw new Error(`Vertex API Error (after retries): ${lastError}`);

      
      // Translate back to OpenAI format
      const candidate = geminiData.candidates?.[0];
      const outParts = candidate?.content?.parts || [];
      let outContent = "";
      const outTools: any[] = [];

      for (const part of outParts) {
        if (part.text) outContent += part.text;
        if (part.functionCall) {
          outTools.push({
            id: "call_" + Math.random().toString(36).substring(2, 10),
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
            x_thought_signature: part.thought_signature,
            x_thoughtSignature: part.thoughtSignature
          });
        }
      }

      return new Response(JSON.stringify({
        id: "chatcmpl-" + Math.random().toString(36).substring(2),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        choices: [{ message: { role: "assistant", content: outContent || null, ...(outTools.length ? { tool_calls: outTools } : {}) } }]
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), status: "error" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
