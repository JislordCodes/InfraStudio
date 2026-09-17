import { callQwen, callGLMWithMessages, cleanJsonResponse, mcpCallTool } from "./shared.ts";

/**
 * Strips markdown fences / stray JSON wrapping from a raw code completion,
 * leaving just the Python body.
 */
function extractRawCode(response: string): string {
  let code = (response || "").trim();
  const fenced = code.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim().length > 5) code = fenced[1].trim();
  // Some completions still wrap in {"python_code": "..."} despite instructions - unwrap if so.
  if (code.startsWith("{")) {
    try {
      const parsed = cleanJsonResponse(code);
      if (parsed && typeof parsed.python_code === "string" && parsed.python_code.trim().length > 5) {
        code = parsed.python_code.trim();
      }
    } catch { /* keep as-is */ }
  }
  return code;
}

export interface RoomEnrichmentResult {
  mcpSessionId: string;
  enrichedRooms: number;
  skippedRooms: number;
  steps: string[];
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Used to
 * parallelize the independent Kimi TEXT-generation calls in the incremental
 * passes below - MCP execution against the shared IFC session always stays
 * strictly sequential (interleaving execute_ifc_code_tool calls against one
 * session is not safe), but there is no such constraint on asking Kimi for
 * N rooms' worth of code at once. This is what keeps a 16-room incremental
 * pass inside the Lambda's 900s ceiling instead of serializing 16+ full
 * round trips.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// FREEFORM INCREMENTAL GENERATION - no deterministic layout/geometry code.
// The model decides placement AND shape for every room, one at a time,
// against the REAL live scene state (queried from the MCP server, not
// tracked/assumed) - the same way a human architect builds up a model
// piece by piece, checking each addition against what already exists.
// Verification is real: after each room executes, the scene is re-queried
// and genuinely checked for bounding-box overlap against everything built
// so far. A clash is treated exactly like an execution error - one
// targeted retry with the specific problem, honest skip (with cleanup) if
// it still fails. No deterministic geometry, no fallback design, ever.
// ═══════════════════════════════════════════════════════════════════════

export interface SceneElement {
  name: string;
  ifc_class: string;
  guid?: string;
  bbox: { min: number[]; max: number[] } | null;
}

function parseSceneElements(resultText: string): SceneElement[] {
  let scene: any;
  try { scene = JSON.parse(resultText); } catch { return []; }
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  return objects.map((o: any) => {
    const raw = o?.bbox || o?.bounding_box || o?.bounds;
    let bbox: { min: number[]; max: number[] } | null = null;
    if (Array.isArray(raw) && raw.length >= 6) bbox = { min: raw.slice(0, 3).map(Number), max: raw.slice(3, 6).map(Number) };
    else if (raw?.min && raw?.max) bbox = { min: raw.min.map(Number), max: raw.max.map(Number) };
    return { name: String(o?.name || o?.guid || "element"), ifc_class: String(o?.ifc_class || o?.type || ""), guid: o?.guid ? String(o.guid) : undefined, bbox };
  });
}

async function getSceneElements(sessionId: string): Promise<{ elements: SceneElement[]; sessionId: string; rawText: string }> {
  const res = await mcpCallTool("get_scene_info", { limit: -1, include_bbox: true, include_transform: true }, sessionId);
  return { elements: parseSceneElements(res.resultText), sessionId: res.session, rawText: res.resultText || "" };
}

/**
 * Parses the "BOUNDS_JSON:{...}" line this module injects into every
 * generateInfrastructureFreeform script (via a tracked add_mesh_element
 * wrapper that reads mesh.bounds directly from trimesh at creation time).
 * This is used instead of trusting get_scene_info's own bbox field, which
 * was confirmed (by inspecting its raw response) to omit bbox entirely for
 * elements created via create_box/create_i_beam/create_cylinder +
 * add_mesh_element on this MCP server - the entities are real and correctly
 * typed, just not bbox-indexed by that endpoint.
 */
function extractCapturedBounds(resultText: string): Map<string, { min: number[]; max: number[] }> {
  const map = new Map<string, { min: number[]; max: number[] }>();
  const marker = "BOUNDS_JSON:";
  let searchIn = resultText;
  try {
    const parsed = JSON.parse(resultText);
    if (typeof parsed?.output === "string") searchIn = parsed.output;
  } catch { /* use raw text */ }
  const idx = searchIn.indexOf(marker);
  if (idx < 0) return map;
  try {
    const jsonStr = searchIn.slice(idx + marker.length).trim().split("\n")[0];
    const list = JSON.parse(jsonStr);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item?.name && Array.isArray(item.min) && Array.isArray(item.max)) {
          map.set(String(item.name), { min: item.min.map(Number), max: item.max.map(Number) });
        }
      }
    }
  } catch { /* malformed - leave map empty */ }
  return map;
}

function describeExisting(elements: SceneElement[]): string {
  const withBounds = elements.filter((e) => e.bbox);
  if (withBounds.length === 0) return "(nothing built yet - this is the first element in the building)";
  return withBounds
    .map((e) => `- "${e.name}" (${e.ifc_class}): bbox min[${e.bbox!.min.map((n) => n.toFixed(2)).join(",")}] max[${e.bbox!.max.map((n) => n.toFixed(2)).join(",")}]`)
    .join("\n");
}

function diffNewElements(before: SceneElement[], after: SceneElement[]): SceneElement[] {
  const beforeGuids = new Set(before.map((e) => e.guid).filter(Boolean));
  return after.filter((e) => e.guid && !beforeGuids.has(e.guid));
}

/**
 * Real pairwise AABB overlap check - same math as agent-reviewer's
 * deterministicReview, applied here as a live verification oracle (not a
 * geometry generator). `threshold` is the overlap-volume fraction (of the
 * smaller element) that counts as a clash - rooms use a tight 0.25 (any
 * meaningful overlap is wrong), infrastructure uses a much looser value
 * since structural contact (a deck resting on a pier cap, a pier meeting
 * its footing) is normal and expected, not an error.
 */
function findClashes(before: SceneElement[], newOnes: SceneElement[], threshold: number = 0.25): string[] {
  const clashes: string[] = [];
  for (const n of newOnes) {
    if (!n.bbox) continue;
    const nVol = (n.bbox.max[0] - n.bbox.min[0]) * (n.bbox.max[1] - n.bbox.min[1]) * (n.bbox.max[2] - n.bbox.min[2]);
    for (const p of before) {
      if (!p.bbox) continue;
      const overlap = [0, 1, 2].map((ax) => Math.max(0, Math.min(n.bbox!.max[ax], p.bbox!.max[ax]) - Math.max(n.bbox!.min[ax], p.bbox!.min[ax])));
      const overlapVol = overlap[0] * overlap[1] * overlap[2];
      const pVol = (p.bbox.max[0] - p.bbox.min[0]) * (p.bbox.max[1] - p.bbox.min[1]) * (p.bbox.max[2] - p.bbox.min[2]);
      if (overlapVol > 0.15 && overlapVol / Math.max(0.001, Math.min(nVol, pVol)) > threshold) {
        clashes.push(`"${n.name}" overlaps existing "${p.name}"`);
      }
    }
  }
  return [...new Set(clashes)];
}

/**
 * Since rooms no longer carry a pre-assigned origin (the model decides
 * placement itself), this recovers each room's ACTUAL built extent from the
 * real scene by unioning the bounding boxes of every element whose name
 * carries that room's name as a prefix (see requirement 5 in the freeform
 * room prompt below). Used to ground the furniture pass in reality instead
 * of stale/default coordinates.
 */
export function estimateRoomBounds(roomName: string, elements: SceneElement[]): { origin: number[]; width: number; length: number } | null {
  const needle = roomName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = elements.filter((e) => e.bbox && e.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle));
  if (matches.length === 0) return null;
  const minX = Math.min(...matches.map((e) => e.bbox!.min[0]));
  const minY = Math.min(...matches.map((e) => e.bbox!.min[1]));
  const minZ = Math.min(...matches.map((e) => e.bbox!.min[2]));
  const maxX = Math.max(...matches.map((e) => e.bbox!.max[0]));
  const maxY = Math.max(...matches.map((e) => e.bbox!.max[1]));
  return { origin: [minX, minY, minZ], width: Math.max(0.5, maxX - minX), length: Math.max(0.5, maxY - minY) };
}

