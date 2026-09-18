import { CORS, mcpInit, mcpCallTool, fetchMcpTools, callQwen, callGLM, runAntigravityKimiAgent, enrichRoomsWithFurniture, embellishStoreysArchitecturally, generateStoreyFreeform, generateRoofFreeform, estimateRoomBounds, generateInfrastructureFreeform, runAgenticComponentBuild, AGENTIC_GRAND_STRUCTURE_SYSTEM_PROMPT } from "../_shared/shared.ts";
import type { SceneElement } from "../_shared/shared.ts";
import { handleReviewer } from "../agent-reviewer/index.ts";
import { startOpenHandsBuild, pollOpenHandsBuild } from "../_shared/openhands_agent.ts";
import { startAntigravityBuild, pollAntigravityBuild, refImagePath, type ReferenceImage } from "../_shared/antigravity_agent.ts";

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

  const harnessPython = `
import ifcopenshell
import ifcopenshell.api as api

ifc = get_ifc_file()
body_ctx = get_or_create_body_context(ifc)

material_configs = [
    ("IfcWall", "Architectural Wall Render", "Style_Wall_Render", (0.88, 0.86, 0.82), 0.0),
    ("IfcWallStandardCase", "Architectural Wall Render", "Style_Wall_Render", (0.88, 0.86, 0.82), 0.0),
    ("IfcSlab", "Structural Concrete Slab", "Style_Concrete_Slab", (0.55, 0.55, 0.56), 0.0),
    ("IfcDoor", "Hardwood Timber Door", "Style_Timber_Door", (0.45, 0.28, 0.14), 0.0),
    ("IfcWindow", "Double-Glazed Vision Glass", "Style_Vision_Glass", (0.60, 0.82, 0.94), 0.60),
    ("IfcRoof", "Weatherproof Roofing Membrane", "Style_Roof_Membrane", (0.32, 0.33, 0.35), 0.0),
    ("IfcColumn", "Structural Column Steel/Concrete", "Style_Column_Anthracite", (0.28, 0.30, 0.32), 0.0),
    ("IfcBeam", "Structural Framing Steel", "Style_Steel_Framing", (0.92, 0.75, 0.10), 0.0),
    ("IfcFooting", "Reinforced Concrete Foundation", "Style_Concrete_Footing", (0.60, 0.62, 0.64), 0.0),
    ("IfcPile", "Deep Foundation Steel Casing", "Style_Foundation_Pile", (0.35, 0.36, 0.38), 0.0),
    ("IfcStair", "Architectural Concrete Stair", "Style_Stair_Concrete", (0.65, 0.66, 0.68), 0.0),
    ("IfcStairFlight", "Architectural Concrete Stair Flight", "Style_Stair_Concrete", (0.65, 0.66, 0.68), 0.0),
    ("IfcRailing", "Stainless Steel Safety Railing", "Style_Safety_Railing", (0.90, 0.78, 0.10), 0.0),
    ("IfcBuildingElementProxy", "Engineered Infrastructure Element", "Style_Infra_Proxy", (0.75, 0.76, 0.78), 0.0)
]

applied_count = 0
for ifc_class, mat_name, style_name, (r, g, b), transp in material_configs:
    elements = ifc.by_type(ifc_class)
    if not elements:
        continue
    mat = api.run("material.add_material", ifc, name=mat_name)
    style = api.run("style.add_style", ifc, name=style_name, ifc_class="IfcSurfaceStyle")
    rgb = ifc.create_entity("IfcColourRgb", Red=r, Green=g, Blue=b)
    shading = ifc.create_entity("IfcSurfaceStyleShading", SurfaceColour=rgb, Transparency=transp)
    style.Styles = [shading]
    api.run("style.assign_material_style", ifc, material=mat, style=style, context=body_ctx)
    api.run("material.assign_material", ifc, products=elements, material=mat)
    for el in elements:
        if el.Representation:
            for rep in el.Representation.Representations:
                try:
                    api.run("style.assign_representation_styles", ifc, shape_representation=rep, styles=[style])
                except Exception:
                    pass
    applied_count += len(elements)

save_and_load_ifc()
print(f"Harness Applied PBR Styles & Materials to {applied_count} objects!")
`;

  try {
    const res = await mcpCallTool("execute_ifc_code_tool", { code: harnessPython }, session);
    session = res.session;
    summary["harness_pbr_styled"] = 1;
  } catch (err) {
    errors.push(`Harness Material Styling Error: ${err instanceof Error ? err.message : String(err)}`);
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
  // Temporary diagnostic: verify a candidate DashScope model id is valid and has
  // quota, without touching MCP/IFC state at all. Not part of the generation
  // pipeline itself - safe to remove once model selection is settled.
  if (payload.action === "test_model") {
    const model = String(payload.model || "glm-5.3");
    const t0 = Date.now();
    try {
      const raw = await callQwen(
        "You are a helpful assistant. Reply with exactly one short sentence.",
        "Say hello and name yourself.",
        false,
        model,
        60000,
        "medium",
        200
      );
      return { status: "success", model, ms: Date.now() - t0, raw };
    } catch (err: any) {
      return { status: "error", model, ms: Date.now() - t0, error: err?.message || String(err) };
    }
  }

  // Temporary diagnostic: verify real tool-calling (function calling) actually
  // works against DashScope for this model before building an agentic loop on
  // top of it. Not part of the generation pipeline - safe to remove.
  if (payload.action === "test_tool_call") {
    const model = String(payload.model || "glm-5.3");
    const t0 = Date.now();
    try {
      const tools = [{
        type: "function",
        function: {
          name: "get_scene_info",
          description: "Get a list of every element currently built in the scene, with names and bounding boxes.",
          parameters: { type: "object", properties: { limit: { type: "integer", description: "max elements to return" } }, required: [] }
        }
      }];
      const msg = await callGLM(
        "You are a structural engineer with access to a get_scene_info tool. Use it whenever you need to know what already exists before placing something new.",
        "Before we start, check what's already in the scene.",
        tools,
        model
      );
      return { status: "success", model, ms: Date.now() - t0, message: msg };
    } catch (err: any) {
      return { status: "error", model, ms: Date.now() - t0, error: err?.message || String(err) };
    }
  }

  let mcpSessionId = payload.mcpSessionId;
  if (!mcpSessionId) mcpSessionId = await mcpInit("");

  // Whole-structure agentic build: no component-list plan, no per-component
  // sessions - the model gets the raw brief and one continuous tool-calling
  // conversation to design AND build the entire structure itself (its own
  // alignment functions, its own batched loops), the same way a human
  // engineer would script a large repetitive structure. Chained across
  // invocations via the same continuation/deadline pattern as build_code.
  if (payload.action === "grand_build") {
    const brief = String(payload.brief || "");
    const continuation = payload.continuation;
    if (continuation?.mcpSessionId) {
      mcpSessionId = continuation.mcpSessionId;
    } else {
      const initRes = await mcpCallTool("initialize_project", { project_name: payload.projectName || "Grand Agentic Structure" }, mcpSessionId);
      mcpSessionId = initRes.session;
    }
    const deadline: number = Number(payload._deadline) || 0;
    const elements: SceneElement[] = continuation?.elements || [];
    // Model is selectable per-call (defaults to the usual one) and carried
    // through continuation so a resumed build keeps using the same model it
    // started with, even if the caller's own default changes later - this is
    // what lets a run be switched to a different model when one hits its
    // DashScope quota mid-project without losing progress.
    const model = String(continuation?.model || payload.model || "glm-5.3");

    const agentic = await runAgenticComponentBuild(
      AGENTIC_GRAND_STRUCTURE_SYSTEM_PROMPT,
      brief,
      mcpSessionId,
      elements,
      () => {},
      { model, maxIterations: 20, deadline, maxTokens: 10000, callTimeoutMs: 300000, initialMessages: continuation?.messages }
    );

    const totalElements = elements.length + agentic.newElements.length;
    if (agentic.stoppedEarly) {
      return {
        status: "continue",
        continuation: { mcpSessionId: agentic.mcpSessionId, elements: [...elements, ...agentic.newElements], messages: agentic.messages, model },
        totalElements,
        progress: `${totalElements} elements built so far - call again with plan.continuation to resume.`,
        transcript: agentic.transcript
      };
    }

    let ifcUrl = "";
    try {
      const exportRes = await mcpCallTool("export_ifc", {}, agentic.mcpSessionId);
      ifcUrl = JSON.parse(exportRes.resultText)?.file_url || "";
    } catch { /* export failure reported via empty ifc_url, not fatal to the report */ }

    return {
      status: totalElements > 0 ? "success" : "error",
      mcpSessionId: agentic.mcpSessionId,
      ifc_url: ifcUrl,
      totalElements,
      transcript: agentic.transcript,
      lastError: agentic.lastError
    };
  }

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
    let origin: number[] = [0, 0, 0];
    if (Array.isArray(room.origin)) {
      origin = room.origin.map(Number);
    } else if (typeof room.origin === "string") {
      const parts = room.origin.trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 3 && !parts.some(isNaN)) {
        origin = parts.slice(0, 3);
      }
    }

    const doors = Array.isArray(room.doors) ? room.doors : [];
    const windows = Array.isArray(room.windows) ? room.windows : [];

    const buildRes = await mcpCallTool("build_room", {
      room_name: room.name,
      width: room.width || 4,
      length: room.length || 4,
      height: payload.storeyHeight || room.height || 3,
      wall_thickness: room.wall_thickness || 0.2,
      origin: origin,
      floor_slab: room.floor_slab !== undefined ? Boolean(room.floor_slab) : true,
      ceiling_slab: room.ceiling_slab !== undefined ? Boolean(room.ceiling_slab) : true,
      doors: doors,
      windows: windows,
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
      const rotZ = Number(comp.rotation_z || comp.rot_z_deg || 0.0);

      let code = "";
      if (geomType.includes("corrugat") || geomType.includes("sheet_pile")) {
        const width = Number(dims.width || dims.length || 2.4);
        const height = Number(dims.height || 12.0);
        const depth = Number(dims.depth || 0.45);
        const pitch = Number(dims.pitch || 0.6);
        const thick = Number(dims.thickness || 0.04);
        code = `h = InfraStudioHarness(None)\nresult = h.create_corrugated_panel(width=${width}, height=${height}, depth=${depth}, pitch=${pitch}, thickness=${thick}, pos=[${x}, ${y}, ${z}], rot_z_deg=${rotZ})`;
      } else if (geomType.includes("cutwater") || geomType.includes("pier")) {
        const length = Number(dims.length || 12.0);
        const width = Number(dims.width || 4.0);
        const height = Number(dims.height || 8.0);
        const noseR = Number(dims.nose_radius || dims.radius || width / 2.0);
        code = `h = InfraStudioHarness(None)\nresult = h.create_cutwater_pier(length=${length}, width=${width}, height=${height}, nose_r=${noseR}, pos=[${x}, ${y}, ${z}], rot_z_deg=${rotZ})`;
      } else if (geomType.includes("pipe") || geomType.includes("hollow_cylinder") || geomType.includes("strut")) {
        const outerR = Number(dims.outer_radius || dims.radius || 0.4);
        const innerR = Number(dims.inner_radius || (outerR * 0.88));
        const height = Number(dims.height || dims.length || 6.0);
        const axis = Array.isArray(dims.axis) ? dims.axis : (Array.isArray(comp.axis) ? comp.axis : [0, 0, 1]);
        code = `h = InfraStudioHarness(None)\nresult = h.create_pipe(outer_r=${outerR}, inner_r=${innerR}, height=${height}, pos=[${x}, ${y}, ${z}], axis=[${axis[0]}, ${axis[1]}, ${axis[2]}])`;
      } else if (geomType.includes("i_beam") || geomType.includes("waler") || geomType.includes("girder")) {
        const depth = Number(dims.depth || dims.height || 0.6);
        const flangeW = Number(dims.flange_width || dims.width || 0.3);
        const length = Number(dims.length || 10.0);
        code = `h = InfraStudioHarness(None)\nresult = h.create_i_beam(depth=${depth}, flange_w=${flangeW}, length=${length}, pos=[${x}, ${y}, ${z}], rot_z_deg=${rotZ})`;
      } else if (geomType.includes("cylinder")) {
        const r = Number(dims.radius || (dims.width ? Number(dims.width) / 2 : 1.0));
        const h = Number(dims.height || dims.length || 5.0);
        const axis = Array.isArray(dims.axis) ? dims.axis : (Array.isArray(comp.axis) ? comp.axis : [0, 0, 1]);
        code = `h = InfraStudioHarness(None)\nresult = h.create_cylinder(radius=${r}, height=${h}, pos=[${x}, ${y}, ${z}], axis=[${axis[0]}, ${axis[1]}, ${axis[2]}])`;
      } else if (geomType === "sphere") {
        const r = Number(dims.radius || 1.0);
        code = `s = trimesh.primitives.Sphere(radius=${r})\ns.apply_translation([${x}, ${y}, ${z}])\nresult = s`;
      } else {
        const l = Number(dims.length || dims.x || 5.0);
        const w = Number(dims.width || dims.y || 2.0);
        const h = Number(dims.height || dims.z || 1.0);
        code = `h = InfraStudioHarness(None)\nresult = h.create_box(extents=[${l}, ${w}, ${h}], pos=[${x}, ${y}, ${z}], rot_z_deg=${rotZ})`;
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

  if (payload.action === "build_code" || payload.action === "build_freeform") {
    const continuation = payload.plan?.continuation;
    const executedTools: string[] = [];

    // OpenHands routing (new builds only, toggled by USE_OPENHANDS_ENGINE):
    // hands the raw brief to OpenHands - a real agentic coding CLI - headless
    // on the EC2 MCP box via SSM - instead of this pipeline's own
    // direct-model orchestration. See _shared/openhands_agent.ts for the
    // current model/provider. Bypasses this pipeline's
    // mcpSessionId/initialize_project bookkeeping entirely; OpenHands owns
    // its own MCP connection/session and calls initialize_project itself as
    // part of its task, so `jobId` here is just an opaque tracking id, not a
    // real MCP session. See infrastudio-kimi-pipeline-no-fallback memory for
    // why (verified: genuinely correct complex geometry where the direct
    // pipeline had repeated real quality problems) - never a silent
    // fallback, this is an explicit on/off switch the user controls.
    const getEnv = (name: string): string | undefined => (typeof Deno !== "undefined" ? Deno.env.get(name) : process.env[name]);
    const useAntigravity = getEnv("USE_ANTIGRAVITY_ENGINE") === "true";
    const useOpenHands = getEnv("USE_OPENHANDS_ENGINE") === "true";

    // Antigravity routing (new builds only, toggled by USE_ANTIGRAVITY_ENGINE):
    // hands the raw brief to the Antigravity CLI ("agy") - a real agentic
    // coding CLI driving Gemini 3.8 Flash High via the user's own Antigravity
    // Pro subscription - headless on the EC2 MCP box via SSM, the same
    // deployment shape as the OpenHands path below but on infrastructure that
    // is actually confirmed working end-to-end this session (real materials
    // on every element, correct structure-type geometry, multi-thousand
    // element builds, verified independently against the live MCP scene).
    // Takes priority over USE_OPENHANDS_ENGINE when both happen to be set.
    if (useAntigravity && !payload.plan?.is_edit) {
      const continuation = payload.plan?.continuation;
      if (continuation?.kind === "antigravity") {
        const result = await pollAntigravityBuild(continuation.ssmCommandId);
        if (!result.done) return { status: "continue", continuation, progress: result.progressMessage, mcpSessionId: continuation.jobId };
        return result.error
          ? { status: "error", error: result.error, mcpSessionId: continuation.jobId }
          : { status: "success", ifc_url: result.ifcUrl, mcpSessionId: continuation.jobId };
      }
      const userBrief = payload.plan?.client_requirements || payload.plan?.prompt || payload.plan?.structure_name || "";
      const jobId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `job-${Date.now()}`;

      // Reference images (floor plans, sketches, aerial views, schematics)
      // attached from the frontend - uploaded to Supabase Storage there, only
      // the public URLs travel through this JSON payload. Antigravity can't
      // see a URL from inside its headless shell session, so these get
      // downloaded onto the EC2 box (see startAntigravityBuild) at the exact
      // paths computed here, and the brief tells it to read each one by path
      // before designing anything - confirmed this session that agy's
      // Gemini 3.8 Flash vision genuinely reads and correctly describes an
      // arbitrary image file placed in its --add-dir workspace.
      const images: ReferenceImage[] = Array.isArray(payload.plan?.images)
        ? payload.plan.images.filter((img: any) => img && typeof img.url === "string" && img.url.trim())
        : [];
      const imageSection = images.length > 0
        ? `\n\nIMPORTANT reference images provided (read each one with your file-reading tool BEFORE designing anything - they are ground truth for whatever they depict, not loose inspiration):\n${images.map((img, i) => `- ${refImagePath(jobId, i, img.url)} — ${img.caption?.trim() || "reference image: inspect its layout/form/style and use it to inform the design"}`).join("\n")}\nIf an image is a floor plan or schematic, replicate its actual room layout, wall positions, and proportions rather than inventing a different layout. If it is a sketch, aerial view, or elevation, match the massing, style, and site orientation it shows.`
        : "";

      // Same standing instructions as the OpenHands brief below (native tool
      // calls only, mandatory materials, real engineering form before
      // geometry) - both engines are stateless headless agents with the same
      // failure modes without these reminders. Antigravity is now the ENTIRE
      // pipeline for a new build - there is no separate interpreter/architect/
      // reviewer pass anymore, so this brief has to explicitly hand it those
      // jobs instead of assuming a prior stage already did them.
      const brief = `You are acting as the complete pipeline for this build, not just an executor: interpreter (figure out what is really being asked), architect (invent every spec that isn't given), executor (build it via real tool calls), and reviewer (check your own result before exporting). No other agent will look at this before export - own every decision yourself.

IMPORTANT tool-usage rule: you have direct MCP tool-calling access to functions like create_wall, build_room, create_slab, create_stairs, create_trimesh_ifc, create_mesh_ifc, execute_ifc_code_tool, create_surface_style, apply_style_to_object, get_scene_info, export_ifc, etc. Always call these as native tool calls through your own tool-calling interface. Do NOT use the bash/terminal tool to run curl or hand-craft raw HTTP/JSON-RPC requests to the MCP server - that is unnecessary, unsupported, and will not work correctly.

IMPORTANT architect rule: if the request below is vague or incomplete (missing dimensions, materials, style, room program, structural system, etc.), do NOT ask the user for clarification and do NOT build a minimal placeholder while you wait - you have no way to ask, so invent complete, coherent, real-world-plausible specs yourself, exactly as a senior architect/engineer would when only given a one-line client brief. Decide the site/footprint, floor count and heights, full room program, structural system, facade materials, roof form, and styling direction before writing any geometry code, and commit to that decision. A short prompt is not permission to build something small or generic - it just means more of the design responsibility is yours.

IMPORTANT quality bar: every element you build must have a real, appropriate material/surface style applied (via create_surface_style/apply_style_to_object or equivalent) before you export - realistic colors/finishes matching what each element actually is (concrete, steel, timber, glass, etc.), not bare unstyled geometry. This applies even if the user's request doesn't explicitly mention materials. No element should be left unstyled.

IMPORTANT complexity bar (non-negotiable, applies to every build regardless of how the request was phrased): the final model must be genuinely complex and sophisticated - target at least 1,000+ real elements and an exported IFC file size in the multiple-megabyte range. Achieve this honestly, through real architectural/structural detail (individual structural members, window/door openings with frames, railings, stairs, roof detail, facade articulation, secondary structure) - never by padding with meaningless duplicate or degenerate geometry. If a request is small or vague, that is exactly when you should be adding the MOST design detail yourself, not less.

IMPORTANT design-accuracy rule: you have no memory of this project and no prior context beyond this message - do not default to a generic or approximate shape just because a request is short. Before building, identify the REAL engineering/architectural form of whatever is being asked for, and commit to specific, correct structural details before writing any geometry code. If a brief names a specific structure type, treat getting that type's real form right as more important than speed - do not substitute a different (even superficially similar) real-world structure type than the one named.

IMPORTANT execution constraint: if you use execute_ifc_code_tool, each call has a hard 60-second server-side execution timeout - split large builds into multiple calls (e.g. one per structural section/chunk of a few hundred elements) rather than one giant call. When assigning elements to the building storey, do NOT call spatial.assign_container once per element (this is O(n^2) and will time out as element count grows) - collect all new elements created within a single call into a list and call spatial.assign_container ONCE with the full list at the end of that call.

IMPORTANT reviewer rule (before export): once the shell/structure is built, call get_scene_info yourself and check it against the two bars above - is every element styled, and does the element count/complexity actually meet the 1,000+ element / multi-MB target? If not, go back and add the missing detail (more structural members, facade articulation, interior detail, materials) before exporting. Only call export_ifc once you would sign off on the result as genuinely complex and fully styled.

First, call initialize_project to reset the MCP scene to a fresh IFC4 state. Then build the following:

${userBrief}${imageSection}

When finished, call get_scene_info to confirm the total element count, then call export_ifc.`;
      const commandId = await startAntigravityBuild(brief, jobId, images);
      const newContinuation = { kind: "antigravity", ssmCommandId: commandId, jobId };
      return { status: "continue", continuation: newContinuation, progress: "Antigravity build started...", mcpSessionId: jobId };
    }

    if (useOpenHands && !payload.plan?.is_edit) {
      const deadline: number = Number(payload._deadline) || 0;
      if (continuation?.kind === "openhands") {
        const result = await pollOpenHandsBuild(continuation.ssmCommandId, deadline);
        if (!result.done) return { status: "continue", continuation, progress: "OpenHands build in progress...", mcpSessionId: continuation.jobId };
        return result.error
          ? { status: "error", error: result.error, mcpSessionId: continuation.jobId }
          : { status: "success", ifc_url: result.ifcUrl, mcpSessionId: continuation.jobId };
      }
      const userBrief = payload.plan?.client_requirements || payload.plan?.prompt || payload.plan?.structure_name || "";
      // Standing instructions every OpenHands build needs, regardless of what
      // the user asked for. Each one exists because it was skipped without
      // it, observed directly this session: (1) it has direct MCP
      // tool-calling access and must use it natively - without this
      // reminder the agent sometimes falls back to shelling out via
      // curl/bash instead, which doesn't work; (2) real materials/surface
      // styles are part of this pipeline's baseline quality bar (see
      // bim-generation-standards memory), not optional - without this
      // reminder even a request that explicitly asked for materials still
      // got built with zero styling; (3) design accuracy - OpenHands runs
      // as a single stateless conversation with NO memory of this project's
      // domain standards or prior builds (unlike an interactive assistant
      // that accumulates real context over a session), so a vague brief
      // like "create a cofferdam" gets built from whatever generic
      // association the model defaults to under time pressure - verified
      // this session that this produced a smooth rounded vessel with no
      // resemblance to a real cofferdam. Telling it to actually research and
      // reason about the real form before building is the fix, not assuming
      // the brief alone is enough context.
      const brief = `IMPORTANT tool-usage rule: you have direct MCP tool-calling access to functions like create_wall, build_room, create_slab, create_stairs, create_trimesh_ifc, create_mesh_ifc, execute_ifc_code_tool, create_surface_style, apply_style_to_object, get_scene_info, export_ifc, etc. Always call these as native tool calls through your own tool-calling interface. Do NOT use the bash/terminal tool to run curl or hand-craft raw HTTP/JSON-RPC requests to the MCP server - that is unnecessary, unsupported, and will not work correctly.

IMPORTANT quality bar: every element you build must have a real, appropriate material/surface style applied (via create_surface_style/apply_style_to_object or equivalent) before you export - realistic colors/finishes matching what each element actually is (concrete, steel, timber, glass, etc.), not bare unstyled geometry. This applies even if the user's request doesn't explicitly mention materials.

IMPORTANT design-accuracy rule: you have no memory of this project and no prior context beyond this message - do not default to a generic or approximate shape just because a request is short. Before building, identify the REAL engineering/architectural form of whatever is being asked for (use search_ifc_knowledge and your own domain knowledge), and commit to specific, correct structural details before writing any geometry code. For example: a cofferdam is NOT a bucket, tub, or smooth rounded vessel - it is a temporary watertight enclosure built from sheet-pile walls (or a braced double-wall cellular structure) forming a barrier around a work area, with corner bracing and a base/footing. If a brief names a specific structure type, treat getting that type's real form right as more important than speed.

First, call initialize_project to reset the MCP scene to a fresh IFC4 state. Then build the following:

${userBrief}

When finished, call export_ifc.`;
      const jobId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `job-${Date.now()}`;
      const commandId = await startOpenHandsBuild(brief, jobId);
      const result = await pollOpenHandsBuild(commandId, deadline);
      const newContinuation = { kind: "openhands", ssmCommandId: commandId, jobId };
      if (!result.done) return { status: "continue", continuation: newContinuation, progress: "OpenHands build started...", mcpSessionId: jobId };
      return result.error
        ? { status: "error", error: result.error, mcpSessionId: jobId }
        : { status: "success", ifc_url: result.ifcUrl, mcpSessionId: jobId };
    }

    // A continuation resumes an in-progress build (see the "NO FALLBACK ...
    // continue" section below) - the project already exists server-side, so
    // re-initializing it here would wipe the very progress being resumed.
    if (continuation?.mcpSessionId) {
      mcpSessionId = continuation.mcpSessionId;
    } else {
      const initRes = await mcpCallTool("initialize_project", { project_name: payload.plan?.structure_name || "InfraStudio Model" }, mcpSessionId);
      mcpSessionId = initRes.session;
      executedTools.push("initialize_project");
    }
    const deadline: number = Number(payload._deadline) || 0;

    let executedMutation = false;
    let generationError = "";
    const toolAudit: ToolAuditEntry[] = [];
    // Real, live scene elements built by generateStoreyFreeform (model-authored
    // geometry, no deterministic layout) - carried forward so the furniture
    // pass can ground itself in each room's ACTUAL built extent rather than a
    // pre-assigned coordinate that no longer exists.
    let builtElements: SceneElement[] = [];

    // 1. Direct Python code execution from plan (qwen3.8-max's own design)
    if (!continuation && payload.plan?.python_code && typeof payload.plan.python_code === "string" && payload.plan.python_code.trim().length > 20) {
      let codeToExecute = payload.plan.python_code;
      // Pre-execution code sanitization:
      codeToExecute = codeToExecute.replace(/import\s+InfraStudioHarness\s+as\s+h;?/g, "h = InfraStudioHarness()");
      codeToExecute = codeToExecute.replace(/import\s+InfraStudioHarness;?/g, "");
      codeToExecute = codeToExecute.replace(/from\s+InfraStudioHarness\s+import\s+[^;\n]+;?/g, "");
      codeToExecute = codeToExecute.replace(/import\s+(os|sys|subprocess|shutil)[^\n;]*;?/g, "# removed system import");

      console.log(`[build_code] Executing direct Python harness code from plan (${codeToExecute.length} chars)...`);
      try {
        const toolRes = await mcpCallTool("execute_ifc_code_tool", { code: codeToExecute }, mcpSessionId);
        mcpSessionId = toolRes.session;
        executedTools.push("execute_ifc_code_tool");
        executedMutation = true;
      } catch (pErr: any) {
        console.warn(`[build_code] Direct python_code execution failed, starting Antigravity self-healing pass (glm-5.3 repairing its own code, no fallback model/template):`, pErr);
        generationError = String(pErr?.message || pErr);
        try {
          // No fallback: this is qwen3.8-max retrying with the real execution error fed
          // back. If it still can't produce working code, selfHealed.success is
          // false and we report that honestly below - never a substitute design.
          const selfHealed = await runAntigravityKimiAgent(
            {
              brief: payload.plan,
              structure_name: payload.plan?.structure_name,
              project_type: payload.plan?.structure_name,
              client_requirements: payload.plan?.structure_name,
              room_requirements: payload.plan?.room_requirements || payload.brief?.room_requirements,
              failed_code: payload.plan.python_code,
              error: generationError
            },
            mcpSessionId,
            { model: "glm-5.3", maxRetries: 3 }
          );
          if (selfHealed.success) {
            mcpSessionId = selfHealed.mcpSessionId;
            executedTools.push("execute_ifc_code_tool");
            executedMutation = true;
            console.log(`[build_code] Antigravity self-healing succeeded - qwen3.8-max repaired its own code.`);
          } else {
            generationError = selfHealed.error || generationError;
          }
        } catch (healErr: any) {
          console.warn(`[build_code] Antigravity self-healing itself errored:`, healErr);
          generationError = healErr?.message || String(healErr);
        }
      }
    }

    // 1b. If no python_code but a room programme (storey_plans) is present -
    // the split-planning path: qwen3.8-max planned WHAT rooms to build, and
    // now builds each one itself, room by room, in strict sequence, against
    // the REAL live scene state (no deterministic layout/geometry code
    // anywhere - see generateStoreyFreeform). Each room is its own
    // execute_ifc_code_tool call, immediately re-verified against the real
    // scene for genuine bounding-box clashes (not just "did it crash"), with
    // one targeted retry and an honest skip - never a fallback design.
    //
    // Large room counts can genuinely need more wall-clock time than one
    // Lambda invocation allows (each room is a real, non-parallelizable
    // model round-trip). Rather than let that end in a mid-request timeout,
    // generateStoreyFreeform stops cleanly at `deadline` and reports exactly
    // where it stopped; this returns status:"continue" with everything the
    // next call needs to pick up seamlessly - never a deterministic
    // shortcut to avoid the wait.
    let structuralShellErrors: string[] = [];
    let freeformSteps: string[] = [];
    let embellishResult: { enrichedStoreys: number; skippedStoreys: number; steps: string[] } | null = null;
    const isBuildingContinuation = continuation && continuation.kind === "building";
    if (!executedMutation && Array.isArray(payload.plan?.storey_plans) && payload.plan.storey_plans.length > 0 && payload.plan?.structure_category !== "infrastructure" && (!continuation || isBuildingContinuation)) {
      const storeys = payload.plan.storey_plans;
      const startStoreyIdx = isBuildingContinuation ? continuation.storeyIndex : 0;
      const startRoomIdx = isBuildingContinuation ? continuation.roomIndex : 0;
      console.log(`[build_code] Building ${storeys.length} storey(s) room-by-room, model-authored geometry, sequential (each room sees the real scene state)${isBuildingContinuation ? ` - resuming at storey ${startStoreyIdx + 1}, room ${startRoomIdx + 1}` : ""}...`);
      let elements: SceneElement[] = isBuildingContinuation ? continuation.elements : [];
      let anyRoomBuilt = false;

      for (let sIdx = startStoreyIdx; sIdx < storeys.length; sIdx++) {
        try {
          const isResumeStorey = sIdx === startStoreyIdx && isBuildingContinuation;
          const { result, elements: updatedElements } = await generateStoreyFreeform(
            storeys[sIdx], sIdx, elements, mcpSessionId, (msg) => freeformSteps.push(msg),
            isResumeStorey ? startRoomIdx : 0,
            isResumeStorey,
            deadline
          );
          mcpSessionId = result.mcpSessionId;
          elements = updatedElements;
          if (result.builtRooms > 0) anyRoomBuilt = true;
          executedTools.push(`execute_ifc_code_tool(storey:${storeys[sIdx].name || sIdx}, rooms:${result.builtRooms}/${result.builtRooms + result.skippedRooms})`);
          if (result.skippedRooms > 0) structuralShellErrors.push(...result.steps.filter((s) => s.startsWith("⚠️")));

          if (result.stoppedAtRoomIndex !== undefined) {
            return {
              status: "continue",
              executedTools,
              freeformSteps,
              continuation: { kind: "building", mcpSessionId, elements, storeyIndex: sIdx, roomIndex: result.stoppedAtRoomIndex },
              progress: `Paused at storey ${sIdx + 1}/${storeys.length}, room ${result.stoppedAtRoomIndex + 1}/${storeys[sIdx].rooms?.length || 0} - call again with plan.continuation to resume.`
            };
          }
        } catch (stErr: any) {
          const msg = `Storey "${storeys[sIdx].name || sIdx}": ${stErr?.message || stErr}`;
          console.error(`[build_code] ${msg}`);
          structuralShellErrors.push(msg);
        }
      }
      builtElements = elements;

      if (anyRoomBuilt) {
        executedMutation = true;

        // Roof - the model's own creative design, given the real finished footprint.
        try {
          const roof = await generateRoofFreeform(payload.plan.roof_type, elements, mcpSessionId, (msg) => freeformSteps.push(msg));
          mcpSessionId = roof.mcpSessionId;
          executedTools.push(`execute_ifc_code_tool(roof:${roof.success ? "ok" : "skipped"})`);
        } catch (roofErr: any) {
          console.warn("[build_code] Roof generation errored (non-fatal, shell already stands):", roofErr);
        }

        // qwen3.8-max architectural embellishment pass - bounded, verified,
        // targeted-retry, skip-on-failure. No fallback if it fails; it just
        // doesn't add anything beyond the rooms already built.
        try {
          const roofBounds = elements.filter((e) => e.bbox).reduce((acc, e) => ({
            minX: Math.min(acc.minX, e.bbox!.min[0]), minY: Math.min(acc.minY, e.bbox!.min[1]),
            maxX: Math.max(acc.maxX, e.bbox!.max[0]), maxY: Math.max(acc.maxY, e.bbox!.max[1]),
            topZ: Math.max(acc.topZ, e.bbox!.max[2]),
          }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, topZ: 0 });
          const embellish = await embellishStoreysArchitecturally(storeys, roofBounds, mcpSessionId);
          mcpSessionId = embellish.mcpSessionId;
          embellishResult = { enrichedStoreys: embellish.enrichedStoreys, skippedStoreys: embellish.skippedStoreys, steps: embellish.steps };
          executedTools.push(`execute_ifc_code_tool(embellish x${embellish.enrichedStoreys})`);
        } catch (embErr: any) {
          console.warn("[build_code] Architectural embellishment pass errored (non-fatal):", embErr);
        }
      } else {
        generationError = structuralShellErrors.join(" | ") || "Room-by-room generation failed for every room.";
      }
    }

    // 2. If not executed and a component_specs programme is present
    // (infrastructure split-planning path: qwen3.8-max planned WHAT
    // components to build, in order), build each one itself, in strict
    // sequence, against the real live scene state - same discipline as
    // buildings: no deterministic geometry-type-to-harness-call templating,
    // real verification, targeted retry, honest skip, no fallback. Same
    // deadline/continuation support as buildings - a structure with many
    // components (a real bridge can easily need 15-20+) gets built
    // completely across as many calls as it genuinely needs.
    const isInfraContinuation = continuation && continuation.kind === "infrastructure";
    const componentSpecs = payload.plan?.component_specs || (isInfraContinuation ? continuation.componentSpecs : []) || [];
    if (!executedMutation && Array.isArray(componentSpecs) && componentSpecs.length > 0 && (!continuation || isInfraContinuation)) {
      const startIdx = isInfraContinuation ? continuation.componentIndex : 0;
      console.log(`[build_code] Building ${componentSpecs.length} infrastructure component(s) in sequence, model-authored geometry${isInfraContinuation ? ` - resuming at component ${startIdx + 1}` : ""}...`);
      try {
        const { result, elements: infraElements } = await generateInfrastructureFreeform(
          componentSpecs, mcpSessionId, (msg) => freeformSteps.push(msg),
          isInfraContinuation ? continuation.elements : [],
          startIdx,
          deadline
        );
        mcpSessionId = result.mcpSessionId;
        executedTools.push(`execute_ifc_code_tool(components:${result.builtComponents}/${result.builtComponents + result.skippedComponents})`);

        if (result.stoppedAtIndex !== undefined) {
          return {
            status: "continue",
            executedTools,
            freeformSteps,
            continuation: { kind: "infrastructure", mcpSessionId, elements: infraElements, componentIndex: result.stoppedAtIndex, componentSpecs },
            progress: `Paused at component ${result.stoppedAtIndex + 1}/${componentSpecs.length} - call again with plan.continuation to resume.`
          };
        }

        if (result.builtComponents > 0) {
          executedMutation = true;
        } else {
          generationError = result.steps.filter((s) => s.startsWith("⚠️")).join(" | ") || "Infrastructure component generation failed for every component.";
        }
      } catch (infraErr: any) {
        console.warn("[build_code] Infrastructure generation errored:", infraErr);
        generationError = infraErr?.message || String(infraErr);
      }
    }

    // ═══ NO FALLBACK: fail honestly if nothing was actually generated ═══
    // Previously this fell through to a deterministic template/box synthesis
    // and reported "success" anyway. That is exactly the "stupid structure"
    // behavior that was banned - if qwen3.8-max (direct + self-heal) and the
    // component synthesis both produced nothing, tell the caller the truth.
    if (!executedMutation) {
      return {
        status: "error",
        error: generationError || "glm-5.3 did not produce a usable design and no fallback is configured.",
        executedTools,
        toolAudit,
      };
    }

    // ═══ INCREMENTAL PER-ROOM FURNITURE PASS ═══
    // Adds interior detail room-by-room, each a small bounded generation
    // verified by real execution, with a targeted (not whole-building) retry
    // on failure. Runs on top of whatever structural shell succeeded above -
    // never risks the walls/slabs/doors already built.
    let furnitureResult: { enrichedRooms: number; skippedRooms: number; steps: string[] } | null = null;
    const category = payload.plan?.structure_category || "building";
    const storeyPlansForFurniture = Array.isArray(payload.plan?.storey_plans) ? payload.plan.storey_plans : [];
    // Rooms no longer carry a pre-assigned origin (the model decided
    // placement itself) - recover each room's ACTUAL built extent from the
    // real scene before furnishing, so furniture lands where the room really
    // is, not at a stale/default coordinate.
    if (builtElements.length > 0) {
      for (const storey of storeyPlansForFurniture) {
        for (const room of (Array.isArray(storey.rooms) ? storey.rooms : [])) {
          const real = estimateRoomBounds(String(room.name || ""), builtElements);
          if (real) {
            room.origin = real.origin;
            room.width = real.width;
            room.length = real.length;
          }
        }
      }
    }
    const hasRoomsToFurnish = storeyPlansForFurniture.some((s: any) => Array.isArray(s.rooms) && s.rooms.some((r: any) => Array.isArray(r.origin)));
    if (executedMutation && category !== "infrastructure" && hasRoomsToFurnish) {
      try {
        const furn = await enrichRoomsWithFurniture(storeyPlansForFurniture, mcpSessionId);
        mcpSessionId = furn.mcpSessionId;
        furnitureResult = { enrichedRooms: furn.enrichedRooms, skippedRooms: furn.skippedRooms, steps: furn.steps };
        executedTools.push("execute_ifc_code_tool(furniture x" + furn.enrichedRooms + ")");
      } catch (furnErr: any) {
        console.warn("[build_code] Furniture enrichment pass errored (non-fatal):", furnErr);
      }
    }

    // ═══ REAL QA GATE ═══
    // Runs the reviewer's actual deterministic checks (required element types
    // + genuine pairwise bounding-box clash detection) - not a vague "does
    // this look ok" LLM opinion. On a real FAIL, route through the existing,
    // tested dynamic_edit remediation loop with the SPECIFIC flagged issues,
    // then re-review once to report the true final state honestly.
    let qaReview: any = null;
    if (executedMutation) {
      try {
        qaReview = await handleReviewer({ mcpSessionId, structureCategory: category, plan: payload.plan });
        mcpSessionId = qaReview.mcpSessionId || mcpSessionId;
        if (qaReview.status === "FAIL" && qaReview.retry_required && Array.isArray(qaReview.issues) && qaReview.issues.length > 0) {
          console.log(`[build_code] QA gate found ${qaReview.issues.length} real issue(s); attempting targeted remediation...`);
          try {
            const remediation = await handleBim({
              action: "dynamic_edit",
              mcpSessionId,
              plan: { ...payload.plan, review_required: true, review_issues: qaReview.issues, fix_recommendations: qaReview.fix_recommendations }
            });
            mcpSessionId = remediation.mcpSessionId || mcpSessionId;
            executedTools.push(...(remediation.executedTools || []).map((t: string) => `remediation:${t}`));
          } catch (remErr: any) {
            console.warn("[build_code] QA remediation pass failed (non-fatal):", remErr);
          }
          // Re-review once to report the TRUE final state, not the pre-remediation one.
          try {
            qaReview = await handleReviewer({ mcpSessionId, structureCategory: category, plan: payload.plan });
            mcpSessionId = qaReview.mcpSessionId || mcpSessionId;
          } catch { /* keep pre-remediation review if the re-check itself fails */ }
        }
      } catch (qaErr: any) {
        console.warn("[build_code] QA review pass errored (non-fatal):", qaErr);
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
      freeformSteps,
      furnitureResult,
      embellishResult,
      qaReview,
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

      const glmMsg = await callGLM(glmPrompt, currentPlanData, routedTools, "glm-5.3");
      const toolCalls = glmMsg.tool_calls || [];
      if (toolCalls.length === 0) {
        executionError = "No tool calls were produced.";
        if (tryNum === 3) {
          if (plan?.review_required) {
            remediationWarnings.push("Review remediation produced no tool calls; exported the existing model for re-review.");
            break;
          }
          throw new Error(executionError);
        }
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
