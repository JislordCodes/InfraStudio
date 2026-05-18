const fs = require('fs');
const path = require('path');

const funcDir = path.join(__dirname, 'supabase', 'functions');

const sharedDir = path.join(funcDir, '_shared');
if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });

// Read the original index.ts
const originalTs = fs.readFileSync(path.join(funcDir, 'gemini-chat', 'index.ts'), 'utf-8');

// We will extract common parts from originalTs to create shared.ts
const sharedCode = `
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
    const l = text.split("\\n").find(l => l.startsWith("data:"));
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
    throw new Error(\`Tool \${name} failed: \${JSON.stringify(payload.error)}\`);
  }
  
  const resultText = extractText((payload?.result as Record<string, unknown>)?.content) || JSON.stringify(payload?.result ?? "done");
  
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(\`Tool \${name} reported failure: \${parsed.error || JSON.stringify(parsed)}\`);
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
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\\s+/g, "");
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
  const unsigned = \`\${base64UrlEncode(JSON.stringify(header))}.\${base64UrlEncode(JSON.stringify(claim))}\`;
  const rawKey = saJson.private_key || "";
  const privateKey = rawKey.split("\\\\n").join("\\n");
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = \`\${unsigned}.\${base64UrlEncode(new Uint8Array(sig))}\`;
  const resp = await fetch(tokenUri, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!resp.ok) throw new Error(\`Failed to mint GCP access token: \${await resp.text()}\`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

export async function callQwen(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false): Promise<string> {
  const qwenKey = Deno.env.get("QWEN_API_KEY");
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage)) {
    msgs = msgs.concat(userMessage.map(m => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": \`Bearer \${qwenKey}\`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-max", messages: msgs, temperature: 0.1, response_format: jsonMode ? { type: "json_object" } : undefined })
  });
  if (!res.ok) throw new Error(\`Qwen Error: \${await res.text()}\`);
  const data = await res.json();
  return data.choices[0].message.content || "";
}

export async function callGLM(systemPrompt: string, userMessage: string, tools?: any[]): Promise<any> {
  const saJsonString = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY") || "{}";
  const saJson = JSON.parse(saJsonString);
  const accessToken = await mintAccessToken(saJson);
  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : \`\${LOCATION}-aiplatform.googleapis.com\`;
  const url = \`https://\${host}/v1/projects/\${saJson.project_id}/locations/\${LOCATION}/endpoints/openapi/chat/completions\`;
  const body: any = { model: "zai-org/glm-5-maas", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }], temperature: 0.1 };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${accessToken}\` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(\`GLM Error: \${await res.text()}\`);
  const data = await res.json();
  return data.choices[0].message;
}

export function cleanJsonResponse(rawStr: string): any {
  const match = rawStr.match(/\`\`\`(?:json)?\\n([\\s\\S]*?)\\n\`\`\`/);
  let clean = match ? match[1] : rawStr;
  clean = clean.trim();
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(clean);
}
`;
fs.writeFileSync(path.join(sharedDir, 'shared.ts'), sharedCode);

// agent-interpreter
const interpreterCode = `
import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = \`You are the Interpreter Agent.
Convert natural-language user intent into a structured architectural brief. 
Analyze the conversation history to determine if the user is asking to create a completely NEW building, or if they are asking to EDIT, CHANGE, or ADD to the existing building.
If it is an edit or modification, set "is_edit" to true and describe the changes in "edit_instructions".
Must NOT: Generate geometry, create IFC entities.
Expected JSON Output:
{
  "is_edit": boolean,
  "project_type": "string",
  "storeys": [{"name": "string", "elevation": "number", "height": "number"}],
  "room_requirements": [{"name": "string", "suggested_area": "number"}],
  "edit_instructions": ["string"]
}\`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const payload = await req.json();
    const messages = payload.messages || [];
    const res = await callQwen(systemPrompt, messages, true);
    const result = cleanJsonResponse(res);
    return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
`;
const iDir = path.join(funcDir, 'agent-interpreter');
if (!fs.existsSync(iDir)) fs.mkdirSync(iDir);
fs.writeFileSync(path.join(iDir, 'index.ts'), interpreterCode);