const FREEFORM_ROOM_SYSTEM_PROMPT = `You are an autonomous architect writing a complete Python script to build ONE room of a larger building that is being constructed incrementally, piece by piece - exactly the way a skilled human architect works: build one part, look at what you've made, then place and shape the next part to fit.

EXECUTION ENVIRONMENT (AWS Bonsai MCP Server):
- Python 3.11 with ifcopenshell, ifcopenshell.api as api, trimesh, numpy as np, math pre-imported.
- ifc = get_ifc_file()
- The building and this storey already exist. Get the storey with the exact lookup snippet given in the task below - do not create a new one.
- InfraStudioHarness(ifc, storey) gives high-level primitives. IMPORTANT: create_wall/create_slab/create_stairs return a trimesh MESH ONLY - they do NOT take a name/ifc_class/material argument and creating one does not by itself add it to the IFC file. You MUST pass that mesh to add_mesh_element to actually name it and commit it as a real IFC entity. Correct usage:
    wall_mesh = h.create_wall([x1,y1], [x2,y2], height=3.2, thickness=0.25, z_bottom=0.0, openings=[{"offset":1.0,"width":0.9,"height":2.1,"sill_height":0.0}])
    h.add_mesh_element(wall_mesh, "RoomName_Wall_1", ifc_class="IfcWall", mat_name="...", rgb=(r,g,b))
    slab_mesh = h.create_slab([[x1,y1],[x2,y1],[x2,y2],[x1,y2]], thickness=0.25, z_elevation=0.0)
    h.add_mesh_element(slab_mesh, "RoomName_Floor", ifc_class="IfcSlab", mat_name="...", rgb=(r,g,b))
  h.add_door(p1,p2,offset,width,height,z_bottom,name) and h.add_window(p1,p2,offset,width,height,sill_height,z_bottom,name) DO take a name directly and commit themselves - no add_mesh_element needed for these two. Also available: h.add_column, h.add_beam, h.add_railing, h.create_stairs (same mesh-then-add_mesh_element pattern as walls/slabs). Finish with: count = h.commit().
- For ANY custom/creative geometry beyond the plain primitives above (curved walls, angled/non-rectangular footprints, bay windows, lofted or parametric forms) - build it as a trimesh mesh (trimesh.Trimesh(vertices=..., faces=...), trimesh.creation.extrude_polygon, boolean unions, or your own numpy vertex/face arrays) and add it with h.add_mesh_element(mesh, name, ifc_class, mat_name, rgb). This is the reliable, tested path for real architectural creativity - a plain rectangular room is the acceptable MINIMUM, never the goal.
- Do NOT hand-construct raw ifcopenshell entities yourself (ifc.create_entity("IfcCartesianPoint", ...), IfcPolyline, IfcExtrudedAreaSolid, etc.) - that low-level API has strict type requirements that are easy to get subtly wrong and hard to debug. Everything you'd want to build this way is achievable via trimesh + h.add_mesh_element instead.
- End with: save_and_load_ifc() (and count = h.commit() if you used the harness).
- Do NOT import os/sys/subprocess. Do NOT define custom classes. Do NOT recreate the project/site/building/storey/contexts - they exist already.

YOUR TASK: design and build ONE room, deciding its exact position, shape, and openings yourself.
HARD REQUIREMENTS - a "room" that skips any of these is not a room, it is decoration:
1. It MUST have real enclosing walls (IfcWall, created via h.create_wall(...) or equivalent solid ifcopenshell/trimesh geometry) actually bounding the space on every side that isn't shared with an adjacent room. Columns, beams, and railings are NOT a substitute for walls.
2. It MUST have a real floor slab (IfcSlab, via h.create_slab(...) or equivalent) under it.
3. Do not overlap any existing element - check the bounding boxes listed below and place/shape this room to avoid collision.
4. This room must physically connect to the building - share a wall or sit directly adjacent to at least one existing room (skip this only if this is explicitly the first room).
5. Give the room at least one door - to an adjacent room if it connects internally, or to the exterior otherwise.
6. Give the room at least one window on any exterior-facing wall.
7. Name every element you create with this room's name as a prefix (e.g. "<RoomName>_Wall_1", "<RoomName>_Floor") so downstream tooling can identify which elements belong to this room.
8. Columns/beams/railings/custom creative flourishes are welcome IN ADDITION to the walls+slab above, never instead of them.

Return ONLY the raw Python script. No markdown fences, no JSON, no explanation.`;

export interface FreeformBuildResult {
  mcpSessionId: string;
  builtRooms: number;
  skippedRooms: number;
  steps: string[];
  /** Set when a deadline stopped generation before this storey finished - resume this storey at this room index. */
  stoppedAtRoomIndex?: number;
}

/**
 * Builds one storey's IfcBuildingStorey container (administrative hierarchy
 * only - no shape/placement decision, same as initialize_project already
 * creating the building itself) then hands every room to the model, one at
 * a time, in strict sequence (each room needs to see what the previous one
 * built, so this cannot be parallelized like furniture/embellishment can).
 *
 * `startRoomIndex` / `skipStoreyCreation` support resuming a storey that a
 * previous invocation stopped partway through (see `deadline`). `deadline`
 * (epoch ms) is checked before each room; if there isn't enough time left
 * for another model round-trip, generation stops cleanly and reports
 * exactly which room to resume at - never a mid-request timeout crash.
 */
