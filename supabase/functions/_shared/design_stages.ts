/**
 * Staged design workflow + in-place editing briefs.
 *
 * Real design iterates coarse -> fine, so a staged build produces ONE stage at
 * a time (massing, zones/stacking, facade, structure, detail) and the user
 * reviews/adjusts each before the next. Every stage after massing is an EDIT of
 * the previously approved model (loaded into the build slot, see
 * antigravity_agent.ts), so approved decisions are carried forward untouched.
 */

export const STAGE_ORDER = ["massing", "zones", "facade", "structure", "detail"] as const;
export type StageId = typeof STAGE_ORDER[number];

export function isStageId(v: unknown): v is StageId {
  return typeof v === "string" && (STAGE_ORDER as readonly string[]).includes(v);
}

const STAGE_INSTRUCTIONS: Record<StageId, string> = {
  massing: `STAGE 1 of 5 - MASSING ONLY.
Produce just the overall form and volume of the design as clean, simple solids. Decide the real overall dimensions, number of storeys and heights, and the main volumes (e.g. podium + tower, bar, courtyard, single pavilion; for infrastructure: the main structural bodies and spans).
- Create the IfcBuildingStorey levels at the correct elevations so later stages can use them.
- Model each volume as ONE clean solid element (an IfcBuildingElementProxy or similar made with create_trimesh_ifc / create_mesh_ifc / execute_ifc_code_tool) named "MASS - <name>" (e.g. "MASS - Podium", "MASS - Tower"). Typically 3-15 elements in total.
- Apply a single neutral, slightly transparent style (light grey-blue) so the form reads clearly.
- Do NOT add walls, windows, doors, roofs detail, structure, interiors or furniture - those come in later stages. Do not pad the model.`,

  zones: `STAGE 2 of 5 - ZONES, FUNCTIONAL BLOCKS AND STACKING.
The approved massing is already loaded. Keep every MASS volume and storey exactly as they are.
- Subdivide the massing into functional zones per storey and express the stacking: add an IfcSpace (or a clearly named volume) for each zone on each storey, named by function (e.g. "Lobby", "Retail", "Open Office", "Core / Circulation", "Plant", "Car Park").
- Add the vertical cores/circulation as simple volumes and a floor plate (IfcSlab) at each level.
- Colour each function with its own surface style so the stacking diagram is readable.
- Do NOT add facade, structure, partitions, doors or detail yet.`,

  facade: `STAGE 3 of 5 - FACADE DESIGN.
The approved massing and zoning are already loaded. Keep them.
- Design the envelope: curtain wall / cladding panels, mullions, windows and doors, entrances, shading devices, roof edge/parapet, according to the form and uses already approved.
- Apply realistic materials (glass with genuine transparency, metal, stone, timber, concrete as appropriate).
- Do NOT add structure or interior detail yet.`,

  structure: `STAGE 4 of 5 - STRUCTURAL SOLUTION.
The approved massing, zoning and facade are already loaded. Keep them.
- Add the structural system suited to the typology: foundations/footings or piles, columns, beams, transfer elements, core shear walls, slabs where missing.
- Align structure with the zones and facade modules; avoid clashes with the approved geometry.
- Apply structural materials (concrete, steel, timber as appropriate).`,

  detail: `STAGE 5 of 5 - DETAIL.
Everything approved so far is already loaded. Keep it.
- Add detail: stairs and ramps, railings, interior partitions with doors, ceilings, roof detail, key fit-out and furniture, basic services where relevant.
- Every new element needs a real material/style. Finish with a sanity check of the whole model.`,
};

export function stageInstruction(stage: StageId): string {
  return STAGE_INSTRUCTIONS[stage];
}

/** Hosts the build box is allowed to download a base model from (it holds AWS
 *  instance credentials, so an arbitrary URL would be a server-side request
 *  forgery risk). Our own S3 model bucket and the Supabase storage project. */
const ALLOWED_MODEL_HOSTS = [
  /^infrastudio-ifc-models-eu-north-1\.s3\.eu-north-1\.amazonaws\.com$/,
  /^pzeoilvqeyuheslkfhjq\.supabase\.co$/,
];

