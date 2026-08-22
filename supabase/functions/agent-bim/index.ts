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
  "execute_blender_code",
  "fill_opening",
  "create_surface_style",
  "create_pbr_style",
  "apply_style_to_object",
  "update_style",
  "remove_style",
  "create_polyline_slab",
  "create_circular_slab",
  "create_opening",
  "build_building",
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

type ToolAuditEntry = {
  tool: string;
  allowed: boolean;
  reason: string;
  semantic_alternative?: string;
};

const SEMANTIC_TOOL_OPTIONS: Record<string, string[]> = {
  wall: ["build_room", "build_wall_assembly", "create_wall", "create_two_point_wall", "create_polyline_walls"],
  slab: ["create_slab", "create_polyline_slab", "create_circular_slab"],
  door: ["create_door"],
  window: ["create_window"],
  roof: ["create_roof"],
  stair: ["create_stairs"],
};

const GENERIC_GEOMETRY_TOOLS = new Set(["create_trimesh_ifc", "create_mesh_ifc"]);

function recordToolDecision(decision: ToolAuditEntry): ToolAuditEntry {
  console.info("[tool-selection-gate]", JSON.stringify(decision));
  return decision;
}

function semanticIntent(args: Record<string, any>, context: unknown = ""): string | undefined {
  const directText = [args?.name, args?.ifc_class, args?.description]
    .filter(Boolean).join(" ").toLowerCase();
  // Call arguments win over a broad project brief. This keeps a furniture
  // request from being blocked merely because the same edit also mentions a wall.
  const text = directText || String(context || "").toLowerCase();
  if (/\bwall\b/.test(text)) return "wall";
  if (/\b(slab|floor|deck)\b/.test(text)) return "slab";
  if (/\bdoor\b/.test(text)) return "door";
  if (/\bwindow\b/.test(text)) return "window";
  if (/\broof\b/.test(text)) return "roof";
  if (/\b(stair|staircase|steps)\b/.test(text)) return "stair";
  return undefined;
}

function evaluateToolSelection(tool: string, args: Record<string, any>, availableTools: any[], context: unknown = ""): ToolAuditEntry {
  const available = new Set(availableTools.map((item: any) => item?.function?.name || item?.name).filter(Boolean));
  if (available.size > 0 && !available.has(tool)) {
    return recordToolDecision({ tool, allowed: false, reason: "The tool was not advertised by the active MCP session." });
  }

  const intent = semanticIntent(args, context);
  const semanticAlternative = intent ? SEMANTIC_TOOL_OPTIONS[intent]?.find((candidate) => available.has(candidate)) : undefined;
  const requestedClass = String(args?.ifc_class || "");
  const isGenericProxy = !requestedClass || requestedClass === "IfcBuildingElementProxy";

  if (GENERIC_GEOMETRY_TOOLS.has(tool) && isGenericProxy && semanticAlternative) {
    return recordToolDecision({
      tool,
      allowed: false,
      reason: `Generic mesh/proxy creation is not permitted for a ${intent} while a semantic IFC tool is available.`,
      semantic_alternative: semanticAlternative,
    });
  }

  return recordToolDecision({
    tool,
    allowed: true,
    reason: semanticAlternative && GENERIC_GEOMETRY_TOOLS.has(tool)
      ? `Allowed because the request explicitly supplies semantic IFC class ${requestedClass}.`
      : "Tool is compatible with the requested BIM intent.",
    semantic_alternative: semanticAlternative,
  });
}

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
  let materialResult: any = null;
  let session = mcpSessionId;
  try {
    materialResult = await applyDefaultMaterials(session);
    session = materialResult.session;
  } catch (mErr) {
    console.warn("[exportWithMaterials] Non-fatal material styling error:", mErr);
  }
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

