import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Interpreter Agent for InfraStudio.
Your sole responsibility is to convert natural-language user intent into a complete, machine-readable design brief.

Core Directives:
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

  try {
    const res = await callQwen(systemPrompt, formattedPrompt, true, payload?.model || "qwen-max");
    result = cleanJsonResponse(res);
  } catch (err) {
    console.warn("[handleInterpreter] LLM unavailable, using deterministic brief parser:", err);
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
