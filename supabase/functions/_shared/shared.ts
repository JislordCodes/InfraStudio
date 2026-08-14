
/// <reference types="jsr:@supabase/functions-js/edge-runtime.d.ts" />

export const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
export const LOCATION = "global";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function extractText(content: unknown): string | undefined {
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

export async function mcpPost(body: unknown, clientSessionId: string): Promise<{ data: unknown; session: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (clientSessionId) headers["mcp-session-id"] = clientSessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const returnedSession = res.headers.get("mcp-session-id") || clientSessionId;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    const data = l ? JSON.parse(l.slice(5).trim()) : {};
    return { data, session: returnedSession };
  }
  try { return { data: JSON.parse(text), session: returnedSession }; } 
  catch { return { data: { raw: text }, session: returnedSession }; }
}

export async function mcpInit(clientSessionId: string): Promise<string> {
  const res1 = await mcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "9.0" } }
  }, clientSessionId);
  const newSession = res1.session;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, newSession).catch(() => {});
  return newSession;
}

export function sanitizePythonCode(code: string): string {
  if (!code || typeof code !== 'string') return code;
  const safeHeader = `
import math
import numpy as np
import trimesh

NaN = float('nan')
nan = float('nan')
null = None
true = True
false = False
Infinity = float('inf')
inf = float('inf')

try:
    _orig_apply_transform = trimesh.primitives.Primitive.apply_transform
    def _safe_apply_transform(self, matrix):
        try:
            return _orig_apply_transform(self, matrix)
        except Exception:
            mesh = self.to_mesh()
            mesh.apply_transform(matrix)
            return mesh
    trimesh.primitives.Primitive.apply_transform = _safe_apply_transform
except Exception:
    pass

try:
    _orig_creation_cylinder = trimesh.creation.cylinder
    def _safe_creation_cylinder(radius, height=None, sections=32, segment=None, transform=None):
        try:
            return _orig_creation_cylinder(radius=radius, height=height, sections=sections, segment=segment, transform=transform)
        except Exception:
            h = height if height is not None else 1.0
            mesh = trimesh.primitives.Cylinder(radius=radius, height=h, sections=sections).to_mesh()
            if transform is not None:
                mesh.apply_transform(transform)
            return mesh
    trimesh.creation.cylinder = _safe_creation_cylinder
except Exception:
    pass
`;
  const sanitized = code.replace(/\.is_empty/g, '.size == 0');
  return safeHeader + '\n' + sanitized;
}

export async function mcpCallTool(name: string, args: Record<string, unknown>, clientSessionId: string): Promise<{ resultText: string, session: string }> {
  if (args) {
    if (typeof args.trimesh_code === 'string') {
      args.trimesh_code = sanitizePythonCode(args.trimesh_code);
    }
    if (typeof args.code_str === 'string') {
      args.code_str = sanitizePythonCode(args.code_str);
    }
    if (typeof args.code === 'string' && (name.includes('code') || name.includes('ifc'))) {
      args.code = sanitizePythonCode(args.code);
    }
  }

  const res = await mcpPost({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args }
  }, clientSessionId);
  const payload = res.data as Record<string, unknown>;
  
  if (payload.error) {
    throw new Error(`Tool ${name} failed: ${JSON.stringify(payload.error)}`);
  }
  
  if (!payload.result && payload.raw) {
    throw new Error(`Tool ${name} returned invalid response from server: ${payload.raw}`);
  }
  
  const resultText = extractText((payload?.result as Record<string, unknown>)?.content) || JSON.stringify(payload?.result ?? "done");
  
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object") {
      if (parsed.success === false || parsed.error) {
        throw new Error(`Tool ${name} reported failure: ${parsed.error || JSON.stringify(parsed)}`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Tool ")) throw e;
  }
  
  return { resultText, session: res.session };
}

export async function fetchMcpTools(clientSessionId: string): Promise<{ tools: any[], session: string }> {
  const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, clientSessionId);
  const data = res.data as Record<string, unknown>;
  const tools = ((data?.result as any)?.tools || []) as any[];
  return {
    tools: tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: (t.description || "").slice(0, 256),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}

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
  const claim = { iss: saJson.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, exp: now + 3600, iat: now };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const rawKey = saJson.private_key || "";
  const privateKey = rawKey.split("\\n").join("\n");
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(sig))}`;
  const resp = await fetch(tokenUri, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`Failed to mint GCP access token: ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

