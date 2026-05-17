import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ══ CONFIG ══
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const LOCATION = "global";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ══ MCP UTILITIES ══
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
  
  if (payload.error) {
    throw new Error(`Tool ${name} failed: ${JSON.stringify(payload.error)}`);
  }
  
  const resultText = extractText((payload?.result as Record<string, unknown>)?.content) || JSON.stringify(payload?.result ?? "done");
  
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(`Tool ${name} reported failure: ${parsed.error || JSON.stringify(parsed)}`);
    }
  } catch (e) {
    // If it's an actual JSON parsing error, ignore it (not all results are JSON).
    // If it's our thrown Error, rethrow it.
    if (e instanceof Error && e.message.startsWith("Tool ")) throw e;
  }
  
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
        description: (t.description || "").slice(0, 256),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}

// ══ GCP AUTH ══
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

// ══ LLM CLIENTS ══
async function callQwen(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false): Promise<string> {
  const qwenKey = Deno.env.get("QWEN_API_KEY");
  if (!qwenKey) throw new Error("QWEN_API_KEY missing");
  
  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage)) {
    // Strip empty contents or tool calls just in case
    msgs = msgs.concat(userMessage.map(m => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }
  
  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-max",
      messages: msgs,
      temperature: 0.1,
      response_format: jsonMode ? { type: "json_object" } : undefined
    })
  });
  
  if (!res.ok) throw new Error(`Qwen Error: ${await res.text()}`);
  
  const data = await res.json();
  return data.choices[0].message.content || "";
}

async function callGLM(systemPrompt: string, userMessage: string, tools?: any[]): Promise<any> {
  const saJsonString = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY") || "{}";
  const saJson = JSON.parse(saJsonString);
  const accessToken = await mintAccessToken(saJson);
  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${saJson.project_id}/locations/${LOCATION}/endpoints/openapi/chat/completions`;
  const body: any = {
    model: "zai-org/glm-5-maas",
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
    temperature: 0.1
  };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GLM Error: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

// ══ OBSERVABILITY & SSE ══
class EventLogger {
  private keepAliveInterval: number | null = null;

  constructor(private controller: ReadableStreamDefaultController) {
    this.keepAliveInterval = setInterval(() => {
      try {
        // SSE comment to keep the connection alive
        this.controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
      } catch (e) {
        this.stopKeepAlive();
      }
    }, 5000);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval !== null) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  log(agent: string, message: string, data?: any) {
    console.log(`[${agent}] ${message}`);
    const payload = JSON.stringify({ type: "step", agent, message, data });
    try { this.controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`)); } catch {}
  }

  complete(ifc_url: string, session_id: string, reply: string) {
    this.stopKeepAlive();
    const payload1 = JSON.stringify({ type: "assistant_message", message: { role: "assistant", content: reply } });
    try { this.controller.enqueue(new TextEncoder().encode(`data: ${payload1}\n\n`)); } catch {}
    const payload2 = JSON.stringify({ type: "complete", ifc_url, session_id });
    try { this.controller.enqueue(new TextEncoder().encode(`data: ${payload2}\n\n`)); } catch {}
    try { this.controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`)); } catch {}
    try { this.controller.close(); } catch {}
  }

  error(err: any) {
    this.stopKeepAlive();
    const payload = JSON.stringify({ type: "error", error: String(err) });
    try { this.controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`)); } catch {}
    try { this.controller.close(); } catch {}
  }
}

// ══ MULTI-AGENT ARCHITECTURE ══

// 1. Memory Context
class WorkflowContext {
  public messages: any[] = [];
  public userPrompt: string = "";
  public interpreterBrief: any = null;
  public architecturalPlan: any = null;
  public bimExecutionState: any = null;
  public reviewHistory: any[] = [];
  public mcpSessionId: string = "";
  public availableTools: any[] = [];
  public currentIfcUrl: string = "";
}

// 2. Base Agent Class
abstract class BaseAgent {
  abstract name: string;
  abstract systemPrompt: string;
  abstract llmProvider: "qwen" | "glm";

  constructor(protected logger: EventLogger, protected context: WorkflowContext) {}

  abstract run(input: any): Promise<any>;
  abstract validateOutput(output: any): boolean;

