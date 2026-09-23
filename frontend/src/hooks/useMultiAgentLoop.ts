// ══ CONFIG ══
const EDGE_PROXY_BASE = import.meta.env.VITE_EDGE_PROXY_BASE || "https://xdii2dngnrumglsuv74fv5awz40rgwrg.lambda-url.us-east-1.on.aws";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

export interface MultiAgentResult {
  reply: string;
  ifc_url?: string;
  steps: string[];
  mcp_session_id?: string;
  trialUsed?: boolean;
  waitlistUrl?: string;
}

export interface ReferenceImageInput {
  url: string;
  caption?: string;
}

/**
 * Direct build path for the Antigravity engine (USE_ANTIGRAVITY_ENGINE=true
 * on the Lambda): sends the user's raw message straight to agent-bim's
 * build_code action, skipping the interpreter/architect/reviewer chain
 * entirely. Those existed to compensate for direct-model pipelines that
 * couldn't reliably interpret a brief, design a correct structure, AND
 * self-check their own output in one pass - Antigravity (a real agentic
 * coding CLI) already does all three itself within a single headless run,
 * confirmed this session on both a cellular and a braced cofferdam build
 * (correct structure-type reasoning, thousands of elements, full materials,
 * self-verified against get_scene_info before export). Routing through three
 * extra LLM calls first would just add latency for output agy already
 * produces on its own.
 */
export async function runAntigravityBuild(
  userMessage: string,
  clientSessionId: string,
  onStep: (step: string) => void,
  onAssistantMessage?: (msg: any) => void,
  images: ReferenceImageInput[] = [],
): Promise<MultiAgentResult> {
  const steps: string[] = [];
  const pushStep = (msg: string) => {
    onStep(msg);
    steps.push(msg);
  };

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

  pushStep("🤖 InfraStudio Engine build starting...");

  // Owner/trusted-tester bypass for the public trial gate - only present if
  // this browser tab actually visited .../studios?unlock=<code> (see
  // App.tsx). sessionStorage, not localStorage, so it lasts for this tab's
  // messages/polls but does NOT carry over to a plain, fresh /studios visit
  // later - checked against the real secret server-side (trial_gate.ts).
  // Absent for every ordinary visitor, so this is a no-op for them.
  const unlockCode = sessionStorage.getItem('infrastudio_unlock_code') || undefined;

  try {
    let bimRes = await callEdge('agent-bim', {
      action: 'build_code',
      plan: { client_requirements: userMessage, images, unlockCode },
      mcpSessionId: clientSessionId,
    });
    let sessionId = bimRes.mcpSessionId || clientSessionId;

    // Each poll paces itself server-side (~8s) and returns fast, so this can
    // afford a much larger pass budget than the old OpenHands loop (which
    // blocked internally for most of a Lambda invocation per pass) - 200
    // passes at ~8-10s each covers roughly agy's own 30-minute print-timeout.
    let continuePasses = 0;
    const maxContinuePasses = 200;
    while (bimRes.status === 'continue' && continuePasses < maxContinuePasses) {
      continuePasses++;
      if (bimRes.progress) pushStep(bimRes.progress);
      bimRes = await callEdge('agent-bim', {
        action: 'build_code',
        // unlockCode travels on every poll, not just the first call: the
        // backend re-checks it on the SAME call that finally returns
        // success (see agent-bim/index.ts) to decide whether to record this
        // IP as having used its trial - without it here, an unlocked
        // build's own completion call would look unlocked-less and get the
        // owner's IP marked used anyway.
        plan: { client_requirements: userMessage, continuation: bimRes.continuation, unlockCode },
        mcpSessionId: sessionId,
      });
      sessionId = bimRes.mcpSessionId || sessionId;
    }

    if (bimRes.status === 'continue') {
      pushStep(`⚠️ Build still running after ${maxContinuePasses} checks - it may finish later; re-open this chat to check back.`);
      return { reply: "Build is still running in the background.", steps, mcp_session_id: sessionId };
    }
    // Public trial gate (see agent-bim/_shared/trial_gate.ts): this is a
    // real, expected outcome for a repeat visitor, not a failure - handled
    // distinctly here so the UI can offer the waitlist instead of showing a
    // generic error bubble.
    if (bimRes.status === 'trial_used') {
      pushStep("🔒 Free trial already used on this connection.");
      return {
        reply: bimRes.error || "You've already used your free trial build. Join the waitlist to get full access.",
        steps,
        mcp_session_id: sessionId,
        trialUsed: true,
        waitlistUrl: bimRes.waitlist_url,
      };
    }
    if (bimRes.status === 'error') {
      throw new Error(bimRes.error || 'Build failed.');
    }

    pushStep("✅ Build complete.");
    const reply = "Build complete. The model is ready.";
    if (onAssistantMessage) onAssistantMessage({ role: "assistant", content: reply });
    return { reply, ifc_url: bimRes.ifc_url, steps, mcp_session_id: sessionId };
  } catch (err: any) {
    pushStep(`💥 Build error: ${err.message}`);
    throw err;
  }
}

