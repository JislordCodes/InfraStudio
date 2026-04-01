import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MCP_URL = "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════
interface Opening { type: "door" | "window"; name: string; width: number; height: number; offset: number; sill_height?: number; }
interface ElementStyle { name: string; color: [number, number, number]; transparency?: number; }
interface WallElement { type: "wall"; name: string; start: [number, number, number]; end: [number, number, number]; height: number; thickness: number; openings?: Opening[]; style?: ElementStyle; }
interface SlabElement { type: "slab"; name: string; outline: [number, number, number][]; thickness: number; style?: ElementStyle; }
interface RoofElement { type: "roof"; name: string; outline: [number, number, number][]; roof_type: string; angle: number; thickness: number; style?: ElementStyle; }
interface StairsElement { type: "stairs"; name: string; location: [number, number, number]; num_risers: number; riser_height: number; tread_depth: number; width: number; direction?: [number, number, number]; }
type BuildingElement = WallElement | SlabElement | RoofElement | StairsElement;
interface BuildingPlan { project_name: string; description: string; elements: BuildingElement[]; }
interface PlanResponse { type: "chat" | "building"; reply?: string; plan?: BuildingPlan; }

// ═══════════════════════════════════════════
// MCP CLIENT
// ═══════════════════════════════════════════
let mcpSessionId = "";
const debugLog: string[] = [];
function log(msg: string) { console.log(msg); debugLog.push(msg); }

function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (Array.isArray(item)) { const r = extractText(item); if (r) return r; }
      else if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
      }
    }
  }
  return undefined;
}

async function mcpPost(body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
  const s = res.headers.get("mcp-session-id"); if (s) mcpSessionId = s;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    return l ? JSON.parse(l.slice(5).trim()) : {};
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function mcpInit(): Promise<void> {
  await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "3.0" } } });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
  log("MCP ready");
}

async function mcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  log("CALL " + name + "(" + JSON.stringify(args).slice(0, 200) + ")");
  const res = await mcpPost({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) as Record<string, unknown>;
  const text = extractText((res?.result as Record<string, unknown>)?.content);
  if (text) {
    log("=> " + name + ": " + text.slice(0, 200));
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  if (res?.error) {
    const errMsg = JSON.stringify(res.error).slice(0, 200);
    log("ERR " + name + ": " + errMsg);
    return { success: false, error: errMsg };
  }
  return { raw: JSON.stringify(res?.result ?? "done") };
}

function getGuid(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) { if (typeof obj[k] === "string" && (obj[k] as string).length > 5) return obj[k] as string; }
  for (const k of ["result", "wall", "data"]) {
    const nested = obj[k] as Record<string, unknown> | undefined;
    if (nested) { for (const kk of keys) { if (typeof nested[kk] === "string") return nested[kk] as string; } }
  }
  return undefined;
}

// ═══════════════════════════════════════════
// RAG SERVICE - IFC Knowledge Fallback
// ═══════════════════════════════════════════
async function ragSearch(query: string): Promise<string> {
  try {
    const r = await mcpTool("search_ifc_knowledge", { query, max_results: 3 });
    if (r.status === "not_ready") {
      log("RAG not ready, trying init...");
      await mcpTool("ensure_ifc_knowledge_ready", { timeout_seconds: 10 });
      const r2 = await mcpTool("search_ifc_knowledge", { query, max_results: 3 });
      return JSON.stringify(r2);
    }
    return JSON.stringify(r);
  } catch (e) {
    log("RAG unavailable: " + String(e).slice(0, 100));
    return "RAG unavailable";
  }
}

async function ragFindFunction(operation: string, objectType: string): Promise<string> {
  try {
    const r = await mcpTool("find_ifc_function", { operation, object_type: objectType });
    return JSON.stringify(r);
  } catch { return "RAG unavailable"; }
}

// ═══════════════════════════════════════════
// EXECUTE BLENDER CODE - Universal Fallback
// ═══════════════════════════════════════════
async function execBlenderCode(code: string): Promise<Record<string, unknown>> {
  log("EXEC_CODE (" + code.length + " chars)");
  return await mcpTool("execute_blender_code", { code });
}

