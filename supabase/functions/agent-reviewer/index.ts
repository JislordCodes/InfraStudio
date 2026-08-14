
import { CORS, callQwen, cleanJsonResponse, mcpInit, mcpCallTool } from "../_shared/shared.ts";

const systemPrompt = `You are the Quality Review Agent for InfraStudio.
Your role is to inspect the generated IFC model state, validate semantic topologies, and act as the final quality gatekeeper.

Validation Criteria:
 1. Standard BIM Topology: Ensure key structural elements exist (IfcWall > 0, IfcSlab > 0, IfcDoor > 0, IfcWindow > 0).
 2. Requirements are supplied with every review. Mark FAIL if the scene does not prove it meets every minimum count or required IFC class. A single proxy, cube, or disconnected element is NEVER a valid building, bridge, or railway model.
 3. For buildings, check that the requested number of rooms/storeys is represented by meaningful walls, slabs, doors and windows. For infrastructure, check that supports and primary members form a connected structure—not merely one deck or box.
 4. Do NOT fail a model solely because IfcSpace entities are absent: the current room builder produces physical IFC elements, not IfcSpace. Do not compare the project name to a category; assess actual model elements instead.

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
  const reviewContext = {
    structure_category: payload.structureCategory || "building",
    quality_requirements: payload.qualityRequirements || {},
    scene_overview: sceneInfo.resultText
  };
  const res = await callQwen(systemPrompt, JSON.stringify(reviewContext), true, "qwen3.8-max");
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