/** Returns the URL if it is an https link to an allowed model host, else null. */
export function validateBaseIfcUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    if (!ALLOWED_MODEL_HOSTS.some((re) => re.test(u.hostname))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Brief for an in-place edit of an already-loaded model (a follow-up request
 * on a generated model, an imported IFC, or the next design stage).
 */
export function buildEditBrief(opts: {
  request: string;
  stage?: StageId;
  projectBrief?: string;
  imageSection?: string;
  specPriorityRule: string;
}): string {
  const { request, stage, projectBrief, imageSection = "", specPriorityRule } = opts;
  const stageBlock = stage
    ? `\n\nThis is part of a STAGED design workflow. Work on this stage only:\n${stageInstruction(stage)}\n`
    : "";
  const projectBlock = projectBrief && projectBrief.trim()
    ? `\n\nOriginal project brief (context only - what was already agreed and built):\n${projectBrief.trim()}\n`
    : "";
  return `You are EDITING an existing IFC model, not creating a new one. The model has ALREADY been loaded into the MCP scene for you.

CRITICAL: do NOT call initialize_project - that would erase the model you are meant to edit. Start by calling get_scene_info (and get_ifc_scene_overview if useful) and, with one execute_ifc_code_tool call, check the schema, units, storeys and the element classes present, so your changes fit what is there.

${specPriorityRule}

IMPORTANT edit rules (non-negotiable):
- Change ONLY what the request asks for. Every other element must stay exactly as it is: same elements, names, placement, geometry, materials and spatial structure. Never rebuild, regenerate or "tidy up" untouched parts.
- Add new elements into the right IfcBuildingStorey / spatial container, use the model's existing units and naming style, and give every NEW element a real material/surface style. When you move or resize something, use ifcopenshell.api (e.g. geometry.edit_object_placement, geometry.add_*_representation, root.remove_product) rather than recreating it.
- You have direct MCP tool-calling access (create_wall, create_slab, create_door, create_window, create_stairs, create_trimesh_ifc, create_mesh_ifc, execute_ifc_code_tool, create_surface_style, apply_style_to_object, get_scene_info, export_ifc, etc.). Call them as native tool calls; never use bash/curl to talk to the MCP server.
- execute_ifc_code_tool has a hard 60-second timeout per call: split big changes into several calls, and assign new elements to a storey with ONE spatial.assign_container call per batch, not one per element.
- A modest, correct change is the right answer to a modest request. Do not add unrelated geometry or inflate the element count.
- Before exporting, call get_scene_info again and verify (a) the requested change is actually present and measurable in the model and (b) the elements you were not asked to touch are still there (the element count should only change by what the request implies).${stageBlock}${projectBlock}
The change requested:

${request}${imageSection}

When finished, call export_ifc, then end your final message with the exact model link (file_url) that export_ifc returned.`;
}

/** Brief for the first stage of a staged build: a normal new build, restricted to massing. */
export function buildStageOneBrief(opts: { request: string; imageSection?: string; specPriorityRule: string }): string {
  const { request, imageSection = "", specPriorityRule } = opts;
  return `You are the design pipeline for the FIRST stage of a staged design workflow: interpreter (work out what is really being asked), architect (invent every spec that isn't given) and executor (build it via real tool calls). The client reviews each stage before moving on, so build ONLY this stage and build it well.

${specPriorityRule}

IMPORTANT tool-usage rule: you have direct MCP tool-calling access (create_wall, create_slab, create_stairs, create_trimesh_ifc, create_mesh_ifc, execute_ifc_code_tool, create_surface_style, apply_style_to_object, get_scene_info, export_ifc, etc.). Call them as native tool calls; never use bash/curl to talk to the MCP server. execute_ifc_code_tool has a 60-second timeout per call.

IMPORTANT architect rule: if the brief is vague, do not ask for clarification (you cannot) - decide complete, coherent, real-world-plausible specs yourself for everything the client did not specify, and commit to them.

${stageInstruction("massing")}

First, call initialize_project to reset the MCP scene to a fresh IFC4 state. Then build the following:

${request}${imageSection}

When finished: call get_scene_info to confirm the model, then call export_ifc, then end your final message with the exact model link (file_url) that export_ifc returned.`;
}
