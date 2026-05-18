import { CORS, mcpInit, mcpCallTool, fetchMcpTools, callQwen, callGLM } from "../_shared/shared.ts";

type McpCall = { resultText: string; session: string };

const MUTATION_TOOLS = new Set([
  "build_room",
  "build_wall_assembly",
  "build_floor_plan",
  "create_wall",
  "create_two_point_wall",
  "create_polyline_walls",
  "update_wall",
  "create_slab",
  "update_slab",
  "create_door",
  "update_door",
  "create_window",
  "update_window",
  "create_roof",
  "update_roof",
  "delete_roof",
  "create_stairs",
  "update_stairs",
  "delete_stairs",
  "create_trimesh_ifc",
  "create_mesh_ifc",
  "execute_ifc_code_tool",
  "create_surface_style",
  "create_pbr_style",
  "apply_style_to_object",
  "update_style",
  "remove_style",
]);

const CORE_EDIT_TOOLS = new Set([
  "export_ifc",
  "get_scene_info",
  "get_ifc_scene_overview",
  "get_object_info",
  "list_styles",
  "create_surface_style",
  "create_pbr_style",
  "apply_style_to_object",
  "update_style",
  "build_room",
  "build_wall_assembly",
  "build_floor_plan",
  "create_wall",
  "create_two_point_wall",
  "create_polyline_walls",
  "update_wall",
  "create_slab",
  "update_slab",
  "create_door",
  "update_door",
  "create_window",
  "update_window",
  "create_roof",
  "update_roof",
  "delete_roof",
  "create_stairs",
  "update_stairs",
  "delete_stairs",
  "create_trimesh_ifc",
  "create_mesh_ifc",
  "execute_ifc_code_tool",
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function literal(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function guidsByClass(scene: any): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const obj of scene?.objects || []) {
    if (!obj?.guid || !obj?.ifc_class) continue;
    const cls = String(obj.ifc_class);
    grouped[cls] = grouped[cls] || [];
    grouped[cls].push(String(obj.guid));
  }
  return grouped;
}

async function applyDefaultMaterials(mcpSessionId: string): Promise<{ session: string; summary: Record<string, number>; errors: string[] }> {
  let session = mcpSessionId;
  const errors: string[] = [];
  const summary: Record<string, number> = {};

  const sceneRes = await mcpCallTool("get_scene_info", { limit: -1, include_bbox: false, include_transform: false }, session);
  session = sceneRes.session;
  const scene = parseJson(sceneRes.resultText);
  const byClass = guidsByClass(scene);

  const styleRun = Date.now();
  const styles = [
    {
      name: `InfraStudio_Plaster_${styleRun}`,
      color: [0.86, 0.84, 0.78],
      transparency: 0,
      classes: ["IfcWall", "IfcWallStandardCase"],
    },
    {
      name: `InfraStudio_ConcreteFloor_${styleRun}`,
      color: [0.48, 0.48, 0.46],
      transparency: 0,
      classes: ["IfcSlab", "IfcRoof"],
    },
    {
      name: `InfraStudio_WoodDoor_${styleRun}`,
      color: [0.45, 0.28, 0.14],
      transparency: 0,
      classes: ["IfcDoor"],
    },
    {
      name: `InfraStudio_Glass_${styleRun}`,
      color: [0.62, 0.82, 0.92],
      transparency: 0.55,
      classes: ["IfcWindow"],
    },
    {
      name: `InfraStudio_StairConcrete_${styleRun}`,
      color: [0.58, 0.58, 0.56],
      transparency: 0,
      classes: ["IfcStair", "IfcStairFlight"],
    },
  ];

  for (const style of styles) {
    const targetGuids = style.classes.flatMap((cls) => byClass[cls] || []);
    summary[style.name] = targetGuids.length;
    if (targetGuids.length === 0) continue;

    try {
      const created = await mcpCallTool("create_surface_style", {
        name: style.name,
        color: style.color,
        transparency: style.transparency,
        style_type: "rendering",
      }, session);
      session = created.session;

      const applied = await mcpCallTool("apply_style_to_object", {
        object_guids: targetGuids,
        style_name: style.name,
      }, session);
      session = applied.session;
    } catch (err) {
      errors.push(`${style.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { session, summary, errors };
}

async function exportWithMaterials(mcpSessionId: string): Promise<{ ifc_url: string; mcpSessionId: string; materialResult: unknown; rawData: unknown }> {
  const materialResult = await applyDefaultMaterials(mcpSessionId);
  let session = materialResult.session;
  const exportRes = await mcpCallTool("export_ifc", {}, session);
  session = exportRes.session;
  const exportData = parseJson(exportRes.resultText) || {};
  return {
    ifc_url: exportData.file_url || exportData.ifc_url || "",
    mcpSessionId: session,
    materialResult,
    rawData: exportData,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const payload = await req.json();
    let mcpSessionId = payload.mcpSessionId;
    if (!mcpSessionId) mcpSessionId = await mcpInit("");

    if (payload.action === "initialize") {
      const res = await mcpCallTool("initialize_project", { project_name: payload.projectName || "InfraStudio AI Building" }, mcpSessionId);
      mcpSessionId = res.session;
      return jsonResponse({ status: "success", mcpSessionId });
    }

    if (payload.action === "create_storey") {
      const name = payload.name || "Storey";
      const elevation = Number(payload.elevation || 0);
      const code = `
import ifcopenshell.api as api
ifc_file = get_ifc_file()
buildings = ifc_file.by_type("IfcBuilding")
if buildings:
    building = buildings[0]
    storey = api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name=${literal(name)})
    api.run("geometry.edit_object_placement", ifc_file, product=storey, matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,${elevation},1]])
    api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])
    save_and_load_ifc()
