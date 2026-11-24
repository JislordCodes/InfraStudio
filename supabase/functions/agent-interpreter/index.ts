import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";
import { classifyIntent, QUESTION_SYSTEM_PROMPT } from "../_shared/intent.ts";
import { runAgyOneShot } from "../_shared/antigravity_agent.ts";

const systemPrompt = `You are the Interpreter Agent for InfraStudio.
Your sole responsibility is to convert natural-language user intent into a complete, machine-readable design brief.

Core Directives:
 0. INTENT (CRITICAL): Set "intent" to "question" when the latest user message only asks something (what, why, how, is it, how many, explain, describe) and does not ask for the model to be built or changed. Set "intent" to "action" for any request to build, add, change, move, remove, resize or paint. "Can you add a door?" is an action. "How tall is the roof?" is a question. When unsure, use "action".
 1. STRUCTURE CATEGORY (CRITICAL): Classify the user request into ONE of these categories:
    - "infrastructure" — structural frames, column grids, beam/column networks, pad bases, footings, foundations, bridges, tunnels, dams, retaining walls, towers, monuments, roads, railways, piers, jetties
    - "building" — houses, apartments, offices, warehouses, factories, any structure with rooms/storeys
    - "mep" — pipes, ducts, cable trays, HVAC systems, plumbing networks, electrical conduits
    - "custom" — furniture, sculptures, art installations, mechanical parts, free-form geometry, anything else
  2. EDIT vs NEW (CRITICAL DIRECTIVE FOR ITERATIVE EDITING):
    - If ACTIVE_SESSION_EXISTS is true or history contains previous turns:
      Default "is_edit": true whenever the user is asking to add, modify, alter, paint, expand, adjust, or edit the existing structure.
      ONLY set "is_edit": false if the user explicitly requests to "create a new building/frame from scratch", "start over", "clear all", or "replace this model".
    - If an assistant previously asked a clarifying question and the latest user message supplies rooms, dimensions, materials, or features, it is the continuation of a NEW design. Set "is_edit": false.
 3. FOR BUILDINGS: Extract rooms, storeys, special features, materials, and edit instructions.
 4. FOR NON-BUILDINGS / STRUCTURAL FRAMES: Extract component_requirements — a list of named structural components (columns, beams, pad bases, slabs) with descriptions, grid spacing, dimensions, and positions.

Strict Restrictions:
 * You MUST NOT generate geometry or invoke BIM/MCP tools.
 * Return ONLY raw JSON matching the exact schema below.

Expected JSON Schema:
{
  "intent": "action" | "question",
  "is_edit": boolean,
  "edit_instructions": ["string"],
  "structure_category": "building" | "infrastructure" | "mep" | "custom",
  "project_type": "string",
  "storeys": [{"name": "string", "elevation": number, "height": number}],
  "room_requirements": [{"name": "string", "suggested_area": number}],
  "component_requirements": [{"name": "string", "type": "string", "description": "string"}],
  "special_features": ["string"],
  "material_requirements": ["string"],
  "style_preferences": ["string"],
  "constraints": ["string"],
  "needs_clarification": boolean,
  "clarifying_question": "string",
  "confidence_score": number
}`;

function designSeedFrom(text: string, sessionId = ""): number {
  const source = `${text}|${sessionId}|${Date.now()}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

async function answerQuestion(messages: any[], latestText: string, modelContext = ""): Promise<any> {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m: any) => m?.role === "user" || m?.role === "assistant")
    .slice(-12)
    .map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 4000) }));
  let answer = "";
  // The production box answers through the build agent's one-shot channel
  // (about 13 s, no tools). The direct model call is the fallback.
  try {
    const transcript = history.map((m: any) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`).join("\n");
    const raw = await runAgyOneShot(
      `${QUESTION_SYSTEM_PROMPT}${modelContext ? `\n\nMODEL DATA (measured from the user's open model, treat as true):\n${modelContext}` : ""}\n\nDo NOT use any tools and do NOT create or edit any files. Reply with the answer text only.\n\nConversation so far:\n${transcript}\n\nAnswer the last USER message.`,
      75000,
    );
    answer = String(raw || "").trim();
  } catch (err) {
    console.warn("[handleInterpreter] one-shot question answer failed:", err);
    try {
      answer = (await callQwen(QUESTION_SYSTEM_PROMPT, history, false, "glm-5.3", 60000, "high", 1200)).trim();
    } catch (err2) {
      console.warn("[handleInterpreter] question answer failed:", err2);
    }
  }
  if (!answer) {
    answer = "I read that as a question, so I did not change the model. For counts, sizes and costs, use Ask in the Studio dock under the viewer. To change something, tell me what to change.";
  }
  return {
    intent: "question",
    answer,
    is_edit: false,
    needs_clarification: false,
    client_requirements: latestText,
    prompt: latestText,
  };
}

