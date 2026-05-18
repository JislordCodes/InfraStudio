import { useState } from 'react';

// ══ CONFIG ══
const EDGE_PROXY_BASE = "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1";
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
  
  const steps: string[] = [];
  let ifc_url: string | undefined;
  let finalReply = "Done.";
  let sessionId = clientSessionId;

  const pushStep = (msg: string) => {
    onStep(msg);
    steps.push(msg);
  };

  pushStep("🚀 Starting Multi-Agent Orchestration...");

  const messages = [...previousMessages, { role: "user", content: userMessage }];

  const callEdge = async (funcName: string, body: any) => {
    const url = `${EDGE_PROXY_BASE}/${funcName}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Error from ${funcName}: ${await res.text()}`);
    return res.json();
  };

  try {
    // 1. Interpreter
    pushStep("Interpreter Agent: Processing request...");
    const brief = await callEdge('agent-interpreter', { messages });
    
    // 2. Architect
    pushStep("Architectural Agent: Planning layout...");
    const plan = await callEdge('agent-architect', brief);

    // 3. BIM Executor (Chunking Logic)
    if (!plan.is_edit && plan.storey_plans) {
      pushStep(`BIM Agent: Received structural plan with ${plan.storey_plans.length} storeys. Beginning chunked execution...`);
      
      pushStep("BIM Agent: Initializing new project...");
      let bimRes = await callEdge('agent-bim', { action: 'initialize', mcpSessionId: sessionId });
      sessionId = bimRes.mcpSessionId;
      
      for (const storey of plan.storey_plans) {
        pushStep(`BIM Agent: Creating storey: ${storey.name}...`);
        bimRes = await callEdge('agent-bim', { action: 'create_storey', name: storey.name, elevation: storey.elevation || 0, mcpSessionId: sessionId });
        sessionId = bimRes.mcpSessionId;
        
        if (!storey.rooms) continue;
        for (let i = 0; i < storey.rooms.length; i++) {
          const room = storey.rooms[i];
          pushStep(`BIM Agent: Building ${storey.name} - ${room.name} (${i + 1}/${storey.rooms.length})...`);
          bimRes = await callEdge('agent-bim', {
            action: 'build_room',
            mcpSessionId: sessionId,
            storeyHeight: storey.height,
            room: room
          });
          sessionId = bimRes.mcpSessionId;
        }
      }
      
      pushStep("BIM Agent: All rooms built. Exporting IFC...");
      const exportRes = await callEdge('agent-bim', { action: 'export', mcpSessionId: sessionId });
      ifc_url = exportRes.ifc_url;

    } else {
      pushStep("BIM Agent: Executing dynamic modifications...");
      const bimRes = await callEdge('agent-bim', {
        action: 'dynamic_edit',
        plan: plan,
        mcpSessionId: sessionId
      });
      ifc_url = bimRes.ifc_url;
      sessionId = bimRes.mcpSessionId;
    }

    // 4. Quality Reviewer
    pushStep("Reviewer Agent: Validating model quality...");
    const review = await callEdge('agent-reviewer', { mcpSessionId: sessionId });
    
    if (review.status === "PASS") {
      pushStep("✅ Model passed quality review.");
    } else {
      pushStep(`❌ Quality Review Issues: ${review.issues?.join(', ')}`);
    }

    finalReply = "Multi-Agent Generation Complete. I've broken the rendering down into manageable chunks to prevent timeouts, and the final model is ready.";
    if (onAssistantMessage) {
      onAssistantMessage({ role: "assistant", content: finalReply });
    }

    return {
      reply: finalReply,
      ifc_url,
      steps,
      mcp_session_id: sessionId
    };

  } catch (err: any) {
    pushStep(`💥 Orchestration Error: ${err.message}`);
    throw err;
  }
}