// agent-architect
const architectCode = `
import { CORS, callGLM, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = \`You are the Architectural Reasoning Agent.
Transform the structured brief into a spatially coherent layout or a set of modification instructions.
RULES FOR REALISTIC ARCHITECTURE:
1. Windows MUST ONLY be placed on EXTERNAL walls (walls facing the outside). NEVER place windows on interior partition walls between rooms.
2. Doors and windows must NEVER overlap with each other or with intersecting walls.
3. EVERY SINGLE ROOM MUST HAVE AT LEAST ONE DOOR. An enclosed room with no door is a fatal architectural mistake.
4. The main exterior door must connect the inside of the house to the outside.
5. Use realistic architectural layouts. Leave space for circulation.
6. Apply real-world materials (concrete, brick, wood, glass) in your structural_notes if you are making edits, unless the user requests a specific style.
7. CRITICAL TIMEOUT PREVENTION: Keep the layout simple and concise. Limit to a maximum of 4 essential rooms per storey. Excessive detail will cause the generation to timeout.

CRITICAL JSON INSTRUCTION:
YOU MUST OUTPUT ONLY VALID RAW JSON. DO NOT OUTPUT ANY CONVERSATIONAL TEXT, PREAMBLES, OR EXPLANATIONS. DO NOT USE MARKDOWN CODE BLOCKS (\`\`\`json). START IMMEDIATELY WITH { AND END WITH }.
If you output anything other than raw JSON, the system will crash.

If "is_edit" is false, output the full spatial "storey_plans".
If "is_edit" is true, leave "storey_plans" empty and output clear, step-by-step "structural_notes" detailing exactly what needs to be added, removed, or changed in the existing building.
Expected JSON Output:
{
  "is_edit": boolean,
  "storey_plans": [
    {
      "name": "string",
      "height": "number",
      "rooms": [
        {
          "name": "string",
          "width": "number",
          "length": "number",
          "origin": ["number", "number", "number"],
          "doors": [{"wall": "string", "offset": "number", "width": "number"}],
          "windows": [{"wall": "string", "offset": "number", "width": "number"}]
        }
      ]
    }
  ],
  "structural_notes": ["string"]
}\`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const brief = await req.json();
    let promptStr = JSON.stringify(brief);
    if (brief.reviewHistory) {
      promptStr += \`\\n\\nPREVIOUS REVIEW FAILED. Fix these issues: \${JSON.stringify(brief.reviewHistory)}\`;
    }
    const msg = await callGLM(systemPrompt, promptStr);
    const result = cleanJsonResponse(msg.content);
    return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
`;
const aDir = path.join(funcDir, 'agent-architect');
if (!fs.existsSync(aDir)) fs.mkdirSync(aDir);
fs.writeFileSync(path.join(aDir, 'index.ts'), architectCode);

