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
  "confidence_score": number
}`;

export async function handleInterpreter(payload: any): Promise<any> {
  const messages = payload.messages || [];
  const hasHistory = messages.length > 1 || Boolean(payload.sessionId);

  let formattedPrompt: any = messages;
  if (hasHistory) {
    const historyText = Array.isArray(messages)
      ? messages.map((m: any) => `${(m.role || "user").toUpperCase()}: ${m.content || ""}`).join("\n")
      : String(messages);
    formattedPrompt = `ACTIVE_SESSION_EXISTS: ${hasHistory}.\nFull Conversation History:\n${historyText}\n\nTask: Parse the LATEST user message in context of conversation history. If the user wants to add to, modify, paint, adjust, or edit the existing model, set "is_edit": true.`;
  }

  const res = await callQwen(systemPrompt, formattedPrompt, true, "qwen3.7-max-2026-05-20");
  const result = cleanJsonResponse(res);

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