export async function handleInterpreter(payload: any): Promise<any> {
  const rawMessages = payload.messages || (payload.prompt ? [{ role: "user", content: String(payload.prompt) }] : (payload.text ? [{ role: "user", content: String(payload.text) }] : []));
  const messages = Array.isArray(rawMessages) && rawMessages.length > 0
    ? rawMessages
    : [{ role: "user", content: typeof payload === "string" ? payload : "Create a structure" }];
  // A transport/MCP session ID exists before the first model is created.  It
  // must not be mistaken for design history, otherwise every fresh request is
  // routed as an edit and the new-building pipeline is skipped.
  const hasHistory = Array.isArray(messages)
    ? messages.slice(0, -1).some((message: any) => message?.role === "user" || message?.role === "assistant")
    : false;

  let formattedPrompt: any = messages;
  if (hasHistory) {
    const historyText = Array.isArray(messages)
      ? messages.map((m: any) => `${(m.role || "user").toUpperCase()}: ${m.content || ""}`).join("\n")
      : String(messages);
    formattedPrompt = `ACTIVE_SESSION_EXISTS: ${hasHistory}.\nFull Conversation History:\n${historyText}\n\nTask: Parse the LATEST user message in context of conversation history. If the user wants to add to, modify, paint, adjust, or edit the existing model, set "is_edit": true.`;
  }

  let result: any = null;
  const latestText = (Array.isArray(messages) ? messages[messages.length - 1]?.content : String(messages)) || "";

  // A question is answered in chat. It must never reach the architect or the
  // build, which would start a build and change the user's model.
  const heuristicIntent = classifyIntent(String(latestText));
  if (payload.forceQuestion === true || heuristicIntent === "question") {
    return await answerQuestion(messages, String(latestText), String(payload.modelContext || "").slice(0, 9000));
  }

  // When OpenHands owns the actual build (a real coding agent doing its own
  // interpretation, planning, and construction), this model-based
  // classification pass is redundant work that only adds latency and burns
  // quota - skip straight to the same deterministic heuristic parser this
  // file already falls back to on a real LLM failure. is_edit/category still
  // need to be roughly right here (they gate which pipeline path runs
  // downstream), but the actual design work no longer happens in this file.
  const useOpenHands = (typeof Deno !== "undefined" ? Deno.env.get("USE_OPENHANDS_ENGINE") : process.env.USE_OPENHANDS_ENGINE) === "true";

  try {
    if (useOpenHands) throw new Error("skip-llm-openhands-mode");
    const res = await callQwen(systemPrompt, formattedPrompt, true, "glm-5.3");
    result = cleanJsonResponse(res);
  } catch (err) {
    if (!useOpenHands) console.warn("[handleInterpreter] LLM unavailable, using deterministic brief parser:", err);
    const textLower = String(latestText).toLowerCase();
    const isInfra = /cofferdam|coffer|bridge|rail|road|pier|jetty|dam|tunnel/i.test(textLower);
    const projType = isInfra
      ? (/cofferdam|coffer/i.test(textLower) ? "Bridge Pier Cofferdam" : (/bridge/i.test(textLower) ? "Bridge" : "Infrastructure Structure"))
      : (/apartment/i.test(textLower) ? "Apartment Building" : "Modern House");

    result = {
      is_edit: false,
      edit_instructions: [],
      structure_category: isInfra ? "infrastructure" : "building",
      project_type: projType,
      storeys: [{ name: "Ground Floor", elevation: 0, height: 3.2 }],
      room_requirements: isInfra ? [] : [
        { name: "Living Room", suggested_area: 25 },
        { name: "Kitchen", suggested_area: 15 },
        { name: "Bedroom", suggested_area: 18 },
        { name: "Bathroom", suggested_area: 8 }
      ],
      component_requirements: [],
      special_features: [],
      material_requirements: [],
      style_preferences: [],
      constraints: [],
      needs_clarification: false,
      confidence_score: 0.95
    };
  }

  if (result?.intent === "question" && heuristicIntent !== "action") {
    return await answerQuestion(messages, String(latestText), String(payload.modelContext || "").slice(0, 9000));
  }

  const priorAssistantText = Array.isArray(messages)
    ? messages.slice(0, -1).filter((message: any) => message?.role === "assistant").map((message: any) => String(message.content || "")).join(" ").toLowerCase()
    : "";
  const followsClarification = /could you provide more details|please describe|what should i design|clarifying|layout.*additional rooms/i.test(priorAssistantText);
  const startsNewDesign = /\b(create|build|design|make)\b.*\b(apartment|house|building|bridge|railway|road|station|office|warehouse)\b/i.test(String(latestText));
  if (followsClarification || startsNewDesign) {
    result.is_edit = false;
    result.needs_clarification = false;
  }

  // Default structure_category to "building" if not set
  if (!result.structure_category) {
    result.structure_category = "building";
  }

  // Force is_edit: true if session/history exists and user isn't asking to clear/reset
  if (hasHistory && result.is_edit === undefined) {
    const lastUserMsg = (Array.isArray(messages) ? messages[messages.length - 1]?.content : String(messages)) || "";
    if (!/new building|new project|start over|clear|reset/i.test(lastUserMsg)) {
      result.is_edit = true;
    }
  }

  // For an intentionally open-ended request, generate a complete but varied
  // architect-designed house instead of either asking a redundant question or
  // producing an arbitrary cube. Explicit programmes always take precedence.
  const normalized = String(latestText).toLowerCase().replace(/\s+/g, " ").trim();
  const isVagueNewBuild = !hasHistory && /^(?:please )?(?:build|create|make|design)(?: me)? (?:something|a building|a model|anything)[.!? ]*$/.test(normalized);
  if (isVagueNewBuild) {
    result.is_edit = false;
    result.structure_category = "building";
    result.project_type = "architect-designed house";
    result.autonomous_design = true;
    result.needs_clarification = false;
    result.room_requirements = [];
    result.special_features = result.special_features || ["varied footprint", "daylight", "entry sequence"];
  }

  // An explicit project type such as "two-bed apartment" is already enough
  // to generate a useful baseline; never let an LLM ask a redundant question.
  if (/\b(apartment|house|building|bridge|railway|road|station|office|warehouse)\b/i.test(String(latestText))) {
    result.needs_clarification = false;
  }

  if (!result.is_edit && !result.design_seed) {
    result.design_seed = designSeedFrom(String(latestText), String(payload.sessionId || ""));
  }

  result.client_requirements = result.client_requirements || latestText;
  result.prompt = result.prompt || latestText;

  return result;
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleInterpreter(payload);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
}