// agent-bim
const bimCode = `
import { CORS, mcpInit, mcpCallTool, fetchMcpTools, callQwen, callGLM } from "../_shared/shared.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const payload = await req.json();
    let mcpSessionId = payload.mcpSessionId;
    if (!mcpSessionId) mcpSessionId = await mcpInit("");
    
    // Chunking approach: we either build one room, or one storey.
    if (payload.action === "build_room") {
      const room = payload.room;
      const storeyName = payload.storeyName;
      // We wrap the room into a single storey array so build_building handles it
      const buildRes = await mcpCallTool("build_building", {
        building_name: "InfraStudio AI Building",
        storeys: [{
          name: storeyName,
          height: payload.storeyHeight || 3,
          rooms: [room]
        }]
      }, mcpSessionId);
      return new Response(JSON.stringify({ status: "success", result: buildRes, mcpSessionId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    
    if (payload.action === "dynamic_edit") {
        const plan = payload.plan;
        const availableTools = (await fetchMcpTools(mcpSessionId)).tools;
        const ALWAYS_EXPOSED = new Set(["export_ifc", "get_scene_info", "create_surface_style", "apply_style_to_object", "create_trimesh_ifc"]);
        const availableToolsList = availableTools.filter(t => !ALWAYS_EXPOSED.has(t.function.name)).map(t => \`- \${t.function.name}: \${t.function.description}\`).join("\\n");
        const qwenPrompt = \`You are a Tool Retrieval Intelligence Layer. Extract the names of the specific tools needed for this architectural plan. Plan: "\${JSON.stringify(plan)}" Available Tools: \${availableToolsList} RULES: Return ONLY a comma-separated list of tool names. If none, reply "NONE".\`;
        const extractedRaw = await callQwen(qwenPrompt, "Extract tools", false);
        const needed = new Set<string>(ALWAYS_EXPOSED);
        if (extractedRaw && extractedRaw.trim() !== "NONE") extractedRaw.split(",").map(s => s.trim()).forEach(name => { if (name) needed.add(name); });
        const routedTools = availableTools.filter(t => needed.has(t.function.name));
        
        let glmPrompt = \`You are the BIM Executor. Use your tools to build or modify the requested architecture. CRITICAL RULES: 1. You MUST call export_ifc as the very last step. 2. If assigning styles, you must first create the style (e.g. create_surface_style) and use the returned name in apply_style_to_object. 3. If editing, use the EXACT GlobalId (GUID) from the Current IFC Scene State provided. Do not guess GUIDs. 4. CRITICAL FOR TRIMESH: When using create_trimesh_ifc, assign the final geometry to a variable exactly named 'result' and NEVER use print() statements. 5. TIMEOUT PREVENTION: Output ONLY the requested tool calls. Do not write extensive explanations or conversational text.\`;
        
        let planData = JSON.stringify(plan);
        const sceneRes = await mcpCallTool("get_scene_info", { include_bbox: false }, mcpSessionId);
        planData = \`Instructions: \${JSON.stringify(plan)}\\n\\nCurrent IFC Scene State:\\n\${sceneRes.resultText}\`;
        glmPrompt += "\\n4. You are EDITING an existing scene. Find the GlobalId of the target objects in the Scene State and pass them to your tool calls.";
        
        let ifc_url = "";
        let executionError = "";
        for (let tryNum = 1; tryNum <= 3; tryNum++) {
           let currentPlanData = planData;
           if (executionError) {
               currentPlanData += \`\\n\\nPREVIOUS EXECUTION FAILED WITH ERROR:\\n\${executionError}\\nPlease fix your tool arguments and try again.\`;
               executionError = ""; 
           }
           const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools);
           if (glmMsg.tool_calls) {
             try {
               for (const call of glmMsg.tool_calls) {
                  const args = JSON.parse(call.function.arguments || "{}");
                  const toolRes = await mcpCallTool(call.function.name, args, mcpSessionId);
                  if (call.function.name === "export_ifc") {
                    try { const p = JSON.parse(toolRes.resultText); ifc_url = p.file_url || p.ifc_url; } catch{}
                  }
               }
               break;
             } catch (err: any) {
               executionError = err.message || String(err);
               if (tryNum === 3) throw err; 
             }
           } else {
              throw new Error("GLM-5 did not execute any tools.");
           }
        }
        if (!ifc_url) {
          const exportRes = await mcpCallTool("export_ifc", {}, mcpSessionId);
          const exportData = JSON.parse(exportRes.resultText);
          ifc_url = exportData.file_url || exportData.ifc_url;
        }
        return new Response(JSON.stringify({ status: "success", ifc_url, mcpSessionId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    
    // We can also have a generic 'export' action
    if (payload.action === "export") {
       const exportRes = await mcpCallTool("export_ifc", {}, mcpSessionId);
       const exportData = JSON.parse(exportRes.resultText);
       const ifc_url = exportData.file_url || exportData.ifc_url;
       return new Response(JSON.stringify({ status: "success", ifc_url, mcpSessionId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
`;
const bDir = path.join(funcDir, 'agent-bim');
if (!fs.existsSync(bDir)) fs.mkdirSync(bDir);
fs.writeFileSync(path.join(bDir, 'index.ts'), bimCode);

// agent-reviewer
const reviewerCode = `
import { CORS, callQwen, cleanJsonResponse, mcpInit, mcpCallTool } from "../_shared/shared.ts";

const systemPrompt = \`You are the Quality Review Agent.
Inspect the generated IFC model overview and element counts.
Ensure the building contains expected structural elements (IfcWall, IfcSlab, IfcDoor, IfcWindow).
If the counts are missing or absurdly low (e.g. 0 walls), return FAIL.
Expected JSON Output:
{
  "status": "PASS" | "FAIL",
  "issues": ["string"],
  "fix_recommendations": ["string"],
  "retry_required": boolean
}\`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const payload = await req.json();
    let mcpSessionId = payload.mcpSessionId;
    if (!mcpSessionId) mcpSessionId = await mcpInit("");
    const sceneInfo = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId);
    const res = await callQwen(systemPrompt, JSON.stringify(sceneInfo.resultText), true);
    const result = cleanJsonResponse(res);
    result.mcpSessionId = mcpSessionId;
    return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
`;
const rDir = path.join(funcDir, 'agent-reviewer');
if (!fs.existsSync(rDir)) fs.mkdirSync(rDir);
fs.writeFileSync(path.join(rDir, 'index.ts'), reviewerCode);

console.log("Refactoring complete");