`;
      const res = await mcpCallTool("execute_ifc_code_tool", { code }, mcpSessionId);
      mcpSessionId = res.session;
      return jsonResponse({ status: "success", mcpSessionId });
    }

    if (payload.action === "build_room") {
      const room = payload.room || {};
      const buildRes = await mcpCallTool("build_room", {
        room_name: room.name,
        width: room.width || 4,
        length: room.length || 4,
        height: payload.storeyHeight || room.height || 3,
        wall_thickness: room.wall_thickness || 0.2,
        origin: room.origin || [0, 0, 0],
        doors: room.doors || [],
        windows: room.windows || [],
      }, mcpSessionId);
      mcpSessionId = buildRes.session;
      return jsonResponse({ status: "success", result: buildRes, mcpSessionId });
    }

    if (payload.action === "apply_materials") {
      const materialResult = await applyDefaultMaterials(mcpSessionId);
      mcpSessionId = materialResult.session;
      return jsonResponse({ status: "success", materialResult, mcpSessionId });
    }

    if (payload.action === "dynamic_edit") {
      const plan = payload.plan;
      const toolFetch = await fetchMcpTools(mcpSessionId);
      mcpSessionId = toolFetch.session;
      const availableTools = toolFetch.tools;
      const availableByName = new Map(availableTools.map((tool: any) => [tool.function.name, tool]));

      const availableToolsList = availableTools
        .filter((tool: any) => !CORE_EDIT_TOOLS.has(tool.function.name))
        .map((tool: any) => `- ${tool.function.name}: ${tool.function.description}`)
        .join("\n");
      const qwenPrompt = `You are a Tool Retrieval Intelligence Layer. Extract extra tool names needed for this BIM edit plan. Plan: ${JSON.stringify(plan)} Available Tools: ${availableToolsList} RULES: Return ONLY a comma-separated list of tool names. If none, reply NONE.`;
      const extractedRaw = await callQwen(qwenPrompt, "Extract tools", false).catch(() => "NONE");

      const needed = new Set<string>(CORE_EDIT_TOOLS);
      if (extractedRaw && extractedRaw.trim() !== "NONE") {
        extractedRaw.split(",").map((s) => s.trim()).forEach((name) => {
          if (name) needed.add(name);
        });
      }
      const routedTools = [...needed].map((name) => availableByName.get(name)).filter(Boolean);

      const sceneRes = await mcpCallTool("get_scene_info", {
        limit: -1,
        include_bbox: true,
        include_transform: true,
        round_decimals: 3,
      }, mcpSessionId);
      mcpSessionId = sceneRes.session;

      const overviewRes = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId).catch(() => null as unknown as McpCall | null);
      if (overviewRes) mcpSessionId = overviewRes.session;

      const glmPrompt = `You are the BIM Executor for an existing IFC model.
You must perform real model mutations with the provided tools, then the system will export the IFC.
Rules:
1. Use exact GlobalId values from Current IFC Scene State. Never invent GUIDs.
2. For edits, call at least one mutation tool before export: update_*, create_*, delete_*, build_*, apply_style_to_object, update_style, or execute_ifc_code_tool.
3. If the user asks for material changes, create a style if needed and apply it to concrete target GUIDs.
4. If adding new rooms/elements, place them so they do not overlap existing bounding boxes.
5. If adding or moving doors/windows, keep openings on valid walls, away from corners, and do not overlap other openings.
6. Output only tool calls. No prose.`;

      const basePlanData = `Instructions: ${JSON.stringify(plan)}

Current IFC Scene State:
${sceneRes.resultText}

IFC Overview:
${overviewRes?.resultText || "Unavailable"}`;

      let ifc_url = "";
      let executionError = "";
      let executedMutation = false;
      const executedTools: string[] = [];

      for (let tryNum = 1; tryNum <= 3; tryNum++) {
        let currentPlanData = basePlanData;
        if (executionError) {
          currentPlanData += `\n\nPREVIOUS EXECUTION FAILED:\n${executionError}\nRetry with concrete mutation tool calls.`;
          executionError = "";
        }

        const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools);
        const toolCalls = glmMsg.tool_calls || [];
        if (toolCalls.length === 0) {
          executionError = "No tool calls were produced.";
          if (tryNum === 3) throw new Error(executionError);
          continue;
        }

        try {
          for (const call of toolCalls) {
            const toolName = call.function.name;
            const args = JSON.parse(call.function.arguments || "{}");
            const toolRes = await mcpCallTool(toolName, args, mcpSessionId);
            mcpSessionId = toolRes.session;
            executedTools.push(toolName);

            if (MUTATION_TOOLS.has(toolName) && toolName !== "export_ifc") {
              executedMutation = true;
            }
          }

          if (!executedMutation) {
            throw new Error("The model was not edited because no mutation tool was executed.");
          }
          break;
        } catch (err) {
          executionError = err instanceof Error ? err.message : String(err);
          if (tryNum === 3) throw err;
        }
      }

      const exported = await exportWithMaterials(mcpSessionId);
      ifc_url = exported.ifc_url;
      mcpSessionId = exported.mcpSessionId;

      return jsonResponse({
        status: "success",
        ifc_url,
        mcpSessionId,
        executedTools,
        materialResult: exported.materialResult,
      });
    }

    if (payload.action === "export") {
      const exported = await exportWithMaterials(mcpSessionId);
      return jsonResponse({ status: "success", ...exported });
    }

    return jsonResponse({ error: "Invalid action" }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