export async function generateStoreyFreeform(
  storey: any,
  sIdx: number,
  runningElements: SceneElement[],
  initialSessionId: string,
  onStep: (msg: string) => void = () => {},
  startRoomIndex: number = 0,
  skipStoreyCreation: boolean = false,
  deadline: number = 0
): Promise<{ result: FreeformBuildResult; elements: SceneElement[] }> {
  const steps: string[] = [];
  let sessionId = initialSessionId;
  let elements = runningElements;
  let builtRooms = 0;
  let skippedRooms = 0;

  const storeyName = String(storey.name || `Level ${sIdx + 1}`).replace(/['"\\]/g, "");
  const elevation = Number(storey.elevation ?? sIdx * 3.2);
  const height = Number(storey.height || 3.2);
  const rooms = Array.isArray(storey.rooms) ? storey.rooms : [];
  const storeyLookup = `storeys = ifc.by_type("IfcBuildingStorey")\nstorey = next((s for s in storeys if abs(float(s.Elevation or 0) - (${elevation})) < 0.05), storeys[0] if storeys else None)`;

  if (!skipStoreyCreation) {
    const createStoreyCode = `ifc = get_ifc_file()
buildings = ifc.by_type('IfcBuilding')
building = buildings[0] if buildings else api.run('root.create_entity', ifc, ifc_class='IfcBuilding', name="Structure")
_st = api.run('root.create_entity', ifc, ifc_class='IfcBuildingStorey', name="${storeyName}")
api.run('geometry.edit_object_placement', ifc, product=_st, matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,${elevation},1]])
api.run('aggregate.assign_object', ifc, relating_object=building, products=[_st])
save_and_load_ifc()
print("Storey container created.")
`;
    try {
      const r = await mcpCallTool("execute_ifc_code_tool", { code: createStoreyCode }, sessionId);
      sessionId = r.session;
    } catch (err: any) {
      steps.push(`❌ Failed to create the "${storeyName}" storey container: ${err?.message || err}`);
      onStep(steps[steps.length - 1]);
      return { result: { mcpSessionId: sessionId, builtRooms: 0, skippedRooms: rooms.length, steps }, elements };
    }
  }

  for (let rIdx = startRoomIndex; rIdx < rooms.length; rIdx++) {
    if (deadline && Date.now() > deadline) {
      onStep(`⏸️ Pausing "${storeyName}" before room ${rIdx + 1}/${rooms.length} - out of time this invocation, will resume.`);
      return { result: { mcpSessionId: sessionId, builtRooms, skippedRooms, steps, stoppedAtRoomIndex: rIdx }, elements };
    }
    const room = rooms[rIdx];
    const name = String(room.name || "Room").replace(/['"\\]/g, "");
    const w = Number(room.width || 4);
    const l = Number(room.length || 4);
    const isFirst = elements.length === 0;

    const userPrompt = `Storey: "${storeyName}" at elevation z=${elevation.toFixed(2)}m, ceiling height ${height.toFixed(2)}m. Get it with:\n${storeyLookup}\n\nRoom to build: "${name}", approximate target size ${w.toFixed(1)}m x ${l.toFixed(1)}m (deviate if the design calls for it).\n${isFirst ? "This is the FIRST room in the building - place it starting near the origin (0,0)." : `EXISTING ELEMENTS ALREADY BUILT (avoid overlapping any of these; connect to at least one):\n${describeExisting(elements)}`}`;

    let code = "";
    let lastError = "";
    let success = false;
    let ranOutOfTime = false;
    let attemptedGuidsToClean: string[] = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      // A retry attempt itself can take ~150-250s (model call + MCP execute/verify).
      // If we're already past the deadline, don't start it - pause here and retry
      // this exact room fresh next invocation, rather than burning the invocation's
      // last seconds on a second attempt that risks a hard AWS kill mid-call.
      if (attempt === 2 && deadline && Date.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      try {
        const msg = attempt === 1
          ? userPrompt
          : `${userPrompt}\n\nYOUR PREVIOUS ATTEMPT FAILED: ${lastError}\n\nYOUR PREVIOUS CODE:\n${code}\n\nFirst remove your previous attempt's elements so they don't linger as junk, then build the corrected version:\nfor _g in ${JSON.stringify(attemptedGuidsToClean)}:\n    try:\n        api.run("root.remove_product", ifc, product=ifc.by_guid(_g))\n    except Exception:\n        pass\nThen write the corrected, non-overlapping script (return the FULL script including this cleanup, then your fix).`;
        const raw = await callQwen(FREEFORM_ROOM_SYSTEM_PROMPT, msg, false, "glm-5.3", 150000, "high", 8000);
        code = extractRawCode(raw);
        if (!code || code.length < 20) throw new Error(lastError || "Model returned empty/unusable code");

        const before = elements;
        const res = await mcpCallTool("execute_ifc_code_tool", { code }, sessionId);
        sessionId = res.session;

        const after = await getSceneElements(sessionId);
        sessionId = after.sessionId;
        const newOnes = diffNewElements(before, after.elements);
        const clashes = findClashes(before, newOnes);

        if (clashes.length > 0) {
          attemptedGuidsToClean = newOnes.map((e) => e.guid!).filter(Boolean);
          lastError = `Geometry clash: ${clashes.join("; ")}`;
          continue;
        }

        // Real verification of hard requirements 1-2, not just prompt text:
        // a "room" with no wall or no slab is decoration, not a room.
        const hasWall = newOnes.some((e) => /ifcwall/i.test(e.ifc_class));
        const hasSlab = newOnes.some((e) => /ifcslab/i.test(e.ifc_class));
        if (!hasWall || !hasSlab) {
          attemptedGuidsToClean = newOnes.map((e) => e.guid!).filter(Boolean);
          const missing = [!hasWall ? "an IfcWall" : null, !hasSlab ? "an IfcSlab" : null].filter(Boolean).join(" and ");
          lastError = `Your script ran without error but did not create ${missing}. Columns/beams/doors/windows alone are not a room - it needs real enclosing walls and a floor slab.`;
          continue;
        }

        elements = after.elements;
        success = true;
        break;
      } catch (err: any) {
        lastError = (err?.message || String(err)).slice(0, 500);
      }
    }

    if (success) {
      builtRooms++;
      const msg = `🏗️ Built "${name}"`;
      steps.push(msg);
      onStep(msg);
    } else if (ranOutOfTime) {
      // Best-effort cleanup of the failed attempt's orphaned geometry, then pause
      // and retry this exact room fresh next invocation - this is not a skip.
      if (attemptedGuidsToClean.length > 0) {
        const cleanupCode = `ifc = get_ifc_file()\nfor _g in ${JSON.stringify(attemptedGuidsToClean)}:\n    try:\n        api.run("root.remove_product", ifc, product=ifc.by_guid(_g))\n    except Exception:\n        pass\nsave_and_load_ifc()\n`;
        try {
          const cleanupRes = await mcpCallTool("execute_ifc_code_tool", { code: cleanupCode }, sessionId);
          sessionId = cleanupRes.session;
        } catch { /* best-effort only */ }
      }
      const msg = `⏸️ Pausing "${storeyName}" before room ${rIdx + 1}/${rooms.length} - out of time this invocation, will resume.`;
      steps.push(msg);
      onStep(msg);
      return { result: { mcpSessionId: sessionId, builtRooms, skippedRooms, steps, stoppedAtRoomIndex: rIdx }, elements };
    } else {
      // Best-effort cleanup of any orphaned geometry from the failed
      // attempts - this is deletion/bookkeeping, not a fallback design.
      if (attemptedGuidsToClean.length > 0) {
        const cleanupCode = `ifc = get_ifc_file()\nfor _g in ${JSON.stringify(attemptedGuidsToClean)}:\n    try:\n        api.run("root.remove_product", ifc, product=ifc.by_guid(_g))\n    except Exception:\n        pass\nsave_and_load_ifc()\n`;
        try {
          const cleanupRes = await mcpCallTool("execute_ifc_code_tool", { code: cleanupCode }, sessionId);
          sessionId = cleanupRes.session;
        } catch { /* best-effort only */ }
      }
      skippedRooms++;
      const msg = `⚠️ Skipped "${name}" after 2 attempts: ${lastError}`;
      steps.push(msg);
      onStep(msg);
      console.warn(`[generateStoreyFreeform] ${msg}`);
    }
  }

  return { result: { mcpSessionId: sessionId, builtRooms, skippedRooms, steps }, elements };
}

const FREEFORM_ROOF_SYSTEM_PROMPT = `You are an autonomous architect writing a complete Python script to design and build the ROOF of a building whose full footprint already exists (see the elements below).
EXECUTION ENVIRONMENT: same as building rooms - ifc = get_ifc_file(), InfraStudioHarness(ifc, storey) available (h.create_roof(footprint_2d, roof_type, height, z_elevation, thickness) covers gable/hip/shed forms). For anything more creative (curved/vaulted, butterfly, asymmetric, custom-profiled), build it as a trimesh mesh (trimesh.Trimesh, trimesh.creation, numpy vertex/face arrays) and add it with h.add_mesh_element(mesh, name, "IfcRoof", mat_name, rgb) - this is the reliable, tested path. Do NOT hand-construct raw ifcopenshell entities (IfcCartesianPoint, IfcPolyline, IfcExtrudedAreaSolid, etc.) - that low-level API has strict type requirements that are easy to get subtly wrong. You have complete creative freedom over the roof FORM within these tools - a flat slab with no articulation is the acceptable minimum, never the goal.
Get the top storey with: storeys = ifc.by_type("IfcBuildingStorey"); storey = max(storeys, key=lambda s: float(s.Elevation or 0))
Do not overlap or intersect any existing wall/room below the roofline. End with save_and_load_ifc().
Return ONLY the raw Python script. No markdown, no JSON, no explanation.`;

export interface FreeformRoofResult {
  mcpSessionId: string;
  success: boolean;
  steps: string[];
}

export async function generateRoofFreeform(
  roofType: string,
  elements: SceneElement[],
  initialSessionId: string,
  onStep: (msg: string) => void = () => {}
): Promise<FreeformRoofResult> {
  const steps: string[] = [];
  let sessionId = initialSessionId;
  const userPrompt = `Desired roof style/concept: "${roofType || "whatever best suits the design"}".\n\nEXISTING ELEMENTS ALREADY BUILT (the full building below the roofline):\n${describeExisting(elements)}`;

  let code = "";
  let lastError = "";
  let success = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const msg = attempt === 1 ? userPrompt : `${userPrompt}\n\nYOUR PREVIOUS ATTEMPT FAILED WITH THIS ERROR:\n${lastError}\n\nYOUR PREVIOUS CODE:\n${code}\n\nFix the specific problem and return the corrected full script.`;
      const raw = await callQwen(FREEFORM_ROOF_SYSTEM_PROMPT, msg, false, "glm-5.3", 150000, "high", 8000);
      code = extractRawCode(raw);
      if (!code || code.length < 20) throw new Error(lastError || "Model returned empty/unusable code");
      const res = await mcpCallTool("execute_ifc_code_tool", { code }, sessionId);
      sessionId = res.session;
      success = true;
      break;
    } catch (err: any) {
      lastError = (err?.message || String(err)).slice(0, 500);
    }
  }

  if (success) {
    steps.push("🏛️ Roof built");
    onStep(steps[0]);
  } else {
    steps.push(`⚠️ Skipped roof after 2 attempts: ${lastError}`);
    onStep(steps[0]);
    console.warn(`[generateRoofFreeform] ${steps[0]}`);
  }

  return { mcpSessionId: sessionId, success, steps };
}

const INFRA_COMPONENT_SYSTEM_PROMPT = `You are an autonomous structural engineer writing Python code to build ONE component of a larger engineering structure that is being constructed incrementally, in build order - exactly the way a real engineer works: build one part, see what's actually there, then shape and place the next part to connect to it correctly.

EXECUTION ENVIRONMENT (AWS Bonsai MCP Server): already set up for you before your code runs - ifc, api, trimesh, np, math, and h (an InfraStudioHarness already bound to the active storey) all exist. Do NOT get the storey yourself, do NOT call h.commit() or save_and_load_ifc() - all of that happens automatically after your code runs. Write ONLY the lines that create this component's geometry.

h gives structural primitives - every one returns a trimesh MESH ONLY (no name/material argument, does not by itself add anything to the IFC file) - you MUST pass it to add_mesh_element to actually name, style, and commit it:
    mesh = h.create_box(extents=[l,w,h], pos=[x,y,z], rot_z_deg=0.0)                       # footings, slabs, generic blocks
    mesh = h.create_cylinder(radius=r, height=h, pos=[x,y,z], axis=[0,0,1])                # columns, piles, round piers
    mesh = h.create_i_beam(depth=d, flange_w=fw, length=l, pos=[x,y,z], rot_z_deg=0.0)     # girders, walers
    mesh = h.create_pipe(outer_r=ro, inner_r=ri, height=h, pos=[x,y,z], axis=[0,0,1])      # struts, rails
    mesh = h.create_corrugated_panel(width=w, height=h, depth=d, pitch=p, thickness=t, pos=[x,y,z], rot_z_deg=0.0)  # sheet piles
    mesh = h.create_cutwater_pier(length=l, width=w, height=h, nose_r=r, pos=[x,y,z], rot_z_deg=0.0)  # hydrodynamic bridge piers
    h.add_mesh_element(mesh, "ComponentName_Part", ifc_class="IfcColumn", mat_name="...", rgb=(r,g,b), transparency=0.0)
For ANY custom/creative geometry beyond these primitives - curved or tapered members, a rising/curving/descending deck segment, lofted or parametric forms, custom cross-sections swept along a path - build it directly as a trimesh mesh (trimesh.Trimesh(vertices=..., faces=...), trimesh.creation.extrude_polygon, a loop generating cross-section rings along a numpy/parametric centerline and stitching them into faces, etc.) and add it the same way: h.add_mesh_element(mesh, name, ifc_class, mat_name, rgb). This is the reliable, tested path for genuine engineering creativity - do not settle for a generic box when the design calls for something more expressive.
Do NOT hand-construct raw ifcopenshell entities yourself (ifc.create_entity("IfcCartesianPoint", ...), IfcPolyline, IfcExtrudedAreaSolid, etc.) - that low-level API has strict type requirements that are easy to get subtly wrong. Do NOT import os/sys/subprocess. Do NOT define custom classes.

KEEP IT FOCUSED: a real component is typically 1-4 solid shapes (e.g. a footing is one box, maybe two if it has a distinct key/step - not a dozen incidental ledges, chamfers, or bolt details). Spend your effort getting the shape, position, and connection to what's already built right, not on surface ornamentation. Your response has a strict length budget - an elaborate script that gets cut off before finishing is worse than a simple one that completes.

YOUR TASK: design and build ONE structural component, deciding its exact position, dimensions, and shape yourself, consistent with its stated role relative to what's already built.
HARD REQUIREMENTS:
1. It MUST create at least one real, non-degenerate solid IFC element (via add_mesh_element with a proper ifc_class like IfcColumn/IfcBeam/IfcFooting/IfcSlab/IfcMember/IfcWall/IfcBuildingElementProxy) with genuine volume - not a zero-size point or an empty gesture.
2. It must be positioned and shaped to fulfil its stated role relative to the existing elements below (e.g. a pier sits on its footing; a deck segment continues smoothly from the previous segment's end and rests on its supporting pier(s); a parapet follows the deck edge). Read the existing elements' bounding boxes to figure out where things actually ended up, not just where you assumed.
3. Use a real, specific engineering material name and realistic rgb color.
4. Name every element you create with this component's name as a prefix (e.g. "<ComponentName>_Main", "<ComponentName>_Detail_1") so downstream tooling can identify which elements belong to it.
5. Structural contact/support between components (resting on, bolted to, continuing from) is expected and fine - this is not a room-packing problem, components are SUPPOSED to physically connect. Only avoid nonsensical full duplication of something already built.

Return ONLY the raw Python script body (no storey lookup, no commit/save, no markdown fences, no JSON, no explanation).`;

// ═══════════════════════════════════════════════════════════════════════
// AGENTIC TOOL-USE BUILD - the model drives execute_ifc_code/get_scene_info
// itself, in a real multi-turn loop, seeing the REAL result of every call it
// makes and correcting itself, instead of writing one blind script against a
// static text description and getting one retry. This is the same loop
// discipline used when a human (or Claude) drives the MCP server directly:
// place something, check what actually landed, fix it if wrong, move on.
// Verified live that qwen3.8-2.4t-a95b genuinely supports function-calling
// against this DashScope endpoint before this was built on top of it.
// ═══════════════════════════════════════════════════════════════════════

const AGENTIC_TOOLS = [
  {
    type: "function",
    function: {
      name: "execute_ifc_code",
      description: `Run Python that creates real IFC geometry. The environment (ifc, api, trimesh, np, math, h) is already set up - write ONLY the lines that create geometry. Do NOT get the storey yourself, do NOT call h.commit()/save_and_load_ifc() - that happens automatically after your code runs. You get back the REAL result: on success, the exact bounding box of every element you just created (check it matches what you intended - fix it with another call if not); on failure, the real error text.

h's primitives - EXACT signatures, all keyword args, copy these precisely:
  mesh = h.create_box(extents=[length_x, width_y, height_z], pos=[cx, cy, cz], rot_z_deg=0.0)   # pos is the CENTER
  mesh = h.create_cylinder(radius=r, height=hgt, pos=[cx, cy, cz], axis=[0,0,1])                 # pos is the CENTER
  mesh = h.create_i_beam(depth=d, flange_w=fw, length=l, pos=[x0, y0, z0], rot_z_deg=0.0)        # pos is the START of the length axis, NOT the center - the beam extrudes from pos in the +local-x direction (rotated by rot_z_deg) for the given length
  mesh = h.create_pipe(outer_r=ro, inner_r=ri, height=hgt, pos=[cx, cy, cz], axis=[0,0,1])
  mesh = h.create_corrugated_panel(width=w, height=hgt, depth=d, pitch=p, thickness=t, pos=[cx, cy, cz], rot_z_deg=0.0)
  mesh = h.create_cutwater_pier(length=l, width=w, height=hgt, nose_r=r, pos=[cx, cy, cz], rot_z_deg=0.0)
Then ALWAYS: h.add_mesh_element(mesh, "Name", ifc_class="IfcBeam", mat_name="Material Name", rgb=(r,g,b))
For a member that must slope and/or curve (following a real alignment between two 3D points, not level/straight) build a custom oriented box yourself with trimesh: compute the direction vector between your two endpoints, a horizontal perpendicular vector, and an up vector, place 8 corner vertices and 12 triangular faces, then trimesh.Trimesh(vertices=..., faces=...) and add_mesh_element it the same way - this is the reliable way to represent a real curved/sloped span, not create_i_beam (which is straight and level only).
If you are building MANY similar/repeated elements (e.g. piers along an alignment, girder segments, deck slabs), write a Python loop that computes each position from your own alignment formulas and calls the primitives inside the loop - one execute_ifc_code call can and should create dozens of elements this way, rather than one call per element.
Do NOT hand-construct raw ifcopenshell entities (ifc.create_entity("IfcCartesianPoint", ...), IfcPolyline, IfcExtrudedAreaSolid, etc.) - that low-level API has strict type requirements that are easy to get subtly wrong. Do NOT import os/sys/subprocess.`,
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "Python code body only - no storey lookup, no commit/save, no markdown fences, no explanation." } },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_scene_info",
      description: "Get the real, current list of every element that exists so far, with names, IFC classes, and real bounding boxes. Call this whenever you need to check exactly where an existing element actually ended up before placing or aligning something against it - never assume a position from memory.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

const AGENTIC_INFRA_SYSTEM_PROMPT = `You are an autonomous structural engineer building ONE component of a larger engineering structure, with real tools - not writing code blind and hoping.

You have two tools:
- get_scene_info: see the REAL current elements and their REAL bounding boxes. Call this when you're not certain exactly where an existing element ended up - never guess or rely on a description from earlier in the conversation.
- execute_ifc_code: run Python that creates geometry (h.create_box/create_cylinder/create_i_beam/create_pipe/create_corrugated_panel/create_cutwater_pier + h.add_mesh_element, or a custom trimesh mesh for creative/curved shapes). You get back the REAL bounding box of what you just created, or the real error. If it's wrong, call execute_ifc_code again with a fix. If something is missing, add it with another call. Do NOT hand-construct raw ifcopenshell entities (IfcCartesianPoint, IfcPolyline, IfcExtrudedAreaSolid, etc.) - use h's primitives or a trimesh mesh instead, that low-level API has strict type requirements that are easy to get subtly wrong.

Work the way a real engineer works: check what's there if you're unsure, place something, verify it actually landed where you meant by reading the real bounding box you get back, fix it if not, and only stop once you're confident it's genuinely right. You have a limited number of tool calls - be efficient, don't call get_scene_info more than once or twice, and don't make more execute_ifc_code calls than you actually need.

HARD REQUIREMENTS for the component:
1. At least one real, non-degenerate solid IFC element (via add_mesh_element with a proper ifc_class like IfcColumn/IfcBeam/IfcFooting/IfcSlab/IfcMember/IfcWall/IfcBuildingElementProxy) with genuine volume.
2. Positioned and shaped to fulfil its stated role relative to existing elements - e.g. a pier sits on its footing; a deck segment continues from the previous one's end and rests on its support(s). Structural contact (resting on, bolted to, continuing from) is expected and correct here - only avoid nonsensical full duplication of something already built.
3. A real, specific engineering material name and realistic rgb color.
4. Every element named with this component's name as a prefix (e.g. "<ComponentName>_Main", "<ComponentName>_Detail_1").

When you are confident the component is correctly built and verified against its real bounding box, reply with a short final summary of what you built and STOP calling tools - a plain text reply with no tool call is how the system knows you're done.`;

export const AGENTIC_GRAND_STRUCTURE_SYSTEM_PROMPT = `You are an autonomous structural engineer designing AND building an entire real, complex engineering structure from a brief - not one small piece of it. You decide the whole design yourself: the alignment (does it curve? rise and fall? how long?), the span/pier breakdown, every dimension, every material - then build it for real, verifying as you go, using your tools.

You have two tools:
- get_scene_info: see the REAL current elements and their REAL bounding boxes. Use this to check your own earlier work when you're not certain exactly where something ended up.
- execute_ifc_code: run Python that creates geometry (see its own description for the harness's exact function signatures). You get back the REAL bounding box of everything you just created, or the real error - use this to verify every batch actually landed where you intended before moving to the next part.

HOW TO APPROACH A STRUCTURE THIS SIZE - this is the difference between succeeding and running out of calls:
1. First, DESIGN the whole thing on paper (in your own reasoning, before writing any code): pick real numbers for total length, curve radius/sweep, rise-and-fall profile, span length, pier count, cross-section width and girder count. Make sure the numbers are internally consistent (e.g. total length = span length x number of spans).
2. Then, in your FIRST execute_ifc_code call, write PARAMETRIC PYTHON: define plain functions for your alignment (e.g. a function giving the real X,Y,Z and heading at any distance s along the structure - use math.sin/cos for curves and a smooth rise-and-fall profile, not hard-coded per-point numbers), plus a helper for building a box that follows a sloped/curved line between two real 3D points (see the execute_ifc_code tool description for how). Just define these functions in this first call and print a sanity check of a few stations - don't build geometry yet.
3. In every call after that, use loops over your own alignment functions to build many real elements at once - all piers in one or two calls, all girders in one or two calls, all deck slabs in one call, etc. A single call creating 50-150 elements via a loop is normal and expected for a structure this size - do NOT try to build it one element per call, you will run out of tool calls long before finishing.
4. Verify with get_scene_info or by reading the real bounding boxes returned after each batch - especially that spans actually connect (no gaps, no floating pieces) and that pier heights vary correctly with your rise-and-fall profile.
5. This needs to be a GENUINELY large, detailed structure - many piers/spans, a full cross-section (multiple girders, deck slab, wearing surface, barriers/railings, bearings, diaphragms, expansion joints, drainage) - real quantity and real detail, not a token gesture with 5-10 elements.

You have a real but limited number of tool calls for this. Budget them: a few for design/alignment functions, then large batched loop calls for each category of repeated element. When you are confident the whole structure is built and verified, reply with a final summary (total element count, span count, length) and STOP calling tools.`;

function defaultInfraCodeWrap(code: string): string {
  return `import json
ifc = get_ifc_file()
storeys = ifc.by_type("IfcBuildingStorey")
storey = storeys[0] if storeys else None
h = InfraStudioHarness(ifc, storey)
_captured_bounds = []
_orig_add_mesh_element = h.add_mesh_element
def _tracked_add_mesh_element(mesh, name, *args, **kwargs):
    try:
        b = mesh.bounds
        _captured_bounds.append({"name": name, "min": [float(v) for v in b[0]], "max": [float(v) for v in b[1]]})
    except Exception:
        pass
    return _orig_add_mesh_element(mesh, name, *args, **kwargs)
h.add_mesh_element = _tracked_add_mesh_element

${code}

count = h.commit()
save_and_load_ifc()
print("BOUNDS_JSON:" + json.dumps(_captured_bounds))
`;
}

export interface AgenticBuildResult {
  mcpSessionId: string;
  newElements: SceneElement[];
  success: boolean;
  iterations: number;
  transcript: string[];
  lastError: string;
  /** Full conversation so far - pass back as opts.initialMessages to resume this
   * exact session (with everything the model has already learned about the
   * harness's real API conventions) in a later invocation instead of starting
   * a fresh, memory-less conversation. */
  messages: any[];
  /** True if the loop stopped because of maxIterations/deadline while the
   * model still had tool calls to make - i.e. genuinely unfinished, not done. */
  stoppedEarly: boolean;
}

/**
 * Runs one component/piece as a real multi-turn tool-calling agent: the model
 * itself decides when to call get_scene_info vs execute_ifc_code, sees the
 * REAL result of every call (bounding boxes or the real error), and can
 * correct itself across several calls - instead of one blind script against a
 * static text description with a single retry. No deterministic geometry or
 * fallback anywhere in this path; a component that still isn't right when the
 * loop ends is reported honestly by the caller, same as before.
 */
export async function runAgenticComponentBuild(
  systemPrompt: string,
  taskPrompt: string,
  initialSessionId: string,
  runningElements: SceneElement[],
  onStep: (msg: string) => void = () => {},
  opts: { model?: string; maxIterations?: number; deadline?: number; wrapCode?: (code: string) => string; initialMessages?: any[]; maxTokens?: number; callTimeoutMs?: number } = {}
): Promise<AgenticBuildResult> {
  const model = opts.model || "glm-5.3";
  const maxIterations = opts.maxIterations ?? 6;
  const deadline = opts.deadline || 0;
  const wrapCode = opts.wrapCode || defaultInfraCodeWrap;
  // GLM-5.2 is a thinking model - it spends tokens on reasoning_content before
  // content, so the budget needs more headroom than a non-reasoning model did
  // or replies come back truncated with empty content (finish_reason=length).
  const maxTokens = opts.maxTokens ?? 8000;
  const callTimeoutMs = opts.callTimeoutMs ?? 150000;

  let sessionId = initialSessionId;
  let elements = runningElements;
  const startCount = elements.length;
  const transcript: string[] = [];
  let lastError = "";
  let stoppedEarly = false;
  const messages: any[] = opts.initialMessages && opts.initialMessages.length > 0
    ? opts.initialMessages
    : [{ role: "user", content: taskPrompt }];

  for (let iter = 0; iter < maxIterations; iter++) {
    if (deadline && Date.now() > deadline) { transcript.push("(stopped: out of time this invocation)"); stoppedEarly = true; break; }

    let assistantMsg: any;
    try {
      assistantMsg = await callGLMWithMessages([{ role: "system", content: systemPrompt }, ...messages], AGENTIC_TOOLS, model, maxTokens, callTimeoutMs);
    } catch (err: any) {
      lastError = err?.message || String(err);
      transcript.push(`⚠️ model call failed: ${lastError}`);
      stoppedEarly = true;
      break;
    }

    messages.push({ role: "assistant", content: assistantMsg.content || "", tool_calls: assistantMsg.tool_calls });

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      transcript.push(`✅ model finished: ${(assistantMsg.content || "(no summary given)").slice(0, 200)}`);
      break;
    }

    if (iter === maxIterations - 1) stoppedEarly = true;

    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function?.name;
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* leave empty */ }

      if (toolName === "get_scene_info") {
        const content = elements.length > 0 ? describeExisting(elements) : "(nothing built yet - this is the first element)";
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        onStep(`🔍 model checked the real scene (${elements.length} elements so far)`);
        continue;
      }

      if (toolName === "execute_ifc_code") {
        const code = String(args.code || "");
        if (!code.trim()) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "Error: empty code." });
          continue;
        }
        // Log the model's actual submitted code (full, not truncated) - so a
        // real question like "did the model really write this, or did a
        // human?" can be answered by reading CloudWatch, not just inferred
        // from behavior.
        console.log(`[runAgenticComponentBuild] model submitted execute_ifc_code (${code.length} chars):\n${code}`);
        try {
          const before = elements;
          const res = await mcpCallTool("execute_ifc_code_tool", { code: wrapCode(code) }, sessionId);
          sessionId = res.session;
          const capturedBounds = extractCapturedBounds(res.resultText);
          const after = await getSceneElements(sessionId);
          sessionId = after.sessionId;
          const newOnes = diffNewElements(before, after.elements);
          for (const e of newOnes) { if (!e.bbox && capturedBounds.has(e.name)) e.bbox = capturedBounds.get(e.name)!; }
          elements = [...before, ...newOnes];

          if (newOnes.length === 0) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: "Your script ran without error but created no real IFC element - did you call h.add_mesh_element?" });
            onStep(`⚠️ model's code created nothing`);
          } else {
            const desc = newOnes.map((e) => `"${e.name}" (${e.ifc_class})${e.bbox ? `: bbox min[${e.bbox.min.map((n) => n.toFixed(2)).join(",")}] max[${e.bbox.max.map((n) => n.toFixed(2)).join(",")}]` : " (bbox unavailable)"}`).join("; ");
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Success. Created: ${desc}` });
            onStep(`🏗️ model created ${newOnes.length} element(s): ${newOnes.map((e) => e.name).join(", ")}`);
          }
        } catch (err: any) {
          const errMsg = (err?.message || String(err)).slice(0, 600);
          lastError = errMsg;
          messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${errMsg}` });
          onStep(`❌ model's code failed: ${errMsg.slice(0, 150)}`);
        }
        continue;
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content: `Unknown tool "${toolName}".` });
    }
  }

  const newElements = elements.slice(startCount);
  return {
    mcpSessionId: sessionId,
    newElements,
    success: newElements.length > 0 && newElements.every((e) => e.guid),
    iterations: transcript.length,
    transcript,
    lastError,
    messages,
    stoppedEarly
  };
}

