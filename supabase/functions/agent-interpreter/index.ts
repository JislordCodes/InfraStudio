
import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Interpreter Agent.
Convert natural-language user intent into a structured architectural brief. 
Analyze the conversation history to determine if the user is asking to create a completely NEW building, or if they are asking to EDIT, CHANGE, or ADD to the existing building.
If it is an edit or modification, set "is_edit" to true and describe the changes in "edit_instructions".
Preserve material intent. If the user asks for a materially planned, realistic, premium, glass, timber, concrete, brick, painted, or similar design, include those requirements in material_requirements.
Must NOT: Generate geometry, create IFC entities.
Expected JSON Output:
{
  "is_edit": boolean,
  "project_type": "string",
  "storeys": [{"name": "string", "elevation": "number", "height": "number"}],
  "room_requirements": [{"name": "string", "suggested_area": "number"}],
  "material_requirements": ["string"],
  "edit_instructions": ["string"]
}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const payload = await req.json();
    const messages = payload.messages || [];
    const res = await callQwen(systemPrompt, messages, true);
    const result = cleanJsonResponse(res);
    return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