// Create opening in wall via direct Python execution
async function createOpeningViaCode(
  wallGuid: string, width: number, height: number, depth: number,
  location: [number, number, number], name: string
): Promise<string | undefined> {
  const code = `
import json
from blender_addon.api.feature import create_opening
result = create_opening(
    width=${width}, height=${height}, depth=${depth},
    location=[${location.join(",")}],
    wall_guid="${wallGuid}",
    opening_type="OPENING",
    name="${name}"
)
print(json.dumps(result))
`;
  const r = await execBlenderCode(code);
  // Extract opening_guid from printed output
  const raw = r.output as string || r.raw as string || JSON.stringify(r);
  const m = raw.match(/"opening_guid"\s*:\s*"([^"]+)"/);
  if (m) { log("Opening GUID: " + m[1]); return m[1]; }
  // Try parsing the result directly
  const guid = getGuid(r, "opening_guid", "guid");
  if (guid) return guid;
  log("WARN: Opening created but GUID not captured");
  return undefined;
}

// Fill opening with element via direct Python execution
async function fillOpeningViaCode(openingGuid: string, elementGuid: string): Promise<boolean> {
  const code = `
import json
from blender_addon.api.feature import fill_opening
result = fill_opening(opening_guid="${openingGuid}", element_guid="${elementGuid}")
print(json.dumps(result))
`;
  const r = await execBlenderCode(code);
  const raw = JSON.stringify(r);
  return raw.includes('"success": true') || raw.includes('"success":true');
}

// ═══════════════════════════════════════════
// PLANNER - Gemini with Full Tool Awareness
// ═══════════════════════════════════════════
const PLANNER_PROMPT = `You are a BIM Planning Engine for InfraStudio. Convert user building requests into structured JSON.

You have access to 54 MCP tools including:

CREATION TOOLS:
- initialize_project(project_name) - Init new IFC project
- create_wall(name, length, height, thickness, location, rotation) - One-point wall
- create_two_point_wall(name, start_point, end_point, height, thickness) - Two-point wall
- create_polyline_walls(name, points, height, thickness) - Multi-segment walls
- create_door(name, dimensions{width,height}, location, operation_type) - Standalone door
- create_window(name, dimensions{width,height}, location, partition_type) - Standalone window
- create_slab(name, outline_points, thickness) - Floor/ceiling slab
- create_roof(name, polyline, roof_type, angle, thickness) - Roof element
- create_stairs(name, location, num_risers, riser_height, tread_depth, width) - Stairs
- create_trimesh_ifc(vertices, faces, name, ifc_class) - Custom mesh geometry
- create_mesh_ifc(vertices, faces, name) - Simple mesh

OPENINGS (via execute_blender_code - Blender addon commands):
- create_opening(width, height, depth, location, wall_guid) - Cut void in wall
- fill_opening(opening_guid, element_guid) - Place door/window in void

STYLE TOOLS:
- create_surface_style(name, surface_color, transparency) - Create color style
- create_pbr_style(name, base_color, metallic, roughness) - PBR material
- apply_style_to_object(object_guids, style_name) - Apply style
- apply_style_to_material(material_name, style_name) - Apply to material
- list_styles() - List all styles
- update_style(style_name, ...) - Update style
- remove_style(style_name) - Remove style

QUERY/UPDATE TOOLS:
- get_scene_info() - Scene overview
- get_ifc_scene_overview() - IFC model overview
- get_wall_properties(wall_guid) / update_wall(wall_guid, ...)
- get_door_properties(door_guid) / update_door(door_guid, ...)
- get_window_properties(window_guid) / update_window(window_guid, ...)
- get_slab_properties(slab_guid) / update_slab(slab_guid, ...)
- get_door_operation_types() / get_window_partition_types() / get_stairs_types() / get_roof_types()
- list_ifc_entities(ifc_class) - List entities by type

RAG TOOLS (IFC Knowledge Base):
- search_ifc_knowledge(query) - Semantic search IFC docs
- find_ifc_function(operation, object_type) - Find functions by operation
- get_ifc_function_details(function_name) - Get function signatures
- get_ifc_module_info(module_name) - Module documentation

CODE EXECUTION:
- execute_blender_code(code) - Run Python in Blender
- execute_ifc_code_tool(code) - Run IFC Python code

EXPORT:
- export_ifc(session_id) - Export and upload IFC file

RULES:
1. Non-building messages: {"type":"chat","reply":"..."}
2. Building requests: {"type":"building","plan":{...}}
3. Return ONLY valid JSON. No markdown.
4. Metric dimensions (meters). Infer sensible defaults.
5. Walls: use start/end 3D points. Openings: offset from wall start, sill_height for windows.
6. Styles: {"name":"...","color":[r,g,b]} with 0-1 float values.
7. For openings in walls: specify them inside the wall's "openings" array. The executor will handle creating the void, the door/window element, and filling the opening automatically.

SCHEMA:
{"type":"building","plan":{"project_name":"str","description":"str","elements":[{"type":"wall","name":"W1","start":[0,0,0],"end":[8,0,0],"height":3,"thickness":0.2,"openings":[{"type":"door","name":"D1","width":0.9,"height":2.1,"offset":3.55,"sill_height":0},{"type":"window","name":"Win1","width":1.2,"height":1.0,"offset":1.0,"sill_height":1.0}],"style":{"name":"Brick","color":[0.7,0.3,0.2]}},{"type":"slab","name":"Floor","outline":[[0,0,0],[8,0,0],[8,6,0],[0,6,0]],"thickness":0.3},{"type":"roof","name":"Roof","outline":[[0,0,3],[8,0,3],[8,6,3],[0,6,3]],"roof_type":"GABLE_ROOF","angle":30,"thickness":0.25},{"type":"stairs","name":"S1","location":[2,3,0],"num_risers":15,"riser_height":0.2,"tread_depth":0.28,"width":1.0}]}}

Return ONLY JSON.`;

