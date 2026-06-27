
import { CORS, callQwen, cleanJsonResponse, mcpInit, mcpCallTool } from "../_shared/shared.ts";

const systemPrompt = `You are the Quality Review Agent.
Inspect the generated IFC model overview and element counts.
Ensure the building contains expected structural elements (IfcWall, IfcSlab, IfcDoor, IfcWindow).
If the counts are missing or absurdly low (e.g. 0 walls), return FAIL.
Expected JSON Output:
{
  "status": "PASS" | "FAIL",
  "issues": ["string"],
  "fix_recommendations": ["string"],
  "retry_required": boolean
}`;

export async function handleReviewer(payload: any): Promise<any> {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");
  const sceneInfo = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId);
  const res = await callQwen(systemPrompt, JSON.stringify(sceneInfo.resultText), true, "qwen3.7-max-2026-06-08");
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

