/**
 * Client-side agentic loop using Qwen.
 * The Supabase Edge Function is used as a stateless LLM and MCP tool proxy, bypassing edge timeouts!
 */

// ══ CONFIG ══
const EDGE_PROXY_URL = "https://gitfkenmwzrldzqunvww.supabase.co/functions/v1/gemini-chat";
const MAX_TURNS = 25;

// We use the anon key so the Edge Function accepts the request
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU";

// ══ EDGE FUNCTION PROXY CLIENT ══

async function proxyRequest(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  const sessionId = window.sessionStorage.getItem('mcpSessionId') || '';
  
  const res = await fetch(EDGE_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Proxy Error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  
  if (data.error) {
    throw new Error(`Edge Proxy Error: ${data.error}`);
  }

  if (data.session_id) {
    window.sessionStorage.setItem('mcpSessionId', data.session_id);
  }

  return data;
}

// ══ MAIN AGENT LOOP (runs in browser, calls proxy) ══
export interface AgentResult {
  reply: string;
  ifc_url?: string;
  steps: string[];
}

export async function runQwenAgentLoop(
  userMessage: string,
  onStep: (step: string) => void
): Promise<AgentResult> {
  // 1. Initialize MCP and fetch tools and system prompt via Edge proxy
  onStep("🔌 Connecting to MCP proxy...");
  
  const initData = await proxyRequest("init");
  const tools = initData.tools || [];
  const systemPrompt = initData.system_prompt || "You are an AI architect.";

  onStep(`✅ Loaded ${tools.length} tools`);

  // Build conversation
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const steps: string[] = [];
  let ifc_url: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    onStep(`🤖 Agent thinking (turn ${turn + 1}/${MAX_TURNS})...`);

    // Call Qwen via Edge Proxy
    const response = await proxyRequest("chat", {
      messages,
      tools
    });

    const choice = response.choices?.[0];
    if (!choice) throw new Error("No response choice from LLM proxy");

    const assistantMsg = choice.message;

    // Add assistant message to history
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || [];

    // No tool calls → agent is done
    if (toolCalls.length === 0) {
      const reply = assistantMsg.content || "I have completed building your IFC model.";
      return { reply, ifc_url, steps };
    }

    // Execute each tool call via Edge proxy
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
        const proxyRes = await proxyRequest("call_tool", { name: toolName, args: toolArgs });
        toolResult = proxyRes.result;

        // Track IFC URL from export_ifc
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

      // Feed tool result back into the conversation
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
  };
}
