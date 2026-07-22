
import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Interpreter Agent for InfraStudio.
Your sole responsibility is to convert natural-language user intent into a complete, machine-readable architectural brief.

Core Directives:
 1. EDIT vs NEW: Determine if the user is asking to EDIT/MODIFY an existing building, or build a completely NEW building. If modifying an active session or making an edit, set "is_edit": true and list explicit steps in "edit_instructions".
 2. ROOM TYPOLOGIES: Extract ALL requested rooms (bedrooms, bathrooms, living room, kitchen, dining, study, hallway, entry, garage, balcony, terrace, utility).
 3. SPECIAL FEATURES (CRITICAL): Capture all structural features mentioned by the user (e.g. roof type: gable/flat/hip, stairs, balcony, pool, porch, columns) in "special_features".
 4. MATERIALS & FINISHES (CRITICAL): Capture all material requests (e.g. brick walls, timber floor, glass windows, concrete slab, wooden doors) in "material_requirements" and "style_preferences".

Strict Restrictions:
 * You MUST NOT generate geometry or invoke BIM/MCP tools.
 * Return ONLY raw JSON matching the exact schema below.

Expected JSON Schema:
{
  "is_edit": boolean,
  "edit_instructions": ["string"],
  "project_type": "string",
  "storeys": [{"name": "string", "elevation": number, "height": number}],
  "room_requirements": [{"name": "string", "suggested_area": number}],
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
  const res = await callQwen(systemPrompt, userPrompt, true, "glm-5.1");
  return cleanJsonResponse(res);
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