export interface InfraBuildResult {
  mcpSessionId: string;
  builtComponents: number;
  skippedComponents: number;
  steps: string[];
  /** Set when a deadline stopped generation before every component finished - resume at this index. */
  stoppedAtIndex?: number;
}

/**
 * Infrastructure equivalent of generateStoreyFreeform: builds an ordered
 * list of structural components strictly in sequence (each one needs to see
 * what the previous one actually built, e.g. a deck segment must continue
 * from where the last one ended), against the real live scene state. Same
 * verify-retry-skip discipline, no deterministic geometry, no fallback.
 *
 * `startIndex` resumes a component list a previous invocation stopped
 * partway through. `deadline` (epoch ms) is checked before each component;
 * if there isn't enough time left for another model round-trip, generation
 * stops cleanly and reports exactly which component to resume at - never a
 * mid-request timeout crash. This is what lets a 17+ component structure
 * (more than fits in one Lambda invocation's real time budget) still get
 * built completely across a few calls, with no deterministic shortcut.
 */
export async function generateInfrastructureFreeform(
  componentSpecs: { name: string; role: string; notes?: string }[],
  initialSessionId: string,
  onStep: (msg: string) => void = () => {},
  runningElements: SceneElement[] = [],
  startIndex: number = 0,
  deadline: number = 0
): Promise<{ result: InfraBuildResult; elements: SceneElement[] }> {
  const steps: string[] = [];
  let sessionId = initialSessionId;
  let elements: SceneElement[] = runningElements;
  let builtComponents = 0;
  let skippedComponents = 0;

  for (let cIdx = startIndex; cIdx < componentSpecs.length; cIdx++) {
    if (deadline && Date.now() > deadline) {
      onStep(`⏸️ Pausing before component ${cIdx + 1}/${componentSpecs.length} - out of time this invocation, will resume.`);
      return { result: { mcpSessionId: sessionId, builtComponents, skippedComponents, steps, stoppedAtIndex: cIdx }, elements };
    }
    const spec = componentSpecs[cIdx];
    const name = String(spec.name || "Component").replace(/['"\\]/g, "");
    const role = String(spec.role || "");
    const notes = String(spec.notes || "");
    const isFirst = elements.length === 0;

    const userPrompt = `Component to build: "${name}"\nRole: ${role}${notes ? `\nNotes: ${notes}` : ""}\n${isFirst ? "This is the FIRST component - place it starting near the origin (0,0,0)." : "Other elements already exist in the scene - call get_scene_info to get their real bounding boxes before you place or align anything against them."}`;

    const before = elements;
    // The model drives execute_ifc_code/get_scene_info itself here, in a real
    // multi-turn loop, seeing the REAL result of every call and correcting
    // itself - not one blind script against a static description with a
    // single retry (see runAgenticComponentBuild for why).
    const agentic = await runAgenticComponentBuild(
      AGENTIC_INFRA_SYSTEM_PROMPT,
      userPrompt,
      sessionId,
      before,
      onStep,
      { model: "glm-5.3", maxIterations: 6, deadline }
    );
    sessionId = agentic.mcpSessionId;

    let success = false;
    let ranOutOfTime = false;
    let lastError = agentic.lastError;
    let attemptedGuidsToClean: string[] = [];

    if (agentic.newElements.length === 0) {
      // Nothing real got created this cycle. If that's because the deadline
      // cut the loop off before the model even got a first try in, pause and
      // retry this exact component fresh next invocation rather than
      // recording it as a genuine failure.
      ranOutOfTime = agentic.transcript.some((t) => t.startsWith("(stopped: out of time"));
      lastError = lastError || "The model made no progress on this component (no tool calls succeeded).";
    } else {
      // Loose threshold (0.55) - structural contact between components is
      // normal and expected here, unlike room packing. Only gross full
      // duplication counts as a real problem. No-ops safely when bbox is
      // unavailable for either side.
      const clashes = findClashes(before, agentic.newElements, 0.55);
      if (!agentic.success) {
        attemptedGuidsToClean = agentic.newElements.map((e) => e.guid!).filter(Boolean);
        lastError = lastError || "The model's elements were not all real, committed IFC entities.";
      } else if (clashes.length > 0) {
        attemptedGuidsToClean = agentic.newElements.map((e) => e.guid!).filter(Boolean);
        lastError = `Geometry clash: ${clashes.join("; ")}`;
      } else {
        elements = [...before, ...agentic.newElements];
        success = true;
      }
    }

    if (success) {
      builtComponents++;
      const msg = `🔩 Built "${name}"`;
      steps.push(msg);
      onStep(msg);
    } else if (ranOutOfTime) {
      // Best-effort cleanup of the failed attempt's orphaned geometry, then pause
      // and retry this exact component fresh next invocation - this is not a skip.
      if (attemptedGuidsToClean.length > 0) {
        const cleanupCode = `ifc = get_ifc_file()\nfor _g in ${JSON.stringify(attemptedGuidsToClean)}:\n    try:\n        api.run("root.remove_product", ifc, product=ifc.by_guid(_g))\n    except Exception:\n        pass\nsave_and_load_ifc()\n`;
        try {
          const cleanupRes = await mcpCallTool("execute_ifc_code_tool", { code: cleanupCode }, sessionId);
          sessionId = cleanupRes.session;
        } catch { /* best-effort only */ }
      }
      const msg = `⏸️ Pausing before component ${cIdx + 1}/${componentSpecs.length} - out of time this invocation, will resume.`;
      steps.push(msg);
      onStep(msg);
      return { result: { mcpSessionId: sessionId, builtComponents, skippedComponents, steps, stoppedAtIndex: cIdx }, elements };
    } else {
      if (attemptedGuidsToClean.length > 0) {
        const cleanupCode = `ifc = get_ifc_file()\nfor _g in ${JSON.stringify(attemptedGuidsToClean)}:\n    try:\n        api.run("root.remove_product", ifc, product=ifc.by_guid(_g))\n    except Exception:\n        pass\nsave_and_load_ifc()\n`;
        try {
          const cleanupRes = await mcpCallTool("execute_ifc_code_tool", { code: cleanupCode }, sessionId);
          sessionId = cleanupRes.session;
        } catch { /* best-effort only */ }
      }
      skippedComponents++;
      const msg = `⚠️ Skipped "${name}" after 2 attempts: ${lastError}`;
      steps.push(msg);
      onStep(msg);
      console.warn(`[generateInfrastructureFreeform] ${msg}`);
    }
  }

  return { result: { mcpSessionId: sessionId, builtComponents, skippedComponents, steps }, elements };
}

/**
 * Per-room, verified, small-scope furniture/detail generation.
 *
 * This is the incremental alternative to asking Kimi for one monolithic
 * 150-250 line building script: each room gets its own small, bounded
 * generation request (8-20 lines, furniture only), executed and verified
 * immediately, with ONE targeted patch retry using that room's own error -
 * never a full-building regeneration. A room that still fails after the
 * retry is simply skipped (logged, not silently downgraded) - the
 * structural shell (walls/slabs/doors/windows/roof, built separately and
 * already reliable) is never at risk from a furniture failure.
 *
 * First-attempt code for every room is generated CONCURRENTLY (pure text
 * calls, no shared state); execution against the MCP session, and any
 * error-feedback retry, happens strictly in order.
 */
export async function enrichRoomsWithFurniture(
  storeyPlans: any[],
  initialSessionId: string,
  onStep: (msg: string) => void = () => {}
): Promise<RoomEnrichmentResult> {
  const steps: string[] = [];
  let sessionId = initialSessionId;
  let enrichedRooms = 0;
  let skippedRooms = 0;

  const FURNISH_SYSTEM_PROMPT = `You are an interior detailing specialist adding furniture/fixtures to ONE room of an already-built structure.
Output RAW PYTHON ONLY - no markdown fences, no JSON, no explanation, no comments about what you're doing.
Available in scope: h (an InfraStudioHarness bound to the correct storey - already initialized, do not create your own), math, np, trimesh.
Use h.create_box(extents=[l,w,h], pos=[x,y,z], rot_z_deg=0.0) or h.create_cylinder(...) to build shapes, then h.add_mesh_element(mesh, "name", ifc_class="IfcFurniture", mat_name="...", rgb=(r,g,b)) to add each piece (call add_mesh_element separately for each piece of furniture).
Do NOT call h.commit(), save_and_load_ifc(), or create walls/slabs/doors/windows/storeys - that is handled separately.
Do NOT import anything. Do NOT define functions or classes. 8-20 lines, flat procedural code only.`;

  interface Target { name: string; userPrompt: string; storeySelect: string; }
  const targets: Target[] = [];
  for (const storey of storeyPlans) {
    const elevation = Number(storey.elevation ?? 0);
    const rooms = Array.isArray(storey.rooms) ? storey.rooms : [];
    const storeyHeight = Number(storey.height || 3.2);

    for (const room of rooms) {
      const name = String(room.name || "Room").replace(/['"\\]/g, "");
      const ox = Number(room.origin?.[0] || 0);
      const oy = Number(room.origin?.[1] || 0);
      const w = Math.max(0.5, Number(room.width || 4));
      const l = Math.max(0.5, Number(room.length || 4));

      // Skip tiny circulation/service spaces where furniture rarely belongs.
      if (/corridor|hall(way)?|stair|lift|core|lobby$/i.test(name) && w * l < 8) continue;

      const userPrompt = `Room name: "${name}"
Room's usable floor area, in GLOBAL coordinates (meters): x from ${ox.toFixed(2)} to ${(ox + w).toFixed(2)}, y from ${oy.toFixed(2)} to ${(oy + l).toFixed(2)}.
Floor is at z=${elevation.toFixed(2)}, ceiling height is ${storeyHeight.toFixed(2)}m.
Add furniture/fixtures appropriate for a room called "${name}". Keep every piece strictly inside the given x/y range and at z >= ${elevation.toFixed(2)}.`;

      const storeySelect = `ifc = get_ifc_file()
_storeys = ifc.by_type("IfcBuildingStorey")
_target = None
for _s in _storeys:
    if abs(float(_s.Elevation or 0) - (${elevation})) < 0.05:
        _target = _s
        break
if _target is None and _storeys:
    _target = _storeys[0]
h = InfraStudioHarness(ifc, _target)
`;
      targets.push({ name, userPrompt, storeySelect });
    }
  }

  if (targets.length === 0) return { mcpSessionId: sessionId, enrichedRooms: 0, skippedRooms: 0, steps };

  const firstPass = await mapWithConcurrency(targets, 4, async (t) => {
    try {
      const raw = await callQwen(FURNISH_SYSTEM_PROMPT, t.userPrompt, false, "glm-5.3", 90000);
      return { code: extractRawCode(raw), error: "" };
    } catch (err: any) {
      return { code: "", error: (err?.message || String(err)).slice(0, 400) };
    }
  });

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    let bodyCode = firstPass[i].code;
    let lastError = firstPass[i].error;
    let success = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          const msg = `${t.userPrompt}\n\nYOUR PREVIOUS ATTEMPT FAILED TO EXECUTE WITH THIS ERROR:\n${lastError}\n\nYOUR PREVIOUS CODE:\n${bodyCode}\n\nFix ONLY what caused this specific error and return the corrected raw Python (furniture-creation lines only, same rules as before).`;
          bodyCode = extractRawCode(await callQwen(FURNISH_SYSTEM_PROMPT, msg, false, "glm-5.3", 90000));
        }
        if (!bodyCode || bodyCode.length < 10) throw new Error(lastError || "Model returned empty/unusable code");

        const fullScript = `${t.storeySelect}\n${bodyCode}\ncount = h.commit()\nsave_and_load_ifc()\n`;
        const res = await mcpCallTool("execute_ifc_code_tool", { code: fullScript }, sessionId);
        sessionId = res.session;
        success = true;
        break;
      } catch (err: any) {
        lastError = (err?.message || String(err)).slice(0, 400);
      }
    }

    if (success) {
      enrichedRooms++;
      const msg = `🪑 Furnished "${t.name}"`;
      steps.push(msg);
      onStep(msg);
    } else {
      skippedRooms++;
      const msg = `⚠️ Skipped furniture for "${t.name}" after 2 attempts: ${lastError}`;
      steps.push(msg);
      onStep(msg);
      console.warn(`[enrichRoomsWithFurniture] ${msg}`);
    }
  }

  return { mcpSessionId: sessionId, enrichedRooms, skippedRooms, steps };
}