export async function callGemini(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "gemini-3.6-flash"): Promise<string> {
  const saRaw = typeof Deno !== "undefined" ? Deno.env.get("GCP_SERVICE_ACCOUNT_JSON") : process.env.GCP_SERVICE_ACCOUNT_JSON;
  const geminiKey = typeof Deno !== "undefined" ? Deno.env.get("GEMINI_API_KEY") : process.env.GEMINI_API_KEY;

  const targetModel = model.includes("gemini") ? model : "gemini-3.6-flash";
  const promptText = typeof userMessage === "string" 
    ? userMessage 
    : (Array.isArray(userMessage) ? userMessage.map(m => `${m.role}: ${m.content}`).join("\n") : String(userMessage));

  // 1. If GCP Service Account JSON is provided, authenticate via Vertex AI
  if (saRaw) {
    try {
      let saJson: any = {};
      try {
        saJson = JSON.parse(saRaw);
      } catch {
        const decoded = typeof atob !== "undefined" ? atob(saRaw) : Buffer.from(saRaw, "base64").toString("utf-8");
        saJson = JSON.parse(decoded);
      }

      const accessToken = await mintAccessToken(saJson);
      const projectId = saJson.project_id || "gemini-app-sa-495716";
      // gemini-3.6-flash is only available on the global endpoint
      const location = "global";
      const host = "aiplatform.googleapis.com";

      const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${targetModel}:generateContent`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUSER REQUEST:\n${promptText}` }] }],
          generationConfig: {
            maxOutputTokens: 16384,
            responseMimeType: jsonMode ? "application/json" : "text/plain"
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`[Vertex AI ${targetModel} Error ${res.status}]: ${errText}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error(`Empty response from Vertex AI ${targetModel}`);
      return text;
    } catch (e) {
      // Re-throw so the caller sees the real error instead of silently falling back
      throw new Error(`[callGemini Vertex] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. If GEMINI_API_KEY is provided, use Google AI Studio endpoint
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUSER REQUEST:\n${promptText}` }] }],
          generationConfig: {
            maxOutputTokens: 8192,
            responseMimeType: jsonMode ? "application/json" : "text/plain"
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (text) return text;
      } else {
        console.warn(`[callGemini] AI Studio API key ${targetModel} failed (${res.status}): ${await res.text()}`);
      }
    } catch (e) {
      console.warn("[callGemini] AI Studio API key call failed:", e);
    }
  }

  // 3. Fallback to callQwen qwen3.7-plus if no GCP/Gemini key is configured or working
  return callQwen(systemPrompt, userMessage, jsonMode, "qwen3.7-plus");
}

function getTargetModel(model: string): string {
  if (model === "qwen3.8-max" || model === "qwen3.8-max-preview") {
    // The current Model Studio quota is attached to qwen3.8-max. The preview
    // alias can be entitlement/plan-specific and is not interchangeable.
    return "qwen3.8-max";
  }
  if (model === "qwen-max" || !model || model === "glm-5.1") {
    return "qwen-max";
  }
  if (model === "kimi-k2.7-code") {
    return "qwen-max";
  }
  if (model === "qwen3.7-plus" || model === "qwen-plus") {
    return "qwen-plus";
  }
  return model;
}

function getQwenEndpoints(): string[] {
  const proxy = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (proxy?.trim()) return [proxy.trim().replace(/\/+$/, "")];
  const configured = typeof Deno !== "undefined"
    ? Deno.env.get("QWEN_BASE_URL")
    : process.env.QWEN_BASE_URL;
  const base = configured?.trim().replace(/\/+$/, "");
  if (base) return [`${base}/chat/completions`];
  return [
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
  ];
}

export async function callQwen(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "glm-5.1"): Promise<string> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage)) {
    msgs = msgs.concat(userMessage.map(m => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }

  const targetModel = getTargetModel(model);
  let lastError: any = null;

  const endpoints = getQwenEndpoints();
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;

  for (const endpoint of endpoints) {
    try {
      console.log(`[callQwen] Invoking ${targetModel} via ${endpoint}...`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: endpoints[0].includes("functions/v1/qwen-proxy")
          ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
          : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120000), // 120s timeout per attempt
        body: JSON.stringify({
          model: targetModel,
          messages: msgs,
          // Qwen3.8 Max is a thinking model; DashScope documents 0.6 as its
          // minimum temperature and xhigh as the maximum reasoning effort.
          temperature: targetModel === "qwen3.8-max" ? 0.6 : 0.1,
          reasoning_effort: targetModel === "qwen3.8-max" ? "xhigh" : undefined,
          max_tokens: 8192,
          response_format: jsonMode ? { type: "json_object" } : undefined
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[callQwen] Endpoint ${endpoint} returned ${res.status}: ${errText.slice(0, 150)}`);
        // Qwen3.8 Max Preview requires a separate DashScope Token Plan. Keep
        // it as the preferred model, but do not take production generation
        // down when the account has not been granted that entitlement yet.
        lastError = new Error(`Qwen Error (${res.status}): ${errText}`);
        continue;
      }
      
      const data = await res.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") {
        console.warn(`[callQwen] WARNING: ${targetModel} output was truncated (finish_reason=length).`);
      }
      return choice?.message?.content || "";
    } catch (err: any) {
      lastError = err;
      console.warn(`[callQwen] Endpoint ${endpoint} for ${targetModel} failed:`, err.message || err);
    }
  }

  throw new Error(`callQwen failed for ${targetModel}: ${lastError?.message || String(lastError)}`);
}

