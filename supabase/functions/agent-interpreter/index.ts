import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Interpreter Agent for InfraStudio.
Your sole responsibility is to convert natural-language user intent into a complete, machine-readable design brief.

Core Directives:
 1. STRUCTURE CATEGORY (CRITICAL): Classify the user request into ONE of these categories:
    - "building" — houses, apartments, offices, warehouses, factories, any structure with rooms/storeys
    - "infrastructure" — bridges, tunnels, dams, retaining walls, towers, monuments, roads, railways, piers, jetties
    - "mep" — pipes, ducts, cable trays, HVAC systems, plumbing networks, electrical conduits
    - "custom" — furniture, sculptures, art installations, mechanical parts, free-form geometry, anything else
 2. EDIT vs NEW: Determine if the user is asking to EDIT/MODIFY an existing model, or create something completely NEW. If modifying, set "is_edit": true.
 3. FOR BUILDINGS: Extract rooms, storeys, special features, materials (existing behavior).
 4. FOR NON-BUILDINGS: Extract component_requirements — a list of named structural components with descriptions, approximate dimensions, and positions.

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
  "confidence_score": number
}`;

export async function handleInterpreter(payload: any): Promise<any> {
  const messages = payload.messages || [];
  let userPrompt = messages;
  if (payload.sessionId) {
    userPrompt = [...messages, { role: "system", content: `ACTIVE_MODEL_SESSION_EXISTS: session_id=${payload.sessionId}. Determine if current user message is an edit or addition.` }];
  }
  const res = await callQwen(systemPrompt, userPrompt, true, "qwen3.7-max-2026-05-20");
  const result = cleanJsonResponse(res);
  // Default structure_category to "building" if not set
  if (!result.structure_category) {
    result.structure_category = "building";
  }
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