export interface StoreyEmbellishmentResult {
  mcpSessionId: string;
  enrichedStoreys: number;
  skippedStoreys: number;
  steps: string[];
}

/**
 * Per-storey, verified, small-scope architectural expression pass - added
 * ON TOP of an already-built, structurally reliable shell (walls/slabs/
 * doors/windows come from deterministic geometry, not from this). This is
 * where glm-5.3's creativity is actually put to use: canopies, porticos,
 * cantilevers, column articulation, facade cladding variation, whatever
 * fits the storey - via a small (10-25 line), immediately-executed-and-
 * verified snippet with ONE targeted retry, same reliability pattern as
 * enrichRoomsWithFurniture. A storey that still fails after the retry is
 * skipped and logged - never silently replaced with a generic template.
 */
export async function embellishStoreysArchitecturally(
  storeyPlans: any[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number; topZ: number },
  initialSessionId: string,
  onStep: (msg: string) => void = () => {}
): Promise<StoreyEmbellishmentResult> {
  const steps: string[] = [];
  let sessionId = initialSessionId;
  let enrichedStoreys = 0;
  let skippedStoreys = 0;

  const EMBELLISH_SYSTEM_PROMPT = `You are an architectural detailing specialist adding expressive structural/facade elements to ONE already-built storey of a building.
Output RAW PYTHON ONLY - no markdown fences, no JSON, no explanation, no comments about what you're doing.
Available in scope: h (an InfraStudioHarness bound to the correct storey - already initialized, do not create your own), math, np, trimesh.
Use h.add_column(pos=[x,y], height=h, radius=r, z_bottom=z, shape="round|square", name="...") / h.add_beam(p1, p2, depth=d, width=w, z_elevation=z, name="...") / h.add_railing(p1, p2, height=h, z_bottom=z, name="...") for structural expression, or h.create_box(extents=[l,w,h], pos=[x,y,z], rot_z_deg=0.0) / h.create_cylinder(radius=r, height=h, pos=[x,y,z]) followed by h.add_mesh_element(mesh, "name", ifc_class="IfcBuildingElementProxy", mat_name="...", rgb=(r,g,b)) for custom shapes - "name" is a REQUIRED positional argument to add_mesh_element, always pass it. Add real architectural expression: entry canopies, porticos, exposed structural framing, cantilevered eaves, cladding fins, sun-shading louvers, balcony extensions, feature columns - whatever suits the storey.
Do NOT touch, move, or recreate any existing wall, door, window, slab, or column - only ADD new elements.
Do NOT call h.commit(), save_and_load_ifc(), create_wall, add_door, add_window, or create storeys - that is handled separately.
Do NOT import anything. Do NOT define functions or classes. 10-25 lines, flat procedural code only.`;

  interface Target { name: string; userPrompt: string; storeySelect: string; }
  const targets: Target[] = storeyPlans.map((storey: any, sIdx: number) => {
    const elevation = Number(storey.elevation ?? 0);
    const height = Number(storey.height || 3.2);
    const name = String(storey.name || `Level ${sIdx + 1}`).replace(/['"\\]/g, "");
    const userPrompt = `Storey: "${name}" (elevation z=${elevation.toFixed(2)}, height ${height.toFixed(2)}m).
Overall building footprint in GLOBAL coordinates (meters): x from ${bounds.minX.toFixed(2)} to ${bounds.maxX.toFixed(2)}, y from ${bounds.minY.toFixed(2)} to ${bounds.maxY.toFixed(2)}.
Add architectural expression appropriate for this storey and its position in the building (ground floor vs. upper floor vs. top floor under the roof at z=${bounds.topZ.toFixed(2)}). Keep every added element within or just outside the footprint bounds, at z >= ${elevation.toFixed(2)}.`;
    const storeySelect = `ifc = get_ifc_file()
_storeys = ifc.by_type("IfcBuildingStorey")
_target = None
for _s in _storeys:
    if abs(float(_s.Elevation or 0) - (${elevation})) < 0.05:
        _target = _s
        break
if _target is None and _storeys:
    _target = _storeys[0]
h = InfraStudioHarness(ifc, _target)
`;
    return { name, userPrompt, storeySelect };
  });

  const firstPass = await mapWithConcurrency(targets, 4, async (t) => {
    try {
      const raw = await callQwen(EMBELLISH_SYSTEM_PROMPT, t.userPrompt, false, "glm-5.3", 90000);
      return { code: extractRawCode(raw), error: "" };
    } catch (err: any) {
      return { code: "", error: (err?.message || String(err)).slice(0, 400) };
    }
  });

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    let bodyCode = firstPass[i].code;
    let lastError = firstPass[i].error;
    let success = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          const msg = `${t.userPrompt}\n\nYOUR PREVIOUS ATTEMPT FAILED TO EXECUTE WITH THIS ERROR:\n${lastError}\n\nYOUR PREVIOUS CODE:\n${bodyCode}\n\nFix ONLY what caused this specific error and return the corrected raw Python (same rules as before).`;
          bodyCode = extractRawCode(await callQwen(EMBELLISH_SYSTEM_PROMPT, msg, false, "glm-5.3", 90000));
        }
        if (!bodyCode || bodyCode.length < 10) throw new Error(lastError || "Model returned empty/unusable code");

        const fullScript = `${t.storeySelect}\n${bodyCode}\ncount = h.commit()\nsave_and_load_ifc()\n`;
        const res = await mcpCallTool("execute_ifc_code_tool", { code: fullScript }, sessionId);
        sessionId = res.session;
        success = true;
        break;
      } catch (err: any) {
        lastError = (err?.message || String(err)).slice(0, 400);
      }
    }

    if (success) {
      enrichedStoreys++;
      const msg = `🏛️ Embellished "${t.name}"`;
      steps.push(msg);
      onStep(msg);
    } else {
      skippedStoreys++;
      const msg = `⚠️ Skipped architectural embellishment for "${t.name}" after 2 attempts: ${lastError}`;
      steps.push(msg);
      onStep(msg);
      console.warn(`[embellishStoreysArchitecturally] ${msg}`);
    }
  }

  return { mcpSessionId: sessionId, enrichedStoreys, skippedStoreys, steps };
}

