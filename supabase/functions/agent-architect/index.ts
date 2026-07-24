
import { CORS, callQwen, callGemini, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Architectural Reasoning Agent for InfraStudio.
Your mission is to transform a structured architectural brief into a complete, spatially coherent, mathematically sound layout or edit plan.

Spatial Axioms & Rules:
 1. ALL ROOMS REQUIRED: Include EVERY room specified in room_requirements (e.g. Bedrooms, Living Room, Kitchen, Bathroom, Corridor, Entry, Balcony, Garage, Utility). Never omit requested rooms.
 2. FLUSH GRID LAYOUT (CRITICAL):
    - Arrange rooms in a clean 2D grid of rows and columns starting from origin [0,0,0].
    - Adjacent rooms MUST share exact flush boundary lines. If Row 1 ends at Y=5.0m, Row 2 MUST start at Y=5.0m across all columns. If Column 1 ends at X=5.0m, Column 2 MUST start at X=5.0m across all rows.
    - NEVER leave unbuilt gaps, staggered wall offsets, or narrow dead strips between rooms. All internal walls must form continuous straight grid lines.
 3. DOORS (CRITICAL):
    - EVERY room MUST have at least one door connecting to a circulation space (Living Room, Corridor, or Entry).
    - MAIN ENTRY: The Entry/Living Room MUST have an exterior door opening to the outside world.
    - Door offset must be between 0.45m and (wall_length - width - 0.45m).
 4. WINDOWS (CRITICAL):
    - Windows MUST ONLY be placed on EXTERIOR walls. Never place windows on interior partition walls.
 5. ROOF & SPECIAL FEATURES:
    - Set "roof_type": "gable" | "flat" | "hip" based on brief (default "flat" for apartments, "gable" for houses).
    - Capture any special elements (balcony, stairs, columns, porch) in "special_elements".
 6. MATERIALS:
    - Include material_palette mapping wall, floor, door, window_glass, roof_or_ceiling to requested materials.
 7. EDITS & REVISONS:
    - If is_edit=true, set storey_plans=[] and provide explicit tool actions in "target_actions".

Strict Restrictions:
 * Return ONLY raw JSON matching the schema below.
 * CRITICAL: Start your output immediately with '{'. Do NOT wrap JSON in outer keys like "architectural_analysis". Output ONLY root keys: "is_edit", "roof_type", "has_stairs", "material_palette", "storey_plans".

Expected JSON Schema:
{
  "is_edit": boolean,
  "roof_type": "flat|gable|hip",
  "has_stairs": boolean,
  "material_palette": {
    "wall": "string",
    "floor": "string",
    "door": "string",
    "window_glass": "string",
    "roof_or_ceiling": "string"
  },
  "storey_plans": [
    {
      "name": "string",
      "elevation": number,
      "height": number,
      "rooms": [
        {
          "name": "string",
          "width": number,
          "length": number,
          "origin": [number, number, number],
          "doors": [
            {
              "wall": "south|east|north|west",
              "offset": number,
              "width": number,
              "height": number
            }
          ],
          "windows": [
            {
              "wall": "south|east|north|west",
              "offset": number,
              "width": number,
              "height": number,
              "sill_height": number
            }
          ]
        }
      ]
    }
  ],
  "special_elements": ["string"],
  "target_actions": [
    {
      "action": "string",
      "target": "string",
      "parameters": {}
    }
  ],
  "structural_notes": ["string"]
}`;

const infrastructurePrompt = `You are the Structural Design Agent for InfraStudio.
Your mission is to transform a structured design brief into a precise component-based construction plan for NON-BUILDING structures (bridges, tunnels, towers, MEP systems, custom geometry).

You must output a JSON plan with components, each specifying:
- name: descriptive name
- ifc_class: the IFC class to use (IfcBeam, IfcColumn, IfcSlab, IfcMember, IfcFooting, IfcBuildingElementProxy, IfcPipeSegment, IfcDuctSegment, etc.)
- geometry_type: "box" | "cylinder" | "sphere" | "custom_trimesh"
- dimensions: { length, width, height } for box, { radius, height } for cylinder, { radius } for sphere
- position: [x, y, z] center position in meters
- rotation: [rx, ry, rz] rotation in degrees (optional, default [0,0,0])
- material: material description string
- trimesh_code: (only for geometry_type="custom_trimesh") Python trimesh code. MUST assign result variable. Available: trimesh.primitives.Box, Cylinder, Sphere, Extrusion. Boolean: .union(), .difference(), .intersection(). Transform: .apply_translation([x,y,z]), .apply_transform(matrix).

Spatial Rules:
 1. Use a RIGHT-HANDED coordinate system: X=length, Y=width, Z=up.
 2. Position components so they connect properly (e.g. bridge piers touch the underside of the deck).
 3. Use realistic engineering dimensions (bridge deck thickness ~0.8-1.5m, pier diameter ~1-2m, etc.).
 4. For bridges: deck at top, piers below connecting deck to ground (z=0).
 5. For MEP: pipes and ducts should connect end-to-end with realistic diameters.

Strict Restrictions:
 * Return ONLY raw JSON.
 * Do NOT include rooms, doors, or windows.
 * Start output immediately with '{'.

Expected JSON Schema:
{
  "structure_category": "infrastructure" | "mep" | "custom",
  "is_edit": false,
  "structure_name": "string",
  "components": [
    {
      "name": "string",
      "ifc_class": "string",
      "geometry_type": "box | cylinder | sphere | custom_trimesh",
      "dimensions": {},
      "position": [number, number, number],
      "rotation": [number, number, number],
      "material": "string",
      "trimesh_code": "string (optional)"
    }
  ],
  "material_palette": {
    "primary": "string",
    "secondary": "string",
    "accent": "string"
  },
  "structural_notes": ["string"]
}`;

type Opening = { wall?: string; offset?: number; width?: number; height?: number; sill_height?: number; operation_type?: string };
type Room = { name?: string; width?: number; length?: number; height?: number; origin?: number[]; doors?: Opening[]; windows?: Opening[] };

const WALLS = ["south", "east", "north", "west"];

function wallLength(room: Room, wall: string): number {
  return wall === "south" || wall === "north" ? Number(room.width || 4) : Number(room.length || 4);
}

function originToOffset(opening: any, room: Room): number {
  // Gemini sometimes outputs door/window position as 'origin:[x,y,z]' instead of 'offset:number'
  // Convert: for south/north walls offset is along X axis; for east/west offset is along Y axis
  if (opening.offset !== undefined && opening.offset !== null) return Number(opening.offset);
  if (Array.isArray(opening.origin)) {
    const [ox, oy] = opening.origin as number[];
    const [rx, ry] = (room.origin || [0, 0, 0]) as number[];
    const wall = String(opening.wall || "south");
    if (wall === "south" || wall === "north") return Math.abs(ox - rx);
    if (wall === "east" || wall === "west")  return Math.abs(oy - ry);
  }
  return 0.9;
}

function clampOpening(opening: Opening, room: Room, defaultWidth: number): Opening {
  const wall = WALLS.includes(String(opening.wall)) ? String(opening.wall) : "south";
  const width = Math.max(0.6, Math.min(Number(opening.width || defaultWidth), wallLength(room, wall) - 0.9));
  const maxOffset = Math.max(0.45, wallLength(room, wall) - width - 0.45);
  const rawOffset = originToOffset(opening, room);
  const offset = Math.max(0.45, Math.min(rawOffset, maxOffset));
  return { ...opening, wall, width, offset };
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.max(a0, b0) < Math.min(a1, b1) - 0.05;
}

function isInternalWall(room: Room, wall: string, rooms: Room[]): boolean {
  const [x, y] = room.origin || [0, 0, 0];
  const w = Number(room.width || 4);
  const l = Number(room.length || 4);

  return rooms.some((other) => {
    if (other === room) return false;
    const [ox, oy] = other.origin || [0, 0, 0];
    const ow = Number(other.width || 4);
    const ol = Number(other.length || 4);

    if (wall === "south" && Math.abs(y - (oy + ol)) < 0.05) return rangesOverlap(x, x + w, ox, ox + ow);
    if (wall === "north" && Math.abs(y + l - oy) < 0.05) return rangesOverlap(x, x + w, ox, ox + ow);
    if (wall === "west" && Math.abs(x - (ox + ow)) < 0.05) return rangesOverlap(y, y + l, oy, oy + ol);
    if (wall === "east" && Math.abs(x + w - ox) < 0.05) return rangesOverlap(y, y + l, oy, oy + ol);
    return false;
  });
}

function pickDoorWall(room: Room, rooms: Room[]): string {
  return WALLS.find((wall) => isInternalWall(room, wall, rooms)) ||
    WALLS.find((wall) => !isInternalWall(room, wall, rooms)) ||
    "south";
}

function openingsOverlap(a: Opening, b: Opening): boolean {
  if (a.wall !== b.wall) return false;
  const a0 = Number(a.offset || 0);
  const a1 = a0 + Number(a.width || 0.9);
  const b0 = Number(b.offset || 0);
  const b1 = b0 + Number(b.width || 1.2);
  return rangesOverlap(a0, a1, b0, b1);
}

function alignFloorplanGrid(rooms: Room[]): void {
  if (!rooms || rooms.length <= 1) return;

  const xCoords: number[] = [];
  const yCoords: number[] = [];

  for (const r of rooms) {
    const [x, y] = r.origin || [0, 0, 0];
    const w = Number(r.width || 4);
    const l = Number(r.length || 4);
    xCoords.push(x, x + w);
    yCoords.push(y, y + l);
  }

  xCoords.sort((a, b) => a - b);
  yCoords.sort((a, b) => a - b);

  const clusterMap = (coords: number[], tolerance = 1.2) => {
    const map = new Map<number, number>();
    for (const c of coords) {
      let matchedTarget: number | null = null;
      for (const target of map.values()) {
        if (Math.abs(c - target) <= tolerance) {
          matchedTarget = target;
          break;
        }
      }
      if (matchedTarget !== null) {
        map.set(c, matchedTarget);
      } else {
        map.set(c, c);
      }
    }
    return map;
  };

  const xMap = clusterMap(xCoords, 1.2);
  const yMap = clusterMap(yCoords, 1.2);

  for (const r of rooms) {
    const [x, y, z] = r.origin || [0, 0, 0];
    const w = Number(r.width || 4);
    const l = Number(r.length || 4);

    const snappedX = xMap.get(x) ?? x;
    const snappedRightX = xMap.get(x + w) ?? (x + w);
    const snappedY = yMap.get(y) ?? y;
    const snappedTopY = yMap.get(y + l) ?? (y + l);

    r.origin = [Number(snappedX.toFixed(2)), Number(snappedY.toFixed(2)), z];
    r.width = Math.max(2.2, Number((snappedRightX - snappedX).toFixed(2)));
    r.length = Math.max(2.2, Number((snappedTopY - snappedY).toFixed(2)));
  }
}

function repairPlan(plan: any): any {
  if (!plan) return {};
  if (typeof plan === "object") {
    for (const key of ["architectural_analysis", "design_plan", "building_plan", "project_plan", "layout_plan"]) {
      if (plan[key] && typeof plan[key] === "object") {
        plan = { ...plan[key], ...plan };
      }
    }
  }

  if (plan.is_edit) return plan;

  if (!Array.isArray(plan.storey_plans) || plan.storey_plans.length === 0) {
    plan.storey_plans = [
      {
        name: "Ground Floor",
        elevation: 0,
        height: 3,
        rooms: Array.isArray(plan.rooms) ? plan.rooms : []
      }
    ];
  }

  for (const storey of plan.storey_plans) {
    if (!storey.name && storey.storey_name) storey.name = storey.storey_name;
    storey.height = Number(storey.height || 3);

    if (!Array.isArray(storey.rooms) && Array.isArray(plan.rooms)) {
      storey.rooms = plan.rooms;
    }

    const rooms: Room[] = Array.isArray(storey.rooms) ? storey.rooms : [];
    alignFloorplanGrid(rooms);
    for (const room of rooms) {
      if ((room as any).dimensions && Array.isArray((room as any).dimensions)) {
        room.width = Number((room as any).dimensions[0]);
        room.length = Number((room as any).dimensions[1]);
      }
      room.width = Math.max(2.2, Number(room.width || 4));
      room.length = Math.max(2.2, Number(room.length || 4));
      room.origin = Array.isArray(room.origin) ? room.origin : [0, 0, 0];

      room.doors = (Array.isArray(room.doors) ? room.doors : []).map((door) => clampOpening(door, room, 0.9));
      room.windows = (Array.isArray(room.windows) ? room.windows : [])
        .map((window) => clampOpening(window, room, 1.2))
        .filter((window) => !isInternalWall(room, String(window.wall), rooms));

      if (room.doors!.length === 0) {
        const wall = pickDoorWall(room, rooms);
        room.doors!.push(clampOpening({ wall, offset: wallLength(room, wall) / 2 - 0.45, width: 0.9, height: 2.1 }, room, 0.9));
      }

      room.windows = room.windows.filter((window) => !room.doors!.some((door) => openingsOverlap(window, door)));
    }

    const hasExteriorDoor = rooms.some((room) => room.doors?.some((door) => !isInternalWall(room, String(door.wall), rooms)));
    if (!hasExteriorDoor && rooms.length > 0) {
      const target = rooms.find((room) => /living|entry|corridor|kitchen/i.test(String(room.name))) || rooms[0];
      const wall = WALLS.find((candidate) => !isInternalWall(target, candidate, rooms)) || "south";
      target.doors = target.doors || [];
      target.doors!.push(clampOpening({ wall, offset: wallLength(target, wall) / 2 - 0.5, width: 1.0, height: 2.1 }, target, 1.0));
    }
  }

  plan.material_palette = plan.material_palette || {
    wall: "painted plaster over blockwork",
    floor: "polished concrete or porcelain tile",
    door: "warm wood veneer",
    window_glass: "clear low-e glass",
    roof_or_ceiling: "white gypsum ceiling"
  };

  return plan;
}

export async function handleArchitect(brief: any): Promise<any> {
  const category = brief.structure_category || "building";
  const isBuilding = category === "building";
  const prompt = isBuilding ? systemPrompt : infrastructurePrompt;
  
  let promptStr = JSON.stringify(brief);
  if (brief.reviewHistory) {
    promptStr += `\n\nPREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(brief.reviewHistory)}`;
  }

  // EXCLUSIVELY use Gemini 3.6 Flash (Strict, zero fallbacks)
  let geminiRes = await callGemini(prompt, promptStr, true, "gemini-3.6-flash");
  if (!geminiRes || geminiRes.trim().length < 5) {
    throw new Error("Gemini 3.6 Flash returned an empty or invalid response.");
  }

  // Attempt JSON parse — retry once if it fails (Gemini occasionally adds commentary)
  let parsed: any;
  try {
    parsed = cleanJsonResponse(geminiRes);
  } catch (firstErr) {
    console.warn("[handleArchitect] First parse failed, retrying with clean prompt:", String(firstErr).slice(0, 120));
    const retryPrompt = `You are an architect AI. Return ONLY valid JSON — no markdown, no text, no thinking.
The user wants: ${brief.project_type || "a building"} with these rooms: ${(brief.room_requirements || []).map((r: any) => r.name).join(", ")}.
Output a JSON object with keys: is_edit(false), roof_type, has_stairs, material_palette, storey_plans(array of floors with rooms having name/width/length/origin[x,y,z]/doors[]/windows[]), special_elements, structural_notes.`;
    geminiRes = await callGemini(retryPrompt, JSON.stringify(brief.room_requirements || brief), true, "gemini-3.6-flash");
    parsed = cleanJsonResponse(geminiRes);
  }

  if (isBuilding) {
    return repairPlan(parsed);
  } else {
    parsed.structure_category = category;
    parsed.is_edit = false;
    return parsed;
  }
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const brief = await req.json();
      const result = await handleArchitect(brief);
      return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  });
}
