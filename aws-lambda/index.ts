import { setGlobalDispatcher, Agent } from "undici";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { handleInterpreter } from "../supabase/functions/agent-interpreter/index.ts";
import { handleArchitect } from "../supabase/functions/agent-architect/index.ts";
import { handleReviewer } from "../supabase/functions/agent-reviewer/index.ts";
import { handleBim } from "../supabase/functions/agent-bim/index.ts";
import { mcpInit, mcpCallTool, fetchMcpTools } from "../supabase/functions/_shared/shared.ts";

// Set global dispatcher with 10-minute timeouts for reasoning models (qwen3.7-max)
const globalAgent = new Agent({
  headersTimeout: 850000, // ~14 minutes - matches the 900s Lambda ceiling with margin
  bodyTimeout: 850000,    // ~14 minutes - matches the 900s Lambda ceiling with margin
  connectTimeout: 60000,  // 1 minute
});
setGlobalDispatcher(globalAgent);

const secretsClient = new SecretsManagerClient({});
let qwenSecretLoaded = false;
async function loadQwenSecret(): Promise<void> {
  if (qwenSecretLoaded || process.env.QWEN_API_KEY) return;
  const secretId = process.env.QWEN_SECRET_ID;
  if (!secretId) return;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = result.SecretString || "";
  let key = raw;
  try {
    const parsed = JSON.parse(raw);
    key = parsed.api_key || parsed.QWEN_API_KEY || parsed.key || raw;
  } catch { /* plain-text secret */ }
  if (!key || key === "PENDING") throw new Error("Qwen Secrets Manager secret is empty or not configured");
  process.env.QWEN_API_KEY = key;
  qwenSecretLoaded = true;
}


let explabsSecretLoaded = false;
async function loadExplabsSecret(): Promise<void> {
  if (explabsSecretLoaded || process.env.EXPLABS_API_KEY) return;
  const secretId = process.env.EXPLABS_SECRET_ID;
  if (!secretId) return;
  try {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = result.SecretString || "";
    let key = raw;
    try {
      const parsed = JSON.parse(raw);
      key = parsed.EXPLABS_API_KEY || parsed.api_key || parsed.key || raw;
    } catch { /* plain-text secret */ }
    if (key && key !== "PENDING") {
      process.env.EXPLABS_API_KEY = key;
      explabsSecretLoaded = true;
    }
  } catch (e) {
    console.warn("Could not load EXPLABS_SECRET_ID:", e);
  }
}

export const handler = async (event: any, context: any) => {
  const path = event.rawPath || "/";
  const method = event.requestContext?.http?.method || "POST";

  // Function URL CORS is configured by deploy.ps1. Do not add a second set of
  // headers here: Lambda Function URLs merge duplicate CORS headers, producing
  // an invalid value such as "*, https://app.example" that browsers reject as
  // a network-level "Failed to fetch" error.
  const corsHeaders: Record<string, string> = {};

  // Handle CORS preflight options request
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  // Parse HTTP request body
  let payload: any = {};
  if (event.body) {
    try {
      const decodedBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
      payload = JSON.parse(decodedBody);
    } catch (e) {
      console.error("Failed to parse request body:", e);
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON body" })
      };
    }
  }

  // Set (overwriting anything the client itself sent under this key) AFTER
  // parsing the client's JSON body, so a visitor cannot spoof their own IP
  // through the request payload - this is what the trial gate in
  // agent-bim/_shared/trial_gate.ts keys the one-free-build-per-IP limit on.
  payload._clientIp = event.requestContext?.http?.sourceIp || "";

  // Route requests by path
  try {
    await loadQwenSecret();
    await loadExplabsSecret();
    let result: any = null;
    const cleanPath = path.replace(/\/$/, ""); // remove trailing slash

    if (cleanPath.endsWith("/agent-interpreter")) {
      result = await handleInterpreter(payload);
    } else if (cleanPath.endsWith("/agent-architect")) {
      result = await handleArchitect(payload);
    } else if (cleanPath.endsWith("/agent-reviewer")) {
      result = await handleReviewer(payload);
    } else if (cleanPath.endsWith("/agent-bim")) {
      // Large structures (many rooms/components) can legitimately take
      // longer to generate than the Lambda's own hard ceiling allows in one
      // invocation, since real per-piece verification against a growing
      // live scene can't be parallelized. Rather than let that end in a
      // mid-request timeout, hand handleBim a real deadline (with a safety
      // margin for QA/materials/export after generation) so it can stop
      // cleanly and return exactly where it left off - see the
      // "continuation" field in its response and payload.continuation here.
      const remainingMs = typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 850000;
      // Buffer must comfortably exceed the worst case for ONE in-flight room/component/
      // agentic iteration (a single model call can take up to 300s for the heavier
      // whole-structure design calls, plus MCP execute+verify round trips) so the
      // generation loop always gets a chance to see the deadline and return a clean
      // {status:"continue"} response before AWS hard-kills the invocation at `Timeout`.
      payload._deadline = Date.now() + Math.max(30000, remainingMs - 350000);
      result = await handleBim(payload);
    } else if (cleanPath.endsWith("/gemini-chat")) {
      // Direct handling for legacy / chat calls
      if (payload.action === "init") {
        const initSession = await mcpInit(payload.session_id || "");
        const toolsResult = await fetchMcpTools(initSession);
        result = { tools: toolsResult.tools, session_id: toolsResult.session };
      } else if (payload.action === "call_tool") {
        let sId = payload.session_id;
        if (!sId) sId = await mcpInit("");
        const res = await mcpCallTool(payload.name, payload.args || {}, sId);
        result = { result: res.resultText, session_id: sId };
      } else {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid action for gemini-chat endpoint" })
        };
      }
    } else {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Path not found: ${path}` })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(result)
    };
  } catch (err: any) {
    console.error(`Error processing path ${path}:`, err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