export interface AntigravityAgentOptions {
  maxRetries?: number;
  model?: string;
  onStep?: (msg: string) => void;
}

export interface AntigravityAgentResult {
  success: boolean;
  python_code: string;
  mcpSessionId: string;
  resultText?: string;
  iterations: number;
  steps: string[];
  error?: string;
}

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity's Autonomous Computational BIM Architect & Structural Engineer.
Given the user's design request, write a complete, standalone, runnable Python script that generates an IFC model matching their requirements using IfcOpenShell and Trimesh.
You have complete creative and mathematical freedom: you can design any architectural style, complex parametric curves, lofted surfaces, organic shells, towers, bridges, or modern buildings without being bound to rigid box templates.

EXECUTION ENVIRONMENT (AWS Bonsai MCP Server):
- Python 3.11 with ifcopenshell, ifcopenshell.api as api, trimesh, numpy as np, and math pre-imported.
- ifc = get_ifc_file()
- save_and_load_ifc()
- THE PROJECT ALREADY EXISTS. Before your code runs, initialize_project has already created IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey, and the geometric representation contexts. Do NOT call api.run("root.create_entity", ifc, ifc_class="IfcProject"/"IfcSite"/"IfcBuilding"/"IfcGeometricRepresentationContext"/"IfcGeometricRepresentationSubContext") - these already exist and re-creating them causes execution failures (IfcGeometricRepresentationContext is not an IfcRoot subtype and has no GlobalId). Just use: storeys = ifc.by_type("IfcBuildingStorey") to get the existing floors, and h = InfraStudioHarness(ifc, storeys[i]) to start building.
- SANDBOX RULES:
  * Do NOT import 'os', 'sys', 'subprocess', or any filesystem/OS modules (blocked by EC2 security sandbox).
  * Do NOT define custom Python classes; write clean procedural/functional code.
  * Write standard multiline Python code with 4-space indentation. Do NOT join statements with semicolons (;).