export async function callGLM(systemPrompt: string, userMessage: string, tools?: any[], model: string = "qwen3.8-max"): Promise<any> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  const targetModel = getTargetModel(model);
  const endpoints = getQwenEndpoints();
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;

  let lastErrText = "";
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: endpoints[0].includes("functions/v1/qwen-proxy")
          ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
          : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          messages: msgs,
          tools: (tools && tools.length > 0) ? tools : undefined,
          temperature: targetModel === "qwen3.8-max" ? 0.6 : 0.1,
          reasoning_effort: targetModel === "qwen3.8-max" ? "xhigh" : undefined,
          max_tokens: 8192
        })
      });

      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message;
      }

      lastErrText = await res.text();
      console.warn(`[callGLM] ${endpoint} returned (${res.status}): ${lastErrText}`);
    } catch (e: any) {
      lastErrText = e.message || String(e);
    }
  }

  throw new Error(`BIM Model Error (${targetModel}): ${lastErrText}`);
}

export async function callGLMStream(systemPrompt: string, userMessage: string, model: string = "glm-5.1"): Promise<ReadableStream<Uint8Array>> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];
  const targetModel = getTargetModel(model);
  const streamEndpoint = getQwenEndpoints()[0];
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;
  const res = await fetch(streamEndpoint, {
    method: "POST",
    headers: streamEndpoint.includes("functions/v1/qwen-proxy")
      ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
      : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages: msgs,
      temperature: 0.1,
      max_tokens: 16384,
      stream: true
    })
  });
  if (!res.ok) {
    if (targetModel === "qwen-max") {
      return await callGLMStream(systemPrompt, userMessage, "qwen-flash");
    }
    throw new Error(`GLM Stream Error: ${await res.text()}`);
  }
  if (!res.body) throw new Error("No response body from GLM Stream");
  return res.body;
}


function autoRepairTruncatedJson(jsonStr: string): string {
  let str = jsonStr.trim();

  // Strip incomplete trailing key/value fragments
  str = str.replace(/,\s*"[^"]*"?\s*:\s*[^,\}\]]*$/, '');
  str = str.replace(/,\s*"[^"]*$/, '');
  str = str.replace(/,\s*$/, '');

  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    str += '"';
  }

  str = str.replace(/,\s*$/, '');

  while (stack.length > 0) {
    str += stack.pop();
  }

  return str;
}

export function cleanJsonResponse(rawStr: string): any {
  let clean = rawStr.trim();
  
  if (clean.includes("```")) {
    const startIdx = clean.indexOf("```");
    if (startIdx !== -1) {
      const newlineIdx = clean.indexOf("\n", startIdx);
      const contentStart = newlineIdx !== -1 ? newlineIdx + 1 : startIdx + 3;
      const endIdx = clean.indexOf("```", contentStart);
      if (endIdx !== -1) {
        clean = clean.substring(contentStart, endIdx);
      } else {
        clean = clean.substring(contentStart);
      }
    }
  }
  
  clean = clean.trim();
  const firstBrace = clean.indexOf('{');
  if (firstBrace !== -1) {
    clean = clean.substring(firstBrace);
  }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace > 0) {
    const candidate = clean.substring(0, lastBrace + 1);
    try {
      return JSON.parse(candidate.replace(/,\s*([\}])\}/g, '$1}'));
    } catch { /* fall through to repair */ }
  }

  // Strip trailing commas before closing brackets or braces
  clean = clean.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(clean);
  } catch (_err) {
    const repaired = autoRepairTruncatedJson(clean);
    try {
      return JSON.parse(repaired);
    } catch (_err2) {
      const sanitized = repaired.replace(/[\u0000-\u001F]+/g, " ");
      return JSON.parse(sanitized);
    }
  }
}