async function plan(msg: string): Promise<PlanResponse> {
  const res = await fetch(GEMINI_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PLANNER_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: msg }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error("Gemini " + res.status);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.filter((p: { text?: string }) => p.text)?.map((p: { text?: string }) => p.text)?.join("")?.trim() ?? "";
  log("Plan raw: " + text.slice(0, 300));
  let c = text;
  if (c.startsWith("```")) c = c.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const p = JSON.parse(c);
    if (p.type === "chat") return { type: "chat", reply: p.reply };
    if (p.type === "building" && p.plan) return { type: "building", plan: p.plan };
    if (p.elements) return { type: "building", plan: p as BuildingPlan };
    return { type: "chat", reply: p.reply || c };
  } catch { return { type: "chat", reply: c || "I didn't understand that." }; }
}

// ═══════════════════════════════════════════
// VALIDATOR
// ═══════════════════════════════════════════
function validate(plan: BuildingPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!plan.elements?.length) { errors.push("No elements"); return { valid: false, errors }; }
  for (const el of plan.elements) {
    if (el.type === "wall") {
      const w = el as WallElement;
      const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1], len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.1) errors.push("Wall '" + w.name + "' zero length");
      if (w.openings) for (const o of w.openings) {
        if (o.offset < 0) o.offset = 0;
        if (o.offset + o.width > len + 0.01) o.offset = Math.max(0, len - o.width - 0.1);
        if (o.height > w.height) o.height = w.height - 0.1;
      }
    }
    if (el.type === "roof" && (!((el as RoofElement).outline) || (el as RoofElement).outline.length < 3)) errors.push("Roof needs 3+ pts");
    if (el.type === "slab" && (!((el as SlabElement).outline) || (el as SlabElement).outline.length < 3)) errors.push("Slab needs 3+ pts");
  }
  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════
// SMART EXECUTOR - 3 Strategy System
// ═══════════════════════════════════════════
function openingWorldPos(s: [number, number, number], e: [number, number, number], offset: number, sill: number): [number, number, number] {
  const dx = e[0] - s[0], dy = e[1] - s[1], len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [s[0], s[1], sill];
  const r = offset / len;
  return [s[0] + dx * r, s[1] + dy * r, sill];
}

