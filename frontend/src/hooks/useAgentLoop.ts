/**
 * Client-side agentic loop.
 * - Edge Function handles: init (MCP), call_tool (MCP)
 * - Browser calls Google AI Studio (Gemma 4) DIRECTLY for LLM chat with native tool calling
 */

// ══ CONFIG ══
const EDGE_PROXY_URL = "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1/gemini-chat";
const GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GOOGLE_AI_KEY = "AIzaSyC8lS6V2f7b6BirsrZHRuxZ688LJFUf3WQ";
const LLM_MODEL = "gemma-4-31b-it";
const MAX_TURNS = 25;

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

// ══ EDGE FUNCTION PROXY (for MCP operations only) ══

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

// ══ GOOGLE AI STUDIO — DIRECT CALL WITH NATIVE TOOL CALLING ══

async function callLLM(messages: any[], tools: any[]): Promise<any> {
  const res = await fetch(GOOGLE_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GOOGLE_AI_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      ...(tools.length > 0 && { tools, tool_choice: "auto" }),
      max_tokens: 4096
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM error ${res.status}: ${errText.slice(0, 200)}`);
  }

  return res.json();
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
  onAssistantMessage?: (msg: any) => void
): Promise<AgentResult> {
  // 1. Initialize MCP via Edge proxy (this always works)
  onStep("🔌 Connecting to backend proxy...");
  
  const initData = await proxyRequest("init", {}, clientSessionId);
  const tools = initData.tools || [];
  const systemPrompt = initData.system_prompt || "You are an AI architect.";
  const activeSessionId = initData.session_id || clientSessionId;

  onStep(`✅ Loaded ${tools.length} tools`);

  const systemMsg = { role: "system", content: systemPrompt };
  const userMsg = { role: "user", content: userMessage };
  
  const messages = previousMessages.length > 0 
    ? [systemMsg, ...previousMessages, userMsg] 
    : [systemMsg, userMsg];

  const steps: string[] = [];
  let ifc_url: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    onStep(`🤖 Agent thinking (turn ${turn + 1}/${MAX_TURNS})...`);

    // 2. Call Google AI Studio DIRECTLY from browser (native tool calling)
    const response = await callLLM(messages, tools);

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
      return { reply, ifc_url, steps, mcp_session_id: activeSessionId };
    }

    // 3. Execute tool calls via Edge proxy (MCP operations)
    for (const call of toolCalls) {
      const toolName = call.function?.name;
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(call.function?.arguments || "{}");
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
    }
  }

  return {
    reply: "Building complete (max turns reached).",
    ifc_url,
    steps,
    mcp_session_id: activeSessionId
  };
}
