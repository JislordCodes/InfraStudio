
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

function parseScene(text: string): any {
  try { return JSON.parse(text); } catch { return {}; }
}

function boundsOf(object: any): { min: number[]; max: number[] } | null {
  const bbox = object?.bbox || object?.bounding_box || object?.bounds;
  if (Array.isArray(bbox) && bbox.length >= 6) return { min: bbox.slice(0, 3).map(Number), max: bbox.slice(3, 6).map(Number) };
  if (bbox?.min && bbox?.max) return { min: bbox.min.map(Number), max: bbox.max.map(Number) };
  return null;
}

function deterministicReview(scene: any, requirements: any, category: string) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const classes = objects.reduce((counts: Record<string, number>, object: any) => {
    const name = String(object?.ifc_class || object?.type || "");
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
  const issues: string[] = [];
  const fixes: string[] = [];
  const required = requirements?.required_element_types || (category === "building" ? ["IfcWall", "IfcSlab", "IfcDoor", "IfcWindow"] : []);
  for (const requiredClass of required) {
    if (!classes[requiredClass]) {
      issues.push(`Missing required ${requiredClass} elements.`);
      fixes.push(`Create semantic ${requiredClass} elements using the appropriate MCP tool.`);
    }
  }
  if (category === "building" && Number(requirements?.minimum_rooms || 0) > 0 && (classes.IfcWall || 0) < Math.max(4, Number(requirements.minimum_rooms))) {
    issues.push("The wall count is too low for the requested room programme.");
    fixes.push("Add the missing walls using InfraStudioHarness.");
  }

  const solids = objects.filter((object: any) => {
    const cls = String(object?.ifc_class || object?.type || "");
    return !/IfcDoor|IfcWindow|IfcOpeningElement|IfcRailing/.test(cls) && boundsOf(object);
  });
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = boundsOf(solids[i])!, b = boundsOf(solids[j])!;
      const overlap = [0, 1, 2].map((axis) => Math.max(0, Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis])));
      const overlapVolume = overlap[0] * overlap[1] * overlap[2];
      const aVolume = (a.max[0] - a.min[0]) * (a.max[1] - a.min[1]) * (a.max[2] - a.min[2]);
      const bVolume = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
      if (overlapVolume > 0.1 && overlapVolume / Math.max(0.001, Math.min(aVolume, bVolume)) > 0.35) {
        issues.push(`Geometry clash detected between ${solids[i].name || solids[i].guid || "element"} and ${solids[j].name || solids[j].guid || "element"}.`);
        fixes.push("Use the recorded GlobalIds and adjust or remove the overlapping element before export.");
      }
    }
  }
  return { issues: [...new Set(issues)], fixes: [...new Set(fixes)], classes };
}

export async function handleReviewer(payload: any): Promise<any> {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");
  const sceneInfo = await mcpCallTool("get_scene_info", { limit: -1, include_bbox: true, include_transform: true }, mcpSessionId);
  const scene = parseScene(sceneInfo.resultText);
  const category = payload.structureCategory || payload.plan?.structure_category || payload.brief?.structure_category || "building";
  const qualityReqs = payload.qualityRequirements || payload.plan?.quality_requirements || payload.brief?.quality_requirements || {};
  const deterministic = deterministicReview(scene, qualityReqs, category);
  const reviewContext = {
    structure_category: category,
    quality_requirements: qualityReqs,
    scene_overview: sceneInfo.resultText,
    deterministic_findings: deterministic
  };
  let result: any = null;
  try {
    const res = await callQwen(systemPrompt, JSON.stringify(reviewContext), true, payload.model || "gpt-6-astra");
    result = cleanJsonResponse(res);
  } catch (err) {
    console.warn("[handleReviewer] LLM unavailable, using deterministic review results:", err);
    result = {
      status: deterministic.issues.length ? "FAIL" : "PASS",
      issues: deterministic.issues,
      severity_levels: deterministic.issues.map(() => "warning"),
      entity_ids_flagged: [],
      fix_recommendations: deterministic.fixes,
      retry_required: deterministic.issues.length > 0
    };
  }

  result.issues = [...new Set([...(deterministic.issues || []), ...(result.issues || [])])];
  result.fix_recommendations = [...new Set([...(deterministic.fixes || []), ...(result.fix_recommendations || [])])];
  if (deterministic.issues.length) {
    result.status = "FAIL";
    result.retry_required = true;
  } else {
    result.status = "PASS";
    result.retry_required = false;
    result.issues = [];
    result.fix_recommendations = [];
  }
  result.element_counts = deterministic.classes;
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
