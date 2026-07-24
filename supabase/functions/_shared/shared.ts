
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

export async function mcpCallTool(name: string, args: Record<string, unknown>, clientSessionId: string): Promise<{ resultText: string, session: string }> {
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

async function getGcpAccessToken(saJsonStr: string): Promise<{ token: string; projectId: string }> {
  const sa = typeof saJsonStr === "string" ? JSON.parse(saJsonStr) : saJsonStr;
  const clientEmail = sa.client_email;
  const privateKeyPem = sa.private_key;
  const projectId = sa.project_id || "default";

  if (!clientEmail || !privateKeyPem) {
    throw new Error("Invalid Service Account JSON: client_email and private_key are required");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const b64Header = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const b64Claim = btoa(JSON.stringify(claimSet)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsignedToken = `${b64Header}.${b64Claim}`;

  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = privateKeyPem.substring(
    privateKeyPem.indexOf(pemHeader) + pemHeader.length,
    privateKeyPem.indexOf(pemFooter)
  ).replace(/\s/g, "");
  
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(unsignedToken)
  );

  const b64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${unsignedToken}.${b64Signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  if (!tokenRes.ok) {
    throw new Error(`GCP OAuth token request failed: ${await tokenRes.text()}`);
  }

  const tokenData = await tokenRes.json();
  return { token: tokenData.access_token, projectId };
}

export async function callGemini(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "gemini-3.6-flash"): Promise<string> {
  const saJson = typeof Deno !== "undefined" ? Deno.env.get("GCP_SERVICE_ACCOUNT_JSON") : process.env.GCP_SERVICE_ACCOUNT_JSON;
  const geminiKey = typeof Deno !== "undefined" ? Deno.env.get("GEMINI_API_KEY") : process.env.GEMINI_API_KEY;

  const promptText = typeof userMessage === "string" 
    ? userMessage 
    : (Array.isArray(userMessage) ? userMessage.map(m => `${m.role}: ${m.content}`).join("\n") : String(userMessage));

  const targetModel = model.includes("gemini") ? model : "gemini-3.6-flash";

  // 1. Try GCP Vertex AI Service Account JSON if provided
  if (saJson) {
    try {
      const { token, projectId } = await getGcpAccessToken(saJson);
      const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${targetModel}:generateContent`;

      const res = await fetch(vertexUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
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
        console.warn(`[callGemini] Vertex AI returned ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      console.warn("[callGemini] Vertex AI Service Account authentication failed:", e);
    }
  }

  // 2. Try GEMINI_API_KEY (Google AI Studio / GCP API Key)
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
        console.warn(`[callGemini] ${targetModel} API key call failed (${res.status}): ${await res.text()}`);
      }
    } catch (err) {
      console.warn(`[callGemini] Error calling Gemini API key endpoint:`, err);
    }
  }

  // 3. Fallback to callQwen (qwen3.7-plus)
  console.warn("[callGemini] Neither valid GCP Service Account nor Gemini API Key worked, falling back to callQwen");
  return callQwen(systemPrompt, userMessage, jsonMode, "qwen3.7-plus");
}

function getTargetModel(model: string): string {
  if (!model || model === "glm-5.1" || model === "qwen-plus" || model === "qwen-turbo") {
    return "qwen3.7-max-2026-05-20";
  }
  return model;
}

export async function callQwen(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "glm-5.1"): Promise<string> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage)) {
    msgs = msgs.concat(userMessage.map(m => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }

  const targetModel = getTargetModel(model);
  let lastError: any = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(300000), // 5 minute timeout
        body: JSON.stringify({
          model: targetModel,
          messages: msgs,
          temperature: 0.1,
          max_tokens: 16384,
          response_format: jsonMode ? { type: "json_object" } : undefined
        })
      });
      
      if (!res.ok) {
        if (targetModel === "qwen-max") {
          return await callQwen(systemPrompt, userMessage, jsonMode, "qwen-flash");
        }
        const errText = await res.text();
        throw new Error(`Qwen Error: ${errText}`);
      }
      
      const data = await res.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") {
        console.warn(`[callQwen] WARNING: ${targetModel} output was truncated (finish_reason=length). Response may be incomplete.`);
      }
      return choice?.message?.content || "";
    } catch (err: any) {
      lastError = err;
      console.warn(`[callQwen] Attempt ${attempt}/2 for ${targetModel} failed:`, err.message || err);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(`callQwen failed for ${targetModel}: ${lastError?.message || String(lastError)}`);
}

export async function callGLM(systemPrompt: string, userMessage: string, tools?: any[], model: string = "glm-5.1"): Promise<any> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  const targetModel = getTargetModel(model);

  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages: msgs,
      tools: (tools && tools.length > 0) ? tools : undefined,
      temperature: 0.1,
      max_tokens: 16384
    })
  });
  
  if (!res.ok) {
    if (targetModel === "qwen-max") {
      return await callGLM(systemPrompt, userMessage, tools, "qwen-flash");
    }
    throw new Error(`GLM Error: ${await res.text()}`);
  }
  
  const data = await res.json();
  return data.choices[0].message;
}

export async function callGLMStream(systemPrompt: string, userMessage: string, model: string = "glm-5.1"): Promise<ReadableStream<Uint8Array>> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];
  const targetModel = getTargetModel(model);
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
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