async function execute(plan: BuildingPlan): Promise<{ summary: string; steps: string[]; count: number }> {
  const steps: string[] = [];
  let count = 0;
  const wallGuids = new Map<string, string>();
  const elemGuids = new Map<string, string>();
  const styles: { el: string; style: ElementStyle }[] = [];

  // ── Phase 1: Initialize ──
  await mcpTool("initialize_project", { project_name: plan.project_name || "Build" });
  steps.push("✓ Project initialized");

  // ── Phase 2: Create Walls ──
  const walls = plan.elements.filter(e => e.type === "wall") as WallElement[];
  for (const w of walls) {
    try {
      const r = await mcpTool("create_two_point_wall", {
        start_point: w.start, end_point: w.end, name: w.name,
        thickness: w.thickness, height: w.height
      });
      const g = getGuid(r, "wall_guid", "guid", "GlobalId");
      if (g) {
        wallGuids.set(w.name, g);
        elemGuids.set(w.name, g);
        steps.push("✓ Wall '" + w.name + "'");
        count++;
      } else {
        steps.push("⚠ Wall '" + w.name + "' created but no GUID captured");
      }
      if (w.style) styles.push({ el: w.name, style: w.style });
    } catch (e) { steps.push("✗ Wall '" + w.name + "': " + String(e).slice(0, 80)); }
  }

  // ── Phase 3: Create Openings (3-step: void → element → fill) ──
  for (const w of walls) {
    if (!w.openings?.length) continue;
    const wg = wallGuids.get(w.name);
    if (!wg) { steps.push("⚠ Skip openings for '" + w.name + "' — no wall GUID"); continue; }

    for (const op of w.openings) {
      const sill = op.sill_height ?? (op.type === "window" ? 1.0 : 0);
      const pos = openingWorldPos(w.start, w.end, op.offset, sill);

      try {
        // Step A: Cut void in wall via execute_blender_code (Strategy C - code fallback)
        const openingGuid = await createOpeningViaCode(
          wg, op.width, op.height, w.thickness + 0.1, pos, op.name + " Opening"
        );

        // Step B: Create door/window element (Strategy A - direct MCP tool)
        let elemGuid: string | undefined;
        if (op.type === "door") {
          const dr = await mcpTool("create_door", {
            name: op.name,
            dimensions: { height: op.height, width: op.width },
            location: [pos[0], pos[1], 0],
            operation_type: "SINGLE_SWING_LEFT"
          });
          elemGuid = getGuid(dr, "door_guid", "guid");
        } else {
          // Create window WITHOUT wall_guid to avoid broken import
          const wr = await mcpTool("create_window", {
            name: op.name,
            dimensions: { width: op.width, height: op.height },
            location: pos,
            partition_type: "SINGLE_PANEL"
          });
          elemGuid = getGuid(wr, "window_guid", "guid");
        }

        // Step C: Fill opening with element (Strategy C - code fallback)
        if (openingGuid && elemGuid) {
          const filled = await fillOpeningViaCode(openingGuid, elemGuid);
          if (filled) {
            steps.push("✓ " + (op.type === "door" ? "Door" : "Window") + " '" + op.name + "' in wall '" + w.name + "' (opening + fill)");
          } else {
            steps.push("⚠ " + op.type + " '" + op.name + "' created but fill_opening failed");
          }
        } else if (elemGuid) {
          steps.push("⚠ " + op.type + " '" + op.name + "' placed at wall (standalone, opening void failed)");
        } else {
          steps.push("✗ " + op.type + " '" + op.name + "' element creation failed");
          continue;
        }

        if (elemGuid) elemGuids.set(op.name, elemGuid);
        count++;
      } catch (e) {
        // Strategy B: RAG fallback - search for alternative approach
        log("Opening failed, trying RAG: " + String(e).slice(0, 80));
        try {
          const ragResult = await ragSearch("create opening in wall for " + op.type);
          log("RAG suggestion: " + ragResult.slice(0, 200));
          // Even if RAG gives info, create standalone element as minimum
          if (op.type === "door") {
            const dr = await mcpTool("create_door", {
              name: op.name, dimensions: { height: op.height, width: op.width },
              location: [pos[0], pos[1], 0], operation_type: "SINGLE_SWING_LEFT"
            });
            const g = getGuid(dr, "door_guid", "guid");
            if (g) { elemGuids.set(op.name, g); count++; }
          } else {
            const wr = await mcpTool("create_window", {
              name: op.name, dimensions: { width: op.width, height: op.height },
              location: pos, partition_type: "SINGLE_PANEL"
            });
            const g = getGuid(wr, "window_guid", "guid");
            if (g) { elemGuids.set(op.name, g); count++; }
          }
          steps.push("⚠ " + op.type + " '" + op.name + "' (standalone, RAG-assisted fallback)");
        } catch (e2) {
          steps.push("✗ " + op.type + " '" + op.name + "': all strategies failed");
        }
      }
    }
  }

  // ── Phase 4: Create Slabs ──
  for (const s of plan.elements.filter(e => e.type === "slab") as SlabElement[]) {
    try {
      const r = await mcpTool("create_slab", { name: s.name, outline_points: s.outline, thickness: s.thickness });
      const g = getGuid(r, "slab_guid", "guid");
      if (g) elemGuids.set(s.name, g);
      steps.push("✓ Slab '" + s.name + "'"); count++;
      if (s.style) styles.push({ el: s.name, style: s.style });
    } catch (e) { steps.push("✗ Slab '" + s.name + "': " + String(e).slice(0, 80)); }
  }

  // ── Phase 5: Create Roofs ──
  for (const r of plan.elements.filter(e => e.type === "roof") as RoofElement[]) {
    try {
      const res = await mcpTool("create_roof", {
        name: r.name, polyline: r.outline, roof_type: r.roof_type || "FLAT",
        angle: r.angle || 30, thickness: r.thickness || 0.25
      });
      const g = getGuid(res, "roof_guid", "guid");
      if (g) elemGuids.set(r.name, g);
      steps.push("✓ Roof '" + r.name + "'"); count++;
      if (r.style) styles.push({ el: r.name, style: r.style });
    } catch (e) { steps.push("✗ Roof '" + r.name + "': " + String(e).slice(0, 80)); }
  }

  // ── Phase 6: Create Stairs ──
  for (const s of plan.elements.filter(e => e.type === "stairs") as StairsElement[]) {
    try {
      await mcpTool("create_stairs", {
        name: s.name, location: s.location, num_risers: s.num_risers,
        riser_height: s.riser_height, tread_depth: s.tread_depth, width: s.width
      });
      steps.push("✓ Stairs '" + s.name + "'"); count++;
    } catch (e) { steps.push("✗ Stairs '" + s.name + "': " + String(e).slice(0, 80)); }
  }

  // ── Phase 7: Apply Styles ──
  if (styles.length > 0) {
    const created = new Set<string>();
    for (const { el, style } of styles) {
      try {
        if (!created.has(style.name)) {
          await mcpTool("create_surface_style", {
            name: style.name, surface_color: style.color,
            transparency: style.transparency ?? 0
          });
          created.add(style.name);
        }
        const g = elemGuids.get(el);
        if (g) {
          await mcpTool("apply_style_to_object", { object_guids: g, style_name: style.name });
          steps.push("✓ Style '" + style.name + "' → '" + el + "'");
        }
      } catch (e) { steps.push("⚠ Style: " + String(e).slice(0, 60)); }
    }
  }

  const okItems = steps.filter(s => s.startsWith("✓")).map(s => s.slice(2));
  return {
    summary: (plan.description || "Built") + ". Created " + count + " elements: " + okItems.join(", ") + ".",
    steps,
    count
  };
}