  // 3. Retry Logic
  async runWithRetry(input: any, maxRetries = 2): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const output = await this.run(input);
        if (this.validateOutput(output)) {
          return output;
        }
        this.logger.log(this.name, `Validation failed on attempt ${attempt}. Output was: ${JSON.stringify(output).substring(0, 500)}... Retrying...`);
      } catch (err) {
        this.logger.log(this.name, `Error on attempt ${attempt}: ${err}`);
        if (attempt === maxRetries) throw err;
      }
    }
    throw new Error(`${this.name} failed after ${maxRetries} attempts.`);
  }

  protected cleanJsonResponse(rawStr: string): any {
    const match = rawStr.match(/```(?:json)?\n([\s\S]*?)\n```/);
    let clean = match ? match[1] : rawStr;
    clean = clean.trim();
    
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }
    
    return JSON.parse(clean);
  }
}

// ── Agent Implementations ──

class InterpreterAgent extends BaseAgent {
  name = "Interpreter Agent";
  llmProvider = "qwen" as const;
  systemPrompt = `You are the Interpreter Agent.
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
}`;

  async run(messages: any[]) {
    this.logger.log(this.name, "Extracting requirements and analyzing conversation history...");
    const res = await callQwen(this.systemPrompt, messages, true);
    return this.cleanJsonResponse(res);
  }

  validateOutput(output: any): boolean {
    return output && typeof output.is_edit === "boolean";
  }
}

class ArchitecturalAgent extends BaseAgent {
  name = "Architectural Reasoning Agent";
  llmProvider = "glm" as const;
  systemPrompt = `You are the Architectural Reasoning Agent.
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
Must NOT: Call BIM tools.
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
}`;

  async run(brief: any) {
    this.logger.log(this.name, brief.is_edit ? "Formulating modification strategy..." : "Performing spatial reasoning and layout generation...");
    // Inject previous review failures if we are in a correction loop
    let promptStr = JSON.stringify(brief);
    if (this.context.reviewHistory.length > 0) {
      promptStr += `\n\nPREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(this.context.reviewHistory)}`;
    }
    const msg = await callGLM(this.systemPrompt, promptStr);
    return this.cleanJsonResponse(msg.content);
  }

  validateOutput(output: any): boolean {
    if (!output || typeof output.is_edit !== "boolean") return false;
    if (!output.is_edit) {
      if (!Array.isArray(output.storey_plans)) return false;
      for (const storey of output.storey_plans) {
        if (!storey || typeof storey !== "object" || Array.isArray(storey)) return false;
        if (storey.rooms && !Array.isArray(storey.rooms)) return false;
        if (storey.rooms) {
          for (const room of storey.rooms) {
            if (!room || typeof room !== "object" || Array.isArray(room)) return false;
          }
        }
      }
    }
    return true;
  }
}

class BimMcpAgent extends BaseAgent {
  name = "BIM MCP Agent";
  llmProvider = "glm" as const;
  systemPrompt = "You are the BIM Executor.";

