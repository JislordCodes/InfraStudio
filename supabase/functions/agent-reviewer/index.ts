
import { CORS, callQwen, cleanJsonResponse, mcpInit, mcpCallTool } from "../_shared/shared.ts";

const systemPrompt = `You are the Quality Review Agent for InfraStudio.
Your role is to inspect the generated IFC model state, validate semantic topologies, and act as the final quality gatekeeper.

Validation Criteria:
 1. Standard BIM Topology: Ensure key structural elements exist (IfcWall > 0, IfcSlab > 0, IfcDoor > 0, IfcWindow > 0). If all key element types exist and building geometry is generated, mark "status": "PASS".
 2. Failure Threshold: Mark "status": "FAIL" ONLY if critical structural components are completely missing (e.g. walls exist but zero doors or zero slabs were built) or geometry is severely malformed.

Correction Loop Enforcement:
If you detect a critical failure, set "status": "FAIL" and "retry_required": true with step-by-step fix recommendations.
Otherwise, set "status": "PASS" and "retry_required": false.

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
  const res = await callQwen(systemPrompt, JSON.stringify(sceneInfo.resultText), true, "qwen3.7-plus");
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

