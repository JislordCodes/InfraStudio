// ══ CONFIG ══
const EDGE_PROXY_BASE = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";
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
  _onToolResult?: (msg: any) => void
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
    const brief = await callEdge('agent-interpreter', { messages, sessionId });
    const structureCategory = brief.structure_category || "building";
    pushStep(`Interpreter Agent: Classified as '${structureCategory}' structure.`);
    
    // 2. Architect
    pushStep("Architectural Agent: Planning layout...");
    const plan = await callEdge('agent-architect', brief);

    // 3. BIM Executor — branch based on structure category
    const isBuilding = structureCategory === "building" && !plan.is_edit && plan.storey_plans;
    const isInfrastructure = !plan.is_edit && (structureCategory !== "building" || plan.components);

    if (isBuilding) {
      // ═══ BUILDING MODE: Existing room-by-room pipeline ═══
      pushStep(`BIM Agent: Building mode — ${plan.storey_plans.length} storeys. Beginning chunked execution...`);
      
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

      // Deduplicate shared walls between adjacent rooms
      pushStep("BIM Agent: Removing duplicate walls at shared boundaries...");
      try {
        const dedupRes = await callEdge('agent-bim', { action: 'deduplicate_walls', mcpSessionId: sessionId });
        sessionId = dedupRes.mcpSessionId;
        if (dedupRes.removed > 0) {
          pushStep(`BIM Agent: Removed ${dedupRes.removed} overlapping wall(s).`);
        }
      } catch (e) {
        console.warn('Wall deduplication skipped:', e);
      }
      
      const roofTypeRequested = plan.roof_type || (plan.special_elements?.find((e: string) => /roof|gable|hip|flat/i.test(e)));
      if (roofTypeRequested && roofTypeRequested !== "none") {
        pushStep(`BIM Agent: Creating ${roofTypeRequested} roof...`);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxHeight = 3;
        for (const storey of plan.storey_plans || []) {
          maxHeight = Math.max(maxHeight, storey.height || 3);
          for (const r of storey.rooms || []) {
            const [ox, oy] = r.origin || [0, 0, 0];
            const w = r.width || 4;
            const l = r.length || 4;
            minX = Math.min(minX, ox);
            minY = Math.min(minY, oy);
            maxX = Math.max(maxX, ox + w);
            maxY = Math.max(maxY, oy + l);
          }
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 6; maxY = 6; }

        bimRes = await callEdge('agent-bim', {
          action: 'create_roof',
          roof_type: roofTypeRequested,
          bbox: { minX, minY, maxX, maxY, height: maxHeight },
          mcpSessionId: sessionId
        });
        if (bimRes?.mcpSessionId) sessionId = bimRes.mcpSessionId;
      }

      if (plan.material_palette) {
        pushStep("BIM Agent: Applying requested material finishes...");
        bimRes = await callEdge('agent-bim', { action: 'apply_materials', mcpSessionId: sessionId });
        if (bimRes?.mcpSessionId) sessionId = bimRes.mcpSessionId;
      }

      pushStep("BIM Agent: All elements generated. Exporting IFC...");
      const exportRes = await callEdge('agent-bim', { action: 'export', mcpSessionId: sessionId });
      ifc_url = exportRes.ifc_url;

    } else if (isInfrastructure) {
      // ═══ INFRASTRUCTURE/MEP/CUSTOM MODE: Let BIM agent think freely ═══
      const componentCount = plan.components?.length || 0;
      pushStep(`BIM Agent: Infrastructure mode — ${componentCount} components planned. Letting BIM agent decide tools...`);
      
      const bimRes = await callEdge('agent-bim', {
        action: 'build_freeform',
        plan: plan,
        mcpSessionId: sessionId
      });
      ifc_url = bimRes.ifc_url;
      sessionId = bimRes.mcpSessionId;
      
      if (bimRes.executedTools?.length) {
        pushStep(`BIM Agent: Executed ${bimRes.executedTools.length} tool calls: ${bimRes.executedTools.join(', ')}`);
      }

    } else {
      // ═══ EDIT MODE ═══
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

    finalReply = "Multi-Agent Generation Complete. The final model is ready.";
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