  async run(plan: any) {
    this.logger.log(this.name, plan.is_edit ? "Executing modifications on existing model..." : "Converting spatial plans into IFC-native models...");
    
    // If it's a completely new standard building, execute deterministic orchestrator tools
    if (!plan.is_edit && plan.storey_plans && plan.storey_plans.length > 0) {
      this.logger.log(this.name, "Invoking build_building orchestration macro...");
      const buildRes = await mcpCallTool("build_building", {
        building_name: "InfraStudio AI Building",
        storeys: plan.storey_plans
      }, this.context.mcpSessionId);
      
      this.logger.log(this.name, "Exporting IFC model...");
      const exportRes = await mcpCallTool("export_ifc", {}, this.context.mcpSessionId);
      const exportData = JSON.parse(exportRes.resultText);
      return { status: "success", ifc_url: exportData.file_url || exportData.ifc_url, raw_result: buildRes };
    }
    
    // Otherwise, use Qwen to filter tools and GLM-5 to execute them dynamically for edits or custom models
    this.logger.log(this.name, "Plan requires dynamic modifications. Routing tools via Qwen...");
    const ALWAYS_EXPOSED = new Set([
      "export_ifc", "get_scene_info", "create_surface_style", "apply_style_to_object", "create_trimesh_ifc"
    ]);
    const availableToolsList = this.context.availableTools
      .filter(t => !ALWAYS_EXPOSED.has(t.function.name))
      .map(t => `- ${t.function.name}: ${t.function.description}`)
      .join("\n");
      
    const qwenPrompt = `You are a Tool Retrieval Intelligence Layer.
Extract the names of the specific tools needed for this architectural plan.
Plan: "${JSON.stringify(plan)}"
Available Tools:
${availableToolsList}
RULES: Return ONLY a comma-separated list of tool names. If none, reply "NONE".`;

    const extractedRaw = await callQwen(qwenPrompt, "Extract tools", false);
    const needed = new Set<string>(ALWAYS_EXPOSED);
    if (extractedRaw && extractedRaw.trim() !== "NONE") {
      extractedRaw.split(",").map(s => s.trim()).forEach(name => { if (name) needed.add(name); });
    }
    const routedTools = this.context.availableTools.filter(t => needed.has(t.function.name));
    this.logger.log(this.name, `Qwen extracted ${routedTools.length} relevant tools. Executing via GLM-5...`);

    let glmPrompt = `You are the BIM Executor. Use your tools to build or modify the requested architecture. 
CRITICAL RULES:
1. You MUST call export_ifc as the very last step.
2. If assigning styles, you must first create the style (e.g. create_surface_style) and use the returned name in apply_style_to_object.
3. If editing, use the EXACT GlobalId (GUID) from the Current IFC Scene State provided. Do not guess GUIDs.
4. CRITICAL FOR TRIMESH: When using create_trimesh_ifc, assign the final geometry to a variable exactly named 'result' and NEVER use print() statements.
5. TIMEOUT PREVENTION: Output ONLY the requested tool calls. Do not write extensive explanations or conversational text.`;
    
    let planData = JSON.stringify(plan);
    if (plan.is_edit) {
      this.logger.log(this.name, "Fetching current scene state to provide edit context...");
      const sceneRes = await mcpCallTool("get_scene_info", { include_bbox: false }, this.context.mcpSessionId);
      planData = `Instructions: ${JSON.stringify(plan)}\n\nCurrent IFC Scene State:\n${sceneRes.resultText}`;
      glmPrompt += "\n4. You are EDITING an existing scene. Find the GlobalId of the target objects in the Scene State and pass them to your tool calls.";
    }

    let ifc_url = "";
    let executionError = "";
    
    // Internal auto-correction loop for GLM-5 tool execution (max 3 tries)
    for (let tryNum = 1; tryNum <= 3; tryNum++) {
       let currentPlanData = planData;
       if (executionError) {
           this.logger.log(this.name, `Retrying tool execution (Attempt ${tryNum}/3)...`);
           currentPlanData += `\n\nPREVIOUS EXECUTION FAILED WITH ERROR:\n${executionError}\nPlease fix your tool arguments and try again.`;
           executionError = ""; // Reset for this attempt
       }
       
       const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools);
       
       if (glmMsg.tool_calls) {
         try {
           for (const call of glmMsg.tool_calls) {
              const args = JSON.parse(call.function.arguments || "{}");
              this.logger.log(this.name, `🔧 ${call.function.name}(...)`);
              const toolRes = await mcpCallTool(call.function.name, args, this.context.mcpSessionId);
              if (call.function.name === "export_ifc") {
                try { const p = JSON.parse(toolRes.resultText); ifc_url = p.file_url || p.ifc_url; } catch{}
              }
           }
           // If we got here, all tools succeeded
           break;
         } catch (err: any) {
           executionError = err.message || String(err);
           this.logger.log(this.name, `Tool Execution Failed: ${executionError}`);
           if (tryNum === 3) throw err; // Throw on final attempt
         }
       } else {
          throw new Error("GLM-5 did not execute any tools.");
       }
    }
    
    if (!ifc_url) {
      const exportRes = await mcpCallTool("export_ifc", {}, this.context.mcpSessionId);
      const exportData = JSON.parse(exportRes.resultText);
      ifc_url = exportData.file_url || exportData.ifc_url;
    }

    return { status: "success", ifc_url, raw_result: "Dynamic execution complete" };
  }

  validateOutput(output: any): boolean {
    return !!output.ifc_url;
  }
}