// ═══════════════════════════════════════════
// HTTP HANDLER
// ═══════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!GEMINI_API_KEY) return new Response(JSON.stringify({ error: "No API key" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  debugLog.length = 0;
  mcpSessionId = "";
  try {
    const { messages } = await req.json() as { messages: { role: string; content: string }[] };
    const last = messages?.filter(m => m.role === "user").pop();
    if (!last) return new Response(JSON.stringify({ error: "No message" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    log("User: " + last.content.slice(0, 200));

    // 1. Plan
    const p = await plan(last.content);
    if (p.type === "chat") return new Response(JSON.stringify({ reply: p.reply }), { headers: { ...CORS, "Content-Type": "application/json" } });

    // 2. Validate
    const v = validate(p.plan!);
    if (!v.valid) return new Response(JSON.stringify({ reply: "Validation failed: " + v.errors.join(". "), debug: debugLog }), { headers: { ...CORS, "Content-Type": "application/json" } });

    // 3. Connect MCP
    await mcpInit();

    // 4. Execute with all strategies
    const r = await execute(p.plan!);
    log("Done: " + r.count + " elements");

    // 5. Export
    let ifc_url: string | undefined;
    if (r.count > 0) {
      try {
        const ex = await mcpTool("export_ifc", { session_id: mcpSessionId || "default" });
        if ((ex as Record<string, unknown>).success && (ex as Record<string, unknown>).file_url)
          ifc_url = (ex as Record<string, unknown>).file_url as string;
      } catch (e) { log("Export err: " + e); }
    }

    const body: Record<string, unknown> = { reply: r.summary, steps: r.steps, debug: debugLog };
    if (ifc_url) body.ifc_url = ifc_url;
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    log("FATAL: " + err);
    return new Response(JSON.stringify({ error: String(err).slice(0, 400), debug: debugLog }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
