import { setGlobalDispatcher, Agent } from "undici";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { handleInterpreter } from "../supabase/functions/agent-interpreter/index.ts";
import { handleArchitect } from "../supabase/functions/agent-architect/index.ts";
import { handleReviewer } from "../supabase/functions/agent-reviewer/index.ts";
import { handleBim } from "../supabase/functions/agent-bim/index.ts";
import { mcpInit, mcpCallTool, fetchMcpTools } from "../supabase/functions/_shared/shared.ts";

// Set global dispatcher with 10-minute timeouts for reasoning models (qwen3.7-max)
const globalAgent = new Agent({
  headersTimeout: 600000, // 10 minutes
  bodyTimeout: 600000,    // 10 minutes
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

export const handler = async (event: any) => {
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
