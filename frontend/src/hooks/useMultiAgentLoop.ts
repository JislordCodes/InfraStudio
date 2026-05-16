import { useState } from 'react';

// ══ CONFIG ══
const EDGE_PROXY_URL = "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1/gemini-chat";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

export interface MultiAgentResult {
  reply: string;
  ifc_url?: string;
  steps: string[];
  mcp_session_id?: string;
}

export async function runMultiAgentLoop(
  userMessage: string,
  previousMessages: any[],
  clientSessionId: string,
  onStep: (step: string) => void,
  onAssistantMessage?: (msg: any) => void,
  onToolResult?: (msg: any) => void
): Promise<MultiAgentResult> {
  
  onStep("🚀 Starting Multi-Agent Orchestration...");

  const messages = [...previousMessages, { role: "user", content: userMessage }];
  const steps: string[] = [];
  let ifc_url: string | undefined;
  let finalReply = "Done.";
  let sessionId = clientSessionId;

  // We use the fetch API to read the SSE stream
  return new Promise((resolve, reject) => {
    fetch(EDGE_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        action: 'chat_multi_agent',
        messages: messages,
        session_id: clientSessionId
      })
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Edge Proxy Error: ${response.status} - ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No readable stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const dataStr = line.slice(6);
              if (dataStr === "[DONE]") {
                break;
              }
              const payload = JSON.parse(dataStr);

              if (payload.type === 'step') {
                onStep(payload.message);
                steps.push(payload.message);
              }
              else if (payload.type === 'assistant_message') {
                if (onAssistantMessage) onAssistantMessage(payload.message);
                if (payload.message.content) {
                  finalReply = payload.message.content;
                }
              }
              else if (payload.type === 'tool_result') {
                if (onToolResult) onToolResult(payload.message);
              }
              else if (payload.type === 'complete') {
                ifc_url = payload.ifc_url;
                sessionId = payload.session_id;
              }
              else if (payload.type === 'error') {
                reject(new Error(payload.error));
                return;
              }
            } catch (e) {
              console.warn("Failed to parse SSE line", line);
            }
          }
        }
      }

      resolve({
        reply: finalReply,
        ifc_url,
        steps,
        mcp_session_id: sessionId
      });
      
    }).catch(reject);
  });
}