export async function handleBim(payload: any): Promise<any> {
  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");

  if (payload.action === "initialize") {
    const res = await mcpCallTool("initialize_project", { project_name: payload.projectName || "InfraStudio AI Building" }, mcpSessionId);
    mcpSessionId = res.session;
    return { status: "success", mcpSessionId };
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
    return { status: "success", mcpSessionId };
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
      floor_slab: room.floor_slab !== undefined ? Boolean(room.floor_slab) : true,
      ceiling_slab: room.ceiling_slab !== undefined ? Boolean(room.ceiling_slab) : true,
      doors: room.doors || [],
      windows: room.windows || [],
    }, mcpSessionId);
    mcpSessionId = buildRes.session;
    return { status: "success", result: buildRes, mcpSessionId };
  }

  if (payload.action === "deduplicate_walls") {
    const dedupeCode = `
import bpy
import mathutils
import json
import ifcopenshell
import ifcopenshell.api as api

ifc_file = None
try:
    import tool
    ifc_file = tool.Ifc.get()
except:
    try:
        import blenderbim.tool as tool
        ifc_file = tool.Ifc.get()
    except:
        ifc_file = None

def get_wall_bbox(obj):
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

walls = [o for o in bpy.data.objects if o.type == 'MESH' and 'Wall' in o.name]
to_remove = []

for i in range(len(walls)):
    if walls[i] in to_remove:
        continue
    for j in range(i+1, len(walls)):
        if walls[j] in to_remove:
            continue
        a = get_wall_bbox(walls[i])
        b = get_wall_bbox(walls[j])
        
        ox = max(0, min(a[3], b[3]) - max(a[0], b[0]))
        oy = max(0, min(a[4], b[4]) - max(a[1], b[1]))
        oz = max(0, min(a[5], b[5]) - max(a[2], b[2]))
        overlap_vol = ox * oy * oz
        
        vol_a = (a[3]-a[0]) * (a[4]-a[1]) * (a[5]-a[2])
        vol_b = (b[3]-b[0]) * (b[4]-b[1]) * (b[5]-b[2])
        min_vol = min(vol_a, vol_b)
        
        if min_vol > 0 and overlap_vol / min_vol > 0.5:
            to_remove.append(walls[j])

removed_names = []
for obj in to_remove:
    removed_names.append(obj.name)
    element = None
    if tool:
        try: element = tool.Ifc.get_entity(obj)
        except: pass

    if element and ifc_file:
        try:
            api.run('root.remove_product', ifc_file, product=element)
        except Exception as e:
            try: ifc_file.remove(element)
            except: pass

    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh and mesh.users == 0:
        bpy.data.meshes.remove(mesh)

if removed_names:
    try:
        if tool and hasattr(tool.Ifc, 'save'):
            tool.Ifc.save()
    except Exception as e:
        print("save warning:", str(e))

print("DEDUP_RESULT:" + json.dumps({"removed": removed_names, "count": len(removed_names)}))
`;
    const res = await mcpCallTool("execute_blender_code", { code: dedupeCode }, mcpSessionId);
    mcpSessionId = res.session;

    let removed = 0;
    try {
      const match = res.resultText.match(/DEDUP_RESULT:(\{[\s\S]*?\})/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        removed = parsed.count || 0;
      }
    } catch { /* ignore */ }

    return { status: "success", removed, mcpSessionId };
  }

  if (payload.action === "apply_materials") {
     const materialResult = await applyDefaultMaterials(mcpSessionId);
     mcpSessionId = materialResult.session;
     return { status: "success", materialResult, mcpSessionId };
  }

  if (payload.action === "create_roof") {
    const rawType = (payload.roof_type || "").toUpperCase();
    let roof_type = "FLAT";
    if (rawType.includes("GABLE")) roof_type = "GABLE_ROOF";
    else if (rawType.includes("HIP")) roof_type = "HIP_ROOF";
    else if (rawType.includes("SHED")) roof_type = "SHED";

    // Delete existing roofs first to prevent overlapping roofs during edits
    try {
      await mcpCallTool("execute_ifc_code_tool", {
        code: `import ifcopenshell\nifc_file = get_ifc_file()\nfor roof in ifc_file.by_type("IfcRoof"):\n    ifc_file.remove(roof)\nsave_and_load_ifc()`
      }, mcpSessionId);
    } catch (e) {
      console.warn("Failed to delete existing roofs:", e);
    }

    const bbox = payload.bbox || { minX: 0, minY: 0, maxX: 6, maxY: 6, height: 3 };
    const overhang = 0.4;
    const x0 = Number(bbox.minX) - overhang;
    const x1 = Number(bbox.maxX) + overhang;
    const y0 = Number(bbox.minY) - overhang;
    const y1 = Number(bbox.maxY) + overhang;
    const z = Number(bbox.height || 3);

    const suppliedFootprint = Array.isArray(payload.footprint) ? payload.footprint : [];
    const validFootprint = suppliedFootprint.length >= 3 && suppliedFootprint.every((point: any) =>
      Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
    );
    const polyline = validFootprint
      ? suppliedFootprint.map((point: any) => [Number(point[0]), Number(point[1]), z])
      : [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];

    const buildRes = await mcpCallTool("create_roof", {
      polyline,
      roof_type,
      angle: roof_type === "GABLE_ROOF" || roof_type === "HIP_ROOF" ? 35.0 : 0.0,
      thickness: 0.3
    }, mcpSessionId).catch((err) => {
      console.error("create_roof execution error:", err);
      return null;
    });
    if (buildRes) mcpSessionId = buildRes.session;
    return { status: "success", mcpSessionId };
  }

  if (payload.action === "build_component") {
    const comp = payload.component || {};
    const toolAudit: ToolAuditEntry[] = [];
    let args: any = {};

    if (comp.trimesh_code) {
      args = {
        trimesh_code: comp.trimesh_code,
        ifc_class: comp.ifc_class || "IfcBuildingElementProxy",
        name: comp.name || "Component"
      };
    } else {
      const geomType = (comp.geometry_type || "box").toLowerCase();
      const dims = comp.dimensions || {};
      const pos = comp.position || [0, 0, 0];
      const x = Number(pos[0] || 0), y = Number(pos[1] || 0), z = Number(pos[2] || 0);

      let code = "";
      if (geomType === "cylinder") {
        const r = Number(dims.radius || 1.0);
        const h = Number(dims.height || 5.0);
        code = `c = trimesh.primitives.Cylinder(radius=${r}, height=${h})\nc.apply_translation([${x}, ${y}, ${z}])\nresult = c`;
      } else if (geomType === "sphere") {
        const r = Number(dims.radius || 1.0);
        code = `s = trimesh.primitives.Sphere(radius=${r})\ns.apply_translation([${x}, ${y}, ${z}])\nresult = s`;
      } else {
        const l = Number(dims.length || 5.0);
        const w = Number(dims.width || 2.0);
        const h = Number(dims.height || 1.0);
        code = `b = trimesh.primitives.Box(extents=[${l}, ${w}, ${h}])\nb.apply_translation([${x}, ${y}, ${z}])\nresult = b`;
      }

      args = {
        trimesh_code: code,
        ifc_class: comp.ifc_class || "IfcBuildingElementProxy",
        name: comp.name || "Component"
      };
    }

    const gate = evaluateToolSelection("create_trimesh_ifc", args, [...CORE_EDIT_TOOLS].map((name) => ({ name })), comp);
    toolAudit.push(gate);
    if (!gate.allowed) {
      throw new Error(`${gate.reason} Use ${gate.semantic_alternative} instead.`);
    }

    const res = await mcpCallTool("create_trimesh_ifc", args, mcpSessionId);
    mcpSessionId = res.session;
    return { status: "success", result: res.resultText, mcpSessionId, toolAudit };
  }

  if (payload.action === "build_freeform") {
    // Initialize fresh project
    const initRes = await mcpCallTool("initialize_project", { project_name: payload.plan?.structure_name || "InfraStudio Structure" }, mcpSessionId);
    mcpSessionId = initRes.session;

    // Fetch all available MCP tools
    const toolFetch = await fetchMcpTools(mcpSessionId);
    mcpSessionId = toolFetch.session;
    const allTools = toolFetch.tools;

    // Fetch trimesh examples to give the LLM concrete code templates
    let trimeshExamples = "";
    try {
      const exRes = await mcpCallTool("get_trimesh_examples", {}, mcpSessionId);
      mcpSessionId = exRes.session;
      trimeshExamples = exRes.resultText;
    } catch { /* non-fatal */ }

    const freeformPrompt = `You are the BIM Execution Agent for InfraStudio.
You have access to ALL available MCP tools. Your job is to build the requested structure by calling the right tools.
This is NOT a building with rooms — do NOT use build_room or create doors/windows unless explicitly requested.

For 3D shapes, your PRIMARY tool is create_trimesh_ifc. Write Python code using the trimesh library.
Available trimesh primitives:
- trimesh.primitives.Box(extents=[x,y,z]) — rectangular solid
- trimesh.primitives.Cylinder(radius=r, height=h) — cylinder
- trimesh.primitives.Sphere(radius=r) — sphere
- trimesh.creation.extrude_polygon(polygon, height) — extrude a 2D shape
- Boolean operations: mesh_a.union(mesh_b), mesh_a.difference(mesh_b), mesh_a.intersection(mesh_b)
- Transforms: mesh.apply_translation([x,y,z]), mesh.apply_transform(matrix)

CRITICAL RULES for trimesh code:
- You MUST assign the final mesh to a variable named exactly 'result'
- NEVER use print() statements
- Import nothing — trimesh, np, and math are pre-imported
- Translate objects BEFORE combining with .union()
- For curved or ascending bridge decks: combine multiple box segments positioned along an arc or parabola using math.cos(t), math.sin(t), and elevation z(t).
- NEVER call .is_empty on numpy arrays.
- NEVER write 'NaN' or undefined variable identifiers in Python code (always use valid numbers e.g. 0.0).
- All coordinates, extents, and dimensions must be real finite numbers.

For standard structural elements, you can also use:
- create_slab (rectangular slabs/decks)
- create_polyline_slab (custom polygon slabs)
- create_circular_slab (round slabs)
- create_polyline_walls (walls along a path)
- execute_ifc_code_tool (raw ifcopenshell API calls)

IFC classes for infrastructure:
- IfcBeam, IfcColumn, IfcSlab, IfcMember, IfcFooting, IfcPile
- IfcBuildingElementProxy (generic element)
- IfcPipeSegment, IfcDuctSegment, IfcCableCarrierSegment (MEP)

Think step by step:
1. What components does the structure need?
2. What geometry (box, cylinder, custom) best represents each component?
3. What are the correct positions so components connect properly?
4. Call create_trimesh_ifc for each component with the right ifc_class.
5. After all components, apply materials using create_surface_style + apply_style_to_object.

IMPORTANT: You MUST make at least one mutation tool call. Output ONLY tool_calls.`;

    const planDescription = `Structure to build: ${JSON.stringify(payload.plan)}

Trimesh code examples for reference:
${trimeshExamples}`;

    let executedMutation = false;
    const executedTools: string[] = [];
    const toolAudit: ToolAuditEntry[] = [];
    let executionError = "";

    const rawComponents = payload.plan?.components || [];
    if (Array.isArray(rawComponents) && rawComponents.length > 0) {
      console.log(`[build_freeform] Executing ${rawComponents.length} components from architect plan...`);
      for (const comp of rawComponents) {
        const ifcClass = comp.ifc_class || "IfcBuildingElementProxy";
        const geomType = String(comp.geometry_type || "box").toLowerCase();
        let code = "";

        if (comp.trimesh_code && typeof comp.trimesh_code === "string" && comp.trimesh_code.trim().length > 10) {
          code = comp.trimesh_code;
        } else if (geomType === "cylinder" || ifcClass === "IfcReinforcingBar" || /rebar|pipe|column/i.test(comp.name)) {
          const dims = typeof comp.dimensions === "object" && comp.dimensions !== null ? comp.dimensions : {};
          const radius = Number(dims.radius || (dims.width ? Number(dims.width) / 2 : 0.015));
          const height = Number(dims.height || dims.length || 3.0);
          const pos = Array.isArray(comp.position) ? comp.position : [0, 0, height / 2];
          code = `
result = trimesh.primitives.Cylinder(radius=${radius}, height=${height})
result.apply_translation([${pos[0] || 0}, ${pos[1] || 0}, ${pos[2] || 0}])
`;
        } else if (geomType === "sphere") {
          const dims = typeof comp.dimensions === "object" && comp.dimensions !== null ? comp.dimensions : {};
          const radius = Number(dims.radius || 1.0);
          const pos = Array.isArray(comp.position) ? comp.position : [0, 0, radius];
          code = `
result = trimesh.primitives.Sphere(radius=${radius})
result.apply_translation([${pos[0] || 0}, ${pos[1] || 0}, ${pos[2] || 0}])
`;
        } else {
          // Default: Box primitive
          const dims = typeof comp.dimensions === "object" && comp.dimensions !== null ? comp.dimensions : {};
          const length = Number(dims.length || 1.0);
          const width = Number(dims.width || 1.0);
          const height = Number(dims.height || 1.0);
          const pos = Array.isArray(comp.position) ? comp.position : [0, 0, height / 2];
          code = `
result = trimesh.primitives.Box(extents=[${length}, ${width}, ${height}])
result.apply_translation([${pos[0] || 0}, ${pos[1] || 0}, ${pos[2] || 0}])
`;
        }

        try {
          console.log(`[build_freeform] Creating component: ${comp.name} (${ifcClass})`);
          const gate = evaluateToolSelection("create_trimesh_ifc", {
            ifc_class: ifcClass,
            name: comp.name || `${ifcClass}_Component`
          }, allTools, comp);
          toolAudit.push(gate);
          if (!gate.allowed) throw new Error(`${gate.reason} Use ${gate.semantic_alternative} instead.`);
          const toolRes = await mcpCallTool("create_trimesh_ifc", {
            trimesh_code: code,
            ifc_class: ifcClass,
            name: comp.name || `${ifcClass}_Component`
          }, mcpSessionId);
          mcpSessionId = toolRes.session;
          executedTools.push("create_trimesh_ifc");
          executedMutation = true;
        } catch (cErr: any) {
          console.warn(`[build_freeform] Non-fatal component creation error for ${comp.name}:`, cErr.message || cErr);
        }
      }
    }

    // If components were executed directly, we can skip callGLM retry loop
    if (!executedMutation) {
      for (let tryNum = 1; tryNum <= 3; tryNum++) {
        let currentPlan = planDescription;
        if (executionError) {
          currentPlan += `\n\nPREVIOUS ATTEMPT FAILED:\n${executionError}\nFix the issues and try again with correct tool calls.`;
          executionError = "";
        }

        const glmMsg = await callGLM(freeformPrompt, currentPlan, allTools, "qwen3.8-max");
        const toolCalls = glmMsg.tool_calls || [];
        if (toolCalls.length === 0) {
          executionError = "No tool calls were produced. You MUST call create_trimesh_ifc or other tools to build the structure.";
          if (tryNum === 3) throw new Error(executionError);
          continue;
        }

        try {
          for (const call of toolCalls) {
            const toolName = call.function.name;
            const args = JSON.parse(call.function.arguments || "{}");
            console.log(`[build_freeform] Executing tool: ${toolName}`);
            try {
              const gate = evaluateToolSelection(toolName, args, allTools, payload.plan);
              toolAudit.push(gate);
              if (!gate.allowed) throw new Error(`${gate.reason}${gate.semantic_alternative ? ` Use ${gate.semantic_alternative} instead.` : ""}`);
              const toolRes = await mcpCallTool(toolName, args, mcpSessionId);
              mcpSessionId = toolRes.session;
              executedTools.push(toolName);
              if (MUTATION_TOOLS.has(toolName) && toolName !== "export_ifc") {
                executedMutation = true;
              }
            } catch (tErr: any) {
              console.warn(`[build_freeform] Tool ${toolName} threw warning:`, tErr.message || tErr);
              if (toolName.includes("style") || toolName.includes("material")) {
                continue;
              }
              throw tErr;
            }
          }

          if (!executedMutation) {
            throw new Error("No geometry was created. You must call create_trimesh_ifc or similar tools.");
          }
          break;
        } catch (err: any) {
          executionError = err.message || String(err);
          console.error(`[build_freeform] Attempt ${tryNum} failed: ${executionError}`);
          if (tryNum === 3) throw err;
        }
      }
    }

    // Apply materials and export
    const exported = await exportWithMaterials(mcpSessionId);
    return {
      status: "success",
      ifc_url: exported.ifc_url,
      mcpSessionId: exported.mcpSessionId,
      executedTools,
      toolAudit,
      materialResult: exported.materialResult,
    };
  }

  if (payload.action === "dynamic_edit") {
    const plan = payload.plan;
    const toolFetch = await fetchMcpTools(mcpSessionId);
    mcpSessionId = toolFetch.session;
    const availableTools = toolFetch.tools;
    // ALWAYS expose 100% of all MCP tools directly to the model
    const routedTools = availableTools;

    const sceneRes = await mcpCallTool("get_scene_info", {
      limit: -1,
      include_bbox: true,
      include_transform: true,
      round_decimals: 3,
    }, mcpSessionId);
    mcpSessionId = sceneRes.session;

    const overviewRes = await mcpCallTool("get_ifc_scene_overview", {}, mcpSessionId).catch(() => null);
    if (overviewRes) mcpSessionId = overviewRes.session;

    const glmPrompt = `You are the BIM MCP Execution Agent for InfraStudio.
Your sole job is to call real MCP tools to perform the requested edit or creation on the active IFC model.

Rules for Edits:
 0. If "review_required" is true, resolve EVERY review issue before making optional design changes. Use the supplied GlobalIds and semantic tools; do not create generic proxy geometry as a workaround.
    - For every item in review_issues/fix_recommendations, make at least one concrete mutation tool call that directly addresses it.
    - If elements are missing, create semantic replacements (build_room, create_wall, create_slab, create_door, create_window, create_roof, create_trimesh_ifc with a real IFC class), then rely on re-review.
    - If geometry clashes are reported, inspect bounding boxes from Current IFC Scene State and move, resize, or delete the conflicting element by GlobalId.
 1. Look at "Current IFC Scene State" and "IFC Overview" to find target GlobalId (GUID) values for existing walls, slabs, storeys, or elements. Never invent fake GUIDs.
 2. To MODIFY or RESIZE an existing element:
    - For doors: Call update_door(guid, width, height, offset, etc.)
    - For windows: Call update_window(guid, width, height, offset, etc.)
    - For walls: Call update_wall(guid, height, thickness, etc.)
    - For slabs: Call update_slab(guid, thickness, etc.)
    Always check the target element's GlobalId from "Current IFC Scene State".
 3. To add a door or window to an existing wall:
    Call create_door or create_window, setting wall_guid to the target wall's GlobalId, and ALWAYS set "create_opening": true.
 4. To change materials: Call create_surface_style or create_pbr_style, then call apply_style_to_object with the target entity's GlobalId.
 5. To add a roof: Call create_roof on the top storey or host walls.
 6. To add stairs: Call create_stairs between storeys.
 7. To add custom objects or furniture: Call create_trimesh_ifc or build_room.
 8. To DELETE or REMOVE elements (e.g. remove a door, window, wall, slab, roof, or entire room):
    Call execute_ifc_code_tool, executing Python code to remove the target IFC entity by GlobalId.
     Example Python code to delete an entity:
     """
     import ifcopenshell
     ifc_file = get_ifc_file()
     try:
         element = ifc_file.by_guid("TARGET_GLOBAL_ID")
         ifc_file.remove(element)
         save_and_load_ifc()
     except Exception:
         pass
     """
    Always search the "Current IFC Scene State" for the correct GlobalId of the element to delete.
 9. For ADVANCED EDITS (e.g. moving a room, shifting a wall, renaming a storey, copying elements, or custom structural changes):
    Call execute_ifc_code_tool, writing Python code using the ifcopenshell library to modify the coordinates or attributes of the target entities.
    Remember to call save_and_load_ifc() at the end of your Python code to save changes back to the active model.
 10. Output ONLY tool calls. Do not return empty tool calls. At least one mutation tool must be called.`;

    const basePlanData = `Instructions: ${JSON.stringify(plan)}

Current IFC Scene State:
${sceneRes.resultText}

IFC Overview:
${overviewRes?.resultText || "Unavailable"}`;

    let ifc_url = "";
    let executionError = "";
    let executedMutation = false;
    const executedTools: string[] = [];
    const toolAudit: ToolAuditEntry[] = [];
    const remediationWarnings: string[] = [];

    for (let tryNum = 1; tryNum <= 3; tryNum++) {
      let currentPlanData = basePlanData;
      if (executionError) {
        currentPlanData += `\n\nPREVIOUS EXECUTION FAILED:\n${executionError}\nRetry with concrete mutation tool calls.`;
        executionError = "";
      }

      const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools, "qwen3.8-max");
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
          const gate = evaluateToolSelection(toolName, args, routedTools, plan);
          toolAudit.push(gate);
          if (!gate.allowed) throw new Error(`${gate.reason}${gate.semantic_alternative ? ` Use ${gate.semantic_alternative} instead.` : ""}`);
          const toolRes = await mcpCallTool(toolName, args, mcpSessionId);
          mcpSessionId = toolRes.session;
          executedTools.push(toolName);

          if (MUTATION_TOOLS.has(toolName) && toolName !== "export_ifc") {
            executedMutation = true;
          }
        }

        if (!executedMutation) {
          console.warn("[dynamic_edit] No mutation tool was executed during this edit step.");
          if (plan?.review_required) {
            remediationWarnings.push("Review remediation produced no mutation tool calls; exported the existing model for re-review.");
          }
        }
        break;
      } catch (err: any) {
        executionError = err.message || String(err);
        if (tryNum === 3) throw err;
      }
    }

    const exported = await exportWithMaterials(mcpSessionId);
    ifc_url = exported.ifc_url;
    mcpSessionId = exported.mcpSessionId;

    return {
      status: "success",
      ifc_url,
      mcpSessionId,
      executedTools,
      toolAudit,
      remediationWarnings,
      materialResult: exported.materialResult,
    };
  }

  if (payload.action === "export") {
    const exported = await exportWithMaterials(mcpSessionId);
    return { status: "success", ...exported };
  }

  throw new Error("Invalid action");
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await req.json();
      const result = await handleBim(payload);
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  });
}