class QualityReviewAgent extends BaseAgent {
  name = "Quality Review Agent";
  llmProvider = "qwen" as const;
  systemPrompt = `You are the Quality Review Agent.
Inspect the generated IFC model overview and element counts.
Ensure the building contains expected structural elements (IfcWall, IfcSlab, IfcDoor, IfcWindow).
If the counts are missing or absurdly low (e.g. 0 walls), return FAIL.
Expected JSON Output:
{
  "status": "PASS" | "FAIL",
  "issues": ["string"],
  "fix_recommendations": ["string"],
  "retry_required": boolean
}`;

  async run(sceneData: any) {
    this.logger.log(this.name, "Validating geometry and IFC semantics...");
    const res = await callQwen(this.systemPrompt, JSON.stringify(sceneData), true);
    return this.cleanJsonResponse(res);
  }

  validateOutput(output: any): boolean {
    return output && (output.status === "PASS" || output.status === "FAIL");
  }
}

// 4. Orchestration Pipeline
async function runMultiAgentOrchestrator(req: Request): Promise<Response> {
  const payload = await req.json();
  
  const stream = new ReadableStream({
    async start(controller) {
      const logger = new EventLogger(controller);
      const context = new WorkflowContext();
      
      try {
        context.messages = payload.messages || [];
        context.userPrompt = context.messages.length > 0 ? context.messages[context.messages.length - 1].content : "";
        context.mcpSessionId = payload.session_id || await mcpInit("");
        const tResult = await fetchMcpTools(context.mcpSessionId);
        context.availableTools = tResult.tools;

        // Initialize Agents
        const interpreter = new InterpreterAgent(logger, context);
        const architect = new ArchitecturalAgent(logger, context);
        const bimExecutor = new BimMcpAgent(logger, context);
        const reviewer = new QualityReviewAgent(logger, context);

        // Stage 1: Interpretation (Provide entire conversation history)
        context.interpreterBrief = await interpreter.runWithRetry(context.messages, 2);

        // 5. Correction Loop
        const MAX_LOOPS = 2;
        let loopCount = 0;
        let finalReviewPassed = false;

        while (loopCount < MAX_LOOPS && !finalReviewPassed) {
          loopCount++;
          if (loopCount > 1) {
            logger.log("Orchestrator", `Initiating Correction Loop (Attempt ${loopCount}/${MAX_LOOPS})...`);
          }

          // Stage 2: Architectural Reasoning
          context.architecturalPlan = await architect.runWithRetry(context.interpreterBrief, 2);

          // Stage 3: BIM Execution
          context.bimExecutionState = await bimExecutor.runWithRetry(context.architecturalPlan, 1);
          context.currentIfcUrl = context.bimExecutionState.ifc_url;

          // Stage 4: Quality Review
          const sceneInfo = await mcpCallTool("get_ifc_scene_overview", {}, context.mcpSessionId);
          const review = await reviewer.runWithRetry(sceneInfo.resultText, 2);

          if (review.status === "PASS") {
            logger.log(reviewer.name, "Model passed quality review. No corrections needed.");
            finalReviewPassed = true;
          } else {
            logger.log(reviewer.name, `Validation FAIL. Issues: ${review.issues.join(", ")}`);
            context.reviewHistory.push(review);
            if (!review.retry_required) break; // Hard fail, no retry
          }
        }

        const summary = `Multi-Agent Generation Complete.\n\n**Interpreter:** Processed brief.\n**Architect:** Planned ${context.architecturalPlan?.storey_plans?.length || 0} floors.\n**Reviewer:** ${finalReviewPassed ? "PASSED" : "FAILED (Max retries reached)"}.`;
        
        logger.complete(context.currentIfcUrl, context.mcpSessionId, summary);

      } catch (err) {
        logger.error(err);
      }
    }
  });

  return new Response(stream, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
}

// ══ HTTP HANDLER ══
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });

  const clonedReq = req.clone();
  try {
    const payload = await clonedReq.json();
    if (payload.action === "chat_multi_agent") return runMultiAgentOrchestrator(req);
    
    // Legacy routing
    if (payload.action === "init") {
      const initSession = await mcpInit(payload.session_id || "");
      const toolsResult = await fetchMcpTools(initSession);
      return new Response(JSON.stringify({ tools: toolsResult.tools, session_id: toolsResult.session }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (payload.action === "call_tool") {
      let sId = payload.session_id;
      if (!sId) sId = await mcpInit("");
      const res = await mcpCallTool(payload.name, payload.args || {}, sId);
      return new Response(JSON.stringify({ result: res.resultText, session_id: sId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
  return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: CORS });
});
