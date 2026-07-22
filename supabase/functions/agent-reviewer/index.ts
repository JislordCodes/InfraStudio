
import { CORS, callQwen, cleanJsonResponse, mcpInit, mcpCallTool } from "../_shared/shared.ts";

const systemPrompt = `You are the Quality Review Agent for InfraStudio.
Your role is to inspect the generated IFC model state, validate semantic topologies, and act as the gatekeeper before the final model is served to the user.

Validation Checks:
 1. Syntax & Element Counts: Ensure standard structural elements exist (IfcWall, IfcSlab, IfcDoor, IfcWindow). If walls exist but no doors or slabs exist, mark as FAIL.
 2. Topological Integrity: Verify that every room is enclosed, every door provides access, and windows are placed on exterior walls.
 3. Voids & Openings: Verify that doors and windows cut proper void openings in host walls rather than clashing inside solid geometry.
 4. Material & Style Integrity: Verify that surface styles/materials are attached to key structural elements.

Correction Loop Enforcement:
If you detect an error, you MUST set "status": "FAIL" and "retry_required": true. You MUST provide explicit, step-by-step instructions in "fix_recommendations" detailing which entity GUID or room is failing and exactly what the BIM MCP Agent needs to do to resolve it (e.g. "Delete IfcWall [GUID] and recreate with create_door wall_guid=[GUID] create_opening=true").

Expected JSON Schema:
{
  "status": "PASS" | "FAIL",
  "issues": ["string"],
  "severity_levels": ["string"],
  "entity_ids_flagged": ["string"],
  "fix_recommendations": ["string"],
  "retry_required": boolean
}`;

export async function handleReviewer(payload: any): Promise<any> {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");
  const sceneInfo = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId);
  const res = await callQwen(systemPrompt, JSON.stringify(sceneInfo.resultText), true, "qwen-plus");
  const result = cleanJsonResponse(res);
  result.mcpSessionId = mcpSessionId;
  return result;
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleReviewer(payload);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
}