export async function runMultiAgentLoop(
  userMessage: string,
  previousMessages: any[],
  clientSessionId: string,
  onStep: (step: string) => void,
  onAssistantMessage?: (msg: any) => void,
  _onToolResult?: (msg: any) => void,
  selectedModel: string = 'kimi-k3'
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
    const brief = await callEdge('agent-interpreter', { messages, sessionId, model: selectedModel });
    if (brief.needs_clarification) {
      const question = brief.clarifying_question || "Please describe the building or infrastructure you want, including scale and key spaces.";
      pushStep("Interpreter Agent: More design information is needed before modelling.");
      if (onAssistantMessage) onAssistantMessage({ role: "assistant", content: question });
      return { reply: question, steps, mcp_session_id: sessionId };
    }
    const structureCategory = brief.structure_category || "building";
    const isEdit = Boolean(brief.is_edit);
    pushStep(`Interpreter Agent: Classified as '${structureCategory}' structure (is_edit: ${isEdit}).`);
    
    // 2. Architect
    pushStep(`Architectural Agent: Planning layout with ${selectedModel} & Antigravity...`);
    const plan = await callEdge('agent-architect', { ...brief, client_requirements: userMessage, prompt: userMessage, model: selectedModel });

    // Force plan.is_edit if interpreter determined it is an edit
    if (isEdit) plan.is_edit = true;

    // 3. BIM Executor — branch based on edit vs new design
    const isNew = !plan.is_edit;

    // A new design must get a new MCP model. Reusing a session that previously
    // held another project mixes its geometry into the new IFC.
    if (isNew) {
      sessionId = '';
    }

    if (isNew && plan.layout_validation?.repairs?.length) {
      pushStep(`Architectural Agent: Spatial layout repaired — ${plan.layout_validation.repairs.join(' ')}`);
    }

    if (isNew) {
      // ═══ MONOLITHIC CODE EXECUTION (checkpointed across calls) ═══
      pushStep(`BIM Agent: Generating complete ${structureCategory} model via execute_ifc_code_tool...`);
      let bimRes = await callEdge('agent-bim', {
        action: 'build_code',
        plan: plan,
        mcpSessionId: sessionId,
        model: selectedModel
      });
      sessionId = bimRes.mcpSessionId;

      // A structure with enough components (a real bridge, a large building)
      // can need more real design time than fits in a single Lambda
      // invocation. The backend checkpoints cleanly and returns
      // status:"continue" with everything needed to resume - previously
      // this was never checked, so any build that didn't finish in one call
      // silently reported "ready" with no ifc_url and nothing on the scene.
      // Keep calling with the returned continuation until it actually finishes.
      let continuePasses = 0;
      const maxContinuePasses = 25;
      while (bimRes.status === 'continue' && continuePasses < maxContinuePasses) {
        continuePasses++;
        pushStep(`BIM Agent: ${bimRes.progress || 'Continuing generation...'} (pass ${continuePasses})`);
        bimRes = await callEdge('agent-bim', {
          action: 'build_code',
          plan: { ...plan, continuation: bimRes.continuation },
          mcpSessionId: sessionId,
          model: selectedModel
        });
        sessionId = bimRes.mcpSessionId;
      }
      if (bimRes.status === 'continue') {
        pushStep(`⚠️ Generation paused after ${maxContinuePasses} continuation passes without finishing - the structure may be unusually large.`);
      } else if (bimRes.status === 'error') {
        throw new Error(bimRes.error || 'BIM Agent failed to generate the model.');
      }
      ifc_url = bimRes.ifc_url;
    } else {
      // ═══ EDIT MODE (BUILD UPON ACTIVE MODEL - DO NOT INITIALIZE / ERASE) ═══
      pushStep(`BIM Agent: Modifying active model in session (Session: ${sessionId || 'new'})...`);

      // 1. Create any new storeys requested in the edit
      const editStoreys = plan.new_storeys || [];
      for (const storey of editStoreys) {
        pushStep(`BIM Agent: Adding new storey: ${storey.name}...`);
        const sRes = await callEdge('agent-bim', { action: 'create_storey', name: storey.name, elevation: storey.elevation || 0, mcpSessionId: sessionId });
        sessionId = sRes.mcpSessionId;
      }

      // 2. Build any new rooms requested in the edit onto the active model
      const editRooms = plan.new_rooms || [];
      if (editRooms.length > 0) {
        pushStep(`BIM Agent: Adding ${editRooms.length} new room(s) to existing structure...`);
        for (let i = 0; i < editRooms.length; i++) {
          const room = editRooms[i];
          pushStep(`BIM Agent: Building ${room.name || 'Room Extension'} (${i + 1}/${editRooms.length})...`);
          const rRes = await callEdge('agent-bim', {
            action: 'build_room',
            mcpSessionId: sessionId,
            storeyHeight: room.height || 3,
            room: room
          });
          sessionId = rRes.mcpSessionId;
        }

        // Deduplicate overlapping walls between new and existing rooms
        try {
          const dedupRes = await callEdge('agent-bim', { action: 'deduplicate_walls', mcpSessionId: sessionId });
          sessionId = dedupRes.mcpSessionId;
        } catch { /* non-fatal */ }
      }

      // 3. Execute dynamic modifications / tool calls for specific element edits (windows, doors, roofs, balconies, material styles)
      if (plan.target_actions?.length || plan.edit_instructions?.length || !editRooms.length) {
        pushStep("BIM Agent: Executing dynamic element modifications...");
        const bimRes = await callEdge('agent-bim', {
          action: 'dynamic_edit',
          plan: plan,
          mcpSessionId: sessionId
        });
        sessionId = bimRes.mcpSessionId;
      }

      // 4. Update material finishes
      if (plan.material_palette) {
        pushStep("BIM Agent: Updating material finishes...");
        const matRes = await callEdge('agent-bim', { action: 'apply_materials', mcpSessionId: sessionId });
        if (matRes?.mcpSessionId) sessionId = matRes.mcpSessionId;
      }

      // 5. Update or Change roof during edits if requested
      let editRoofType = plan.roof_type;
      if (editRoofType === undefined || editRoofType === null) {
        const match = plan.special_elements?.find((e: string) => /roof|gable|hip|flat/i.test(e));
        if (match) {
          if (/no roof|without roof|remove roof|none/i.test(match)) {
            editRoofType = "none";
          } else if (/gable/i.test(match)) {
            editRoofType = "gable";
          } else if (/hip/i.test(match)) {
            editRoofType = "hip";
          } else if (/flat/i.test(match)) {
            editRoofType = "flat";
          }
        }
      }

      if (editRoofType && editRoofType !== "none") {
        pushStep(`BIM Agent: Re-creating roof as: ${editRoofType}...`);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxHeight = 3;
        // Bounding box over all rooms in edit storey plans or new rooms
        let allRooms = plan.new_rooms || [];
        if (plan.storey_plans) {
          allRooms = allRooms.concat(plan.storey_plans.flatMap((s: any) => s.rooms || []));
        }
        if (allRooms.length > 0) {
          for (const r of allRooms) {
            const [ox, oy] = r.origin || [0, 0, 0];
            const w = r.width || 4;
            const l = r.length || 4;
            minX = Math.min(minX, ox);
            minY = Math.min(minY, oy);
            maxX = Math.max(maxX, ox + w);
            maxY = Math.max(maxY, oy + l);
          }
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 8; maxY = 8; }

        const bimRes = await callEdge('agent-bim', {
          action: 'create_roof',
          roof_type: editRoofType,
          bbox: { minX, minY, maxX, maxY, height: maxHeight },
          mcpSessionId: sessionId
        });
        if (bimRes?.mcpSessionId) sessionId = bimRes.mcpSessionId;
      } else if (editRoofType === "none") {
        pushStep("BIM Agent: Deleting existing roofs as requested...");
        try {
          await callEdge('agent-bim', {
            action: 'dynamic_edit',
            plan: { target_actions: [{ action: "delete_roof" }] },
            mcpSessionId: sessionId
          });
        } catch { /* optional */ }
      }

      // 6. Export final edited IFC model
      pushStep("BIM Agent: Exporting updated model...");
      const exportRes = await callEdge('agent-bim', { action: 'export', mcpSessionId: sessionId });
      ifc_url = exportRes.ifc_url;
      sessionId = exportRes.mcpSessionId;
    }

    // 4. Quality Reviewer
    pushStep("Reviewer Agent: Validating model quality...");
    let review = await callEdge('agent-reviewer', { mcpSessionId: sessionId, qualityRequirements: plan.quality_requirements, structureCategory });
    const maxQualityPasses = 3;
    for (let qualityPass = 1; review.status !== 'PASS' && review.retry_required && qualityPass <= maxQualityPasses; qualityPass++) {
      pushStep(`Reviewer Agent: Applying quality corrections (${qualityPass}/${maxQualityPasses})...`);
      const remediation = await callEdge('agent-bim', {
        action: 'dynamic_edit',
        mcpSessionId: sessionId,
        plan: {
          ...plan,
          review_required: true,
          review_issues: review.issues || [],
          quality_pass: qualityPass,
          target_actions: (review.fix_recommendations || []).map((instruction: string) => ({ action: 'quality_remediation', target: 'model', parameters: { instruction } }))
        }
      });
      sessionId = remediation.mcpSessionId || sessionId;
      if (remediation.ifc_url) ifc_url = remediation.ifc_url;
      pushStep('Reviewer Agent: Re-validating corrected model...');
      review = await callEdge('agent-reviewer', { mcpSessionId: sessionId, qualityRequirements: plan.quality_requirements, structureCategory });
    }
    
    if (review.status === "PASS") {
      pushStep("✅ Model passed quality review.");
    } else {
      pushStep(`❌ Quality Review Issues: ${review.issues?.join(', ')}`);
    }

    finalReply = review.status === "PASS"
      ? "Multi-Agent Generation Complete. The final model is ready."
      : `Model generated, but it did not pass quality review: ${(review.issues || ["unknown issue"]).join("; ")}.`;
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