- InfraStudioHarness(ifc, storey) is available if you wish to use high-level primitives:
  * h.create_slab(polygon_2d, thickness=0.30, z_elevation=0.0) -> trimesh.Trimesh
  * h.create_wall(p1, p2, height=3.2, thickness=0.25, z_bottom=0.0, openings=[...]) -> trimesh.Trimesh (creates watertight walls with true rectangular opening voids)
  * h.add_window(p1, p2, offset, width, height, sill_height, z_bottom, name)
  * h.add_door(p1, p2, offset, width, height, z_bottom, name)
  * h.add_column(pos=[x,y], height=3.2, radius=0.2, z_bottom=0.0, shape="round|square", name)
  * h.add_beam(p1, p2, depth=0.45, width=0.25, z_elevation=3.0, name)
  * h.add_railing(p1, p2, height=1.05, z_bottom=0.0, name)
  * h.create_stairs(start_pt, length, width, height, num_steps)
  * h.create_roof(footprint_2d, roof_type, height, z_elevation, thickness)
  * h.add_mesh_element(mesh, name, ifc_class, mat_name, rgb, transparency)
  * count = h.commit()
- You can ALSO write raw ifcopenshell entities or trimesh geometry directly for any custom, parametric, or organic structures.
- End your script with:
  save_and_load_ifc()
  print("IFC model generated successfully.")

