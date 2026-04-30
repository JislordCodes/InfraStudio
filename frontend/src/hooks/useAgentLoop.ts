/**
 * Client-side agentic loop.
 * - Edge Function handles: init (MCP), call_tool (MCP)
 * - Browser calls YepAPI DIRECTLY for LLM chat (avoids Cloudflare blocking Supabase Edge IPs)
 */

// ══ CONFIG ══
const EDGE_PROXY_URL = "https://gitfkenmwzrldzqunvww.supabase.co/functions/v1/gemini-chat";
const YEP_API_URL = "https://api.yepapi.com/v1/ai/chat";
const YEP_API_KEY = "yep_sk_91f813627b0713b732d2864302fb47b989e21c8ce08097af";
const YEP_MODEL = "anthropic/claude-opus-4.7";
const MAX_TURNS = 25;

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU";

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

// ══ DIRECT YepAPI CALL (from browser, bypasses Cloudflare edge blocks) ══

async function callYepAPIDirectly(messages: any[], tools: any[]): Promise<any> {
  // Inject tools into the system prompt for YepAPI (doesn't support native tools)
  const injectedMessages = [...messages];
  if (tools.length > 0 && injectedMessages.length > 0) {
    const sysContent = injectedMessages[0].content || "";
    if (!sysContent.includes("# AVAILABLE TOOLS")) {
      let toolPrompt = "\n\n# AVAILABLE TOOLS\nYou have access to the following tools:\n";
      tools.forEach((t: any) => {
        toolPrompt += `\nTool Name: ${t.function.name}\nDescription: ${t.function.description}\nParameters: ${JSON.stringify(t.function.parameters)}\n`;
      });
      toolPrompt += "\n\nTo use a tool, you MUST output an XML block exactly like this:\n<tool_call>\n{\n  \"name\": \"tool_name\",\n  \"arguments\": {\"param1\": 123}\n}\n</tool_call>\n\nDo NOT execute more than one tool at a time. Output the XML block and nothing else when using a tool.";
      injectedMessages[0] = { ...injectedMessages[0], content: sysContent + toolPrompt };
    }
  }

  // Call YepAPI with streaming (collect chunks)
  const res = await fetch(YEP_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": YEP_API_KEY
    },
    body: JSON.stringify({
      model: YEP_MODEL,
      messages: injectedMessages,
      maxTokens: 4096,
      stream: true
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YepAPI error ${res.status}: ${errText.slice(0, 200)}`);
  }

  // Collect streamed content
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.delta?.content ?? "";
        fullContent += text;
      } catch { /* skip malformed chunks */ }
    }
  }

  // Extract <tool_call> XML if present
  const message: any = { role: "assistant", content: fullContent };
  const toolMatch = fullContent.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (toolMatch) {
    try {
      const parsed = JSON.parse(toolMatch[1].trim());
      message.tool_calls = [{
        id: "call_" + Math.random().toString(36).substring(2, 9),
        type: "function",
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments)
        }
      }];
      message.content = fullContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/, '').trim();
    } catch { /* keep as plain text */ }
  }

  return { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] };
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

    // 2. Call YepAPI DIRECTLY from browser (bypasses Cloudflare edge blocks)
    const response = await callYepAPIDirectly(messages, tools);

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