OUTPUT FORMAT:
Return ONLY a JSON object:
{
  "structure_name": "Descriptive Name",
  "python_code": "Complete executable Python script"
}
Do NOT include thought_process or markdown explanations in the JSON. Focus directly on executable python_code.`;

/**
 * Extracts raw Python code from LLM response (supports JSON or markdown code block).
 */
export function extractPythonCode(response: string): string {
  if (!response || typeof response !== "string") return "";
  const trimmed = response.trim();

  // 1. Try parsing JSON
  try {
    const parsed = cleanJsonResponse(trimmed);
    if (parsed && typeof parsed.python_code === "string" && parsed.python_code.trim().length > 20) {
      return parsed.python_code.trim();
    }
  } catch {
    // Not valid JSON, proceed to extract code block
  }

  // 2. Extract from markdown code fence
  const codeBlockMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1].trim().length > 20) {
    return codeBlockMatch[1].trim();
  }

  // 3. Fallback if entire string is python code
  if (trimmed.includes("InfraStudioHarness") && trimmed.includes("commit()")) {
    return trimmed;
  }

  return "";
}

/**
 * Runs the Antigravity Agentic ReAct self-correction loop using Kimi K3 on AWS.
 */
export async function runAntigravityKimiAgent(
  brief: any,
  initialSessionId: string,
  options: AntigravityAgentOptions = {}
): Promise<AntigravityAgentResult> {
  const maxRetries = options.maxRetries ?? 3;
  const model = options.model || "glm-5.3";
  const onStep = options.onStep || (() => {});
  const steps: string[] = [];

  const logStep = (msg: string) => {
    steps.push(msg);
    onStep(msg);
  };

  logStep(`🧠 Antigravity Agent (${model}): Analyzing design brief & calculating spatial grids...`);

  let currentSessionId = initialSessionId;
  let code = "";
  let promptText = typeof brief === "string" ? brief : JSON.stringify(brief);
  let errorFeedback = "";
  let iterations = 0;

  while (iterations < maxRetries) {
    iterations++;

    try {
      let promptMessage = "";
      const stepModel = "glm-5.3";
      if (iterations === 1) {
        promptMessage = `User Design Brief: ${promptText}\n\nDesign a complete, high-quality, watertight architectural BIM model using InfraStudioHarness. Return JSON with structure_name and python_code.`;
      } else {
        logStep(`🔧 Antigravity Agent: Fast self-healing error from previous pass with ${stepModel} (Attempt ${iterations}/${maxRetries})...`);
        promptMessage = `PREVIOUS PYTHON CODE EXECUTION FAILED ON EC2 BONSAI WITH ERROR:\n${errorFeedback}\n\nFAILED CODE:\n\`\`\`python\n${code}\n\`\`\`\n\nAnalyze why this failed, repair the geometry/parameters, ensure all InfraStudioHarness methods are valid, and return the corrected JSON with repaired python_code.`;
      }

      const rawResponse = await callQwen(
        ANTIGRAVITY_SYSTEM_PROMPT,
        promptMessage,
        true,
        stepModel
      );

      code = extractPythonCode(rawResponse);
      if (!code || code.length < 50) {
        throw new Error(`Failed to extract valid Python code from ${stepModel} response.`);
      }

      // Pre-execution code sanitization:
      let codeToRun = code;
      codeToRun = codeToRun.replace(/import\s+InfraStudioHarness\s+as\s+h;?/g, "h = InfraStudioHarness()");
      codeToRun = codeToRun.replace(/import\s+InfraStudioHarness;?/g, "");
      codeToRun = codeToRun.replace(/from\s+InfraStudioHarness\s+import\s+[^;\n]+;?/g, "");
      codeToRun = codeToRun.replace(/import\s+(os|sys|subprocess|shutil)[^\n;]*;?/g, "# removed system import");

      logStep(`⚡ Antigravity Agent: Executing ${codeToRun.length} bytes of Python code on EC2 Bonsai MCP...`);

      // Execute on EC2 Bonsai MCP server
      const toolRes = await mcpCallTool("execute_ifc_code_tool", { code: codeToRun }, currentSessionId);
      currentSessionId = toolRes.session;

      logStep(`✅ Antigravity Agent: Execution succeeded! Model generated cleanly.`);
      return {
        success: true,
        python_code: code,
        mcpSessionId: currentSessionId,
        resultText: toolRes.resultText,
        iterations,
        steps
      };

    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[AntigravityAgent] Attempt ${iterations} failed: ${errMsg.slice(0, 300)}`);
      errorFeedback = errMsg;

      if (iterations >= maxRetries) {
        logStep(`❌ Antigravity Agent: glm-5.3 failed ${maxRetries}/${maxRetries} attempts. No fallback - reporting failure honestly.`);
        break;
      }
    }
  }

  // No fallback: if glm-5.3 could not produce working code after maxRetries
  // real attempts, the caller must be told the truth - never silently
  // substitute a deterministic template as if it were the model's design.
  return {
    success: false,
    python_code: code,
    mcpSessionId: currentSessionId,
    error: errorFeedback || "glm-5.3 did not produce executable code.",
    iterations,
    steps
  };
}
