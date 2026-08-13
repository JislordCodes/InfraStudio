import { CORS, callQwen, callGemini, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Lead Architectural Reasoning Agent for InfraStudio.
Your mission is to transform a design brief into a complete, spatially coherent, visually striking, and mathematically sound architectural plan or edit plan.

ARCHITECTURAL DIVERSITY & FOOTPRINT SELECTION (CRITICAL FOR NEW BUILDINGS):
 1. DIVERSE & CREATIVE FOOTPRINTS: Unless the user explicitly requests a plain rectangular box, dynamically choose an expressive architectural footprint shape for new builds:
    - "L-SHAPE": Main living wing along X (e.g. 8x5m) + perpendicular private wing along Y (e.g. 5x6m starting at origin [0,5,0]), creating a protected terrace/courtyard angle.
    - "U-SHAPE / COURTYARD": Two parallel side wings (e.g. Bedrooms & Garage) connected by a central living wing, surrounding a central open outdoor courtyard.
    - "OFFSET DUAL-VOLUME": Two rectangular volumes offset from each other (e.g. Ground Floor Wing 1 at [0,0,0], Wing 2 shifted to [3,2,0], or a cantilevered 2nd floor volume).
    - "T-SHAPE / CROSS": Central entry/circulation spine with function wings protruding outward.
    - "MODERN OPEN PAVILION": Wide glass-fronted modern pavilion with attached side volume (garage, porch, deck).
 2. DO NOT output the exact same basic 2x2 rectangular block every time. Vary room dimensions, orientations, and roof styles to match modern architectural design!

SPATIAL AXIOMS & RULES:
 1. ALL ROOMS REQUIRED: Include EVERY room specified in room_requirements (Living Room, Bedrooms, Kitchen, Bathrooms, Hallways, Garages, Balconies, etc.).
 2. FLUSH WALL BOUNDARIES: Adjacent rooms MUST share exact flush boundary coordinates so internal and external walls connect seamlessly.
 3. DOORS: EVERY room MUST have at least one door connecting to a circulation space (Living Room, Hallway, or Entry) UNLESS the user explicitly requests no doors or elements are omitted.
    - If the user explicitly asks for NO DOORS, or to omit doors, set "doors": [] explicitly on all rooms AND set "allow_no_doors": true in the root JSON.
 4. WINDOWS: Windows MUST ONLY be placed on EXTERIOR walls. If the user asks for NO WINDOWS, set "windows": [] explicitly on all rooms AND set "allow_no_windows": true in the root JSON.
 5. FLOOR & CEILING SLABS: Rooms have floor slabs and ceiling slabs by default. If the user asks to omit slabs (e.g. open sky / no ceiling slab, or dirt floor / no floor slab), set "floor_slab": false and/or "ceiling_slab": false on that room.
 6. ROOF: Choose a roof type ("gable", "flat", "hip", "shed", "butterfly"). If user wants no roof, set "roof_type": "none".
 7. MATERIALS: Specify a harmonious material palette (e.g. white render + cedar cladding, exposed concrete + black steel, light timber + slate).

ITERATIVE EDITS & MODIFICATIONS (WHEN is_edit = true):
 1. When modifying an active existing model (is_edit = true), DO NOT erase or rebuild the building from scratch.
 2. If adding new rooms or storeys (e.g. garage, balcony, 2nd floor, extra bedroom):
    - Output "new_storeys": Array of any new floors/storeys (e.g. [{"name": "First Floor", "elevation": 3.0, "height": 3.0}]).
    - Output "new_rooms": Array of new room objects with precise origin [x,y,z], width, length, doors, windows, floor_slab, ceiling_slab, attached to or above the existing structure.
 3. Output "target_actions": List of concrete edit actions (e.g., add_room, add_window, add_door, add_balcony, change_roof, apply_material, delete_element).
 4. Output "material_palette": Any updated material finishes requested by user.

Strict Restrictions:
 * Return ONLY raw JSON matching the schema below. Start your output immediately with '{'.

Expected JSON Schema:
{
  "is_edit": boolean,
  "roof_type": "flat|gable|hip|shed|butterfly|none",
  "has_stairs": boolean,
  "allow_no_doors": boolean,
  "allow_no_windows": boolean,
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
          "floor_slab": boolean,
          "ceiling_slab": boolean,
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
  "new_storeys": [
    {
      "name": "string",
      "elevation": number,
      "height": number
    }
  ],
  "new_rooms": [
    {
      "name": "string",
      "width": number,
      "length": number,
      "origin": [number, number, number],
      "floor_slab": boolean,
      "ceiling_slab": boolean,
      "doors": [],
      "windows": []
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

const infrastructurePrompt = `You are the Lead Structural Engineering Agent for InfraStudio.
Your mission is to transform a structured design brief into a mathematically sound, complete, component-based structural model for non-buildings and engineering structures (structural frames, column grids, foundations/pad bases, beam networks, bridges, towers, MEP systems).

STRUCTURAL FRAMES & COLUMN GRIDS (CRITICAL MATHEMATICAL RULES):
 1. CENTER POSITIONING RULES (trimesh Box extents=[length, width, height] is centered at position [x,y,z]):
    - For vertical columns of height H starting at elevation Z_start:
      Position Z_center = Z_start + H / 2.
    - For pad bases/footings (IfcFooting) under columns at ground level (Z=0):
      Dimensions e.g. { length: 1.5, width: 1.5, height: 0.6 }.
      Position Z_center = 0.3m (or -0.3m if below ground).
    - For longitudinal beams along X (length L = spacing along X, e.g. 5m):
      Position X_center = X_start + L / 2.
    - For transverse beams along Y (width W = spacing along Y, e.g. 5m):
      Position Y_center = Y_start + W / 2.

 2. GRID COMPUTATION EXAMPLE (e.g. 4 columns in X row x 5 columns in Y col, 3 storeys):
    - Grid X coordinates: [0, 5, 10, 15] (4 columns = 3 bays of 5m = 15m span).
    - Grid Y coordinates: [0, 5, 10, 15, 20] (5 columns = 4 bays of 5m = 20m span).
    - Storey heights: 3m per storey (Storey 1: Z=0 to 3m; Storey 2: Z=3 to 6m; Storey 3: Z=6 to 9m).
    - Step 1: Create Pad Bases (IfcFooting) at Z=0.3m under each grid intersection (X, Y).
    - Step 2: Create Columns (IfcColumn) per storey:
      * Storey 1 columns at Z_center = 1.5m (from 0 to 3m).
      * Storey 2 columns at Z_center = 4.5m (from 3 to 6m).
      * Storey 3 columns at Z_center = 7.5m (from 6 to 9m).
    - Step 3: Create Beams (IfcBeam) connecting columns at each storey top (Z=3m, Z=6m, Z=9m):
      * X-Beams: length=5m, centered at (X + 2.5, Y, Z_level).
      * Y-Beams: width=5m, centered at (X, Y + 2.5, Z_level).

 3. DO NOT OMIT COMPONENTS: Generate EVERY single column, beam, and footing required to form a fully connected, complete structural frame.

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
      "ifc_class": "IfcColumn | IfcBeam | IfcFooting | IfcSlab | IfcMember | IfcBuildingElementProxy",
      "geometry_type": "box | cylinder | sphere | custom_trimesh",
      "dimensions": { "length": number, "width": number, "height": number },
      "position": [number, number, number],
      "rotation": [number, number, number],
      "material": "string"
    }
  ],
  "material_palette": {
    "primary": "reinforced structural concrete",
    "secondary": "structural steel S355",
    "accent": "galvanized steel"
  },
  "structural_notes": ["string"]
}`;

type Opening = { wall?: string; offset?: number; width?: number; height?: number; sill_height?: number; operation_type?: string };
type Room = { name?: string; width?: number; length?: number; height?: number; origin?: number[]; floor_slab?: boolean; ceiling_slab?: boolean; doors?: Opening[]; windows?: Opening[] };

const WALLS = ["south", "east", "north", "west"];

function wallLength(room: Room, wall: string): number {
  return wall === "south" || wall === "north" ? Number(room.width || 4) : Number(room.length || 4);
}

function originToOffset(opening: any, room: Room): number {
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

function processRooms(rooms: Room[], allowNoDoors = false): void {
  alignFloorplanGrid(rooms);
  for (const room of rooms) {
    if ((room as any).dimensions && Array.isArray((room as any).dimensions)) {
      room.width = Number((room as any).dimensions[0]);
      room.length = Number((room as any).dimensions[1]);
    }
    room.width = Math.max(2.2, Number(room.width || 4));
    room.length = Math.max(2.2, Number(room.length || 4));
    room.origin = Array.isArray(room.origin) ? room.origin : [0, 0, 0];

    const hasExplicitDoors = room.doors !== undefined && room.doors !== null;
    room.doors = (Array.isArray(room.doors) ? room.doors : []).map((door) => clampOpening(door, room, 0.9));
    
    const hasExplicitWindows = room.windows !== undefined && room.windows !== null;
    room.windows = (Array.isArray(room.windows) ? room.windows : [])
      .map((window) => clampOpening(window, room, 1.2))
      .filter((window) => !isInternalWall(room, String(window.wall), rooms));

    // ONLY generate a default door if the model didn't explicitly specify doors (even as doors:[])
    if (!hasExplicitDoors && room.doors.length === 0 && !allowNoDoors) {
      const wall = pickDoorWall(room, rooms);
      room.doors.push(clampOpening({ wall, offset: wallLength(room, wall) / 2 - 0.45, width: 0.9, height: 2.1 }, room, 0.9));
    }

    room.windows = room.windows.filter((window) => !room.doors!.some((door) => openingsOverlap(window, door)));
  }
}

function repairPlan(plan: any, brief?: any): any {
  if (!plan || typeof plan !== "object") plan = {};
  for (const key of ["architectural_analysis", "design_plan", "building_plan", "project_plan", "layout_plan"]) {
    if (plan[key] && typeof plan[key] === "object") {
      plan = { ...plan[key], ...plan };
    }
  }

  const allowNoDoors = Boolean(plan.allow_no_doors);

  if (plan.is_edit) {
    if (Array.isArray(plan.new_rooms)) {
      processRooms(plan.new_rooms, allowNoDoors);
    }
    return plan;
  }

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

    let rooms: Room[] = [];
    if (Array.isArray(storey.rooms)) {
      rooms = storey.rooms;
    } else if (Array.isArray(plan.rooms)) {
      rooms = plan.rooms;
    } else if (Array.isArray(plan.new_rooms)) {
      rooms = plan.new_rooms;
    }

    // Fallback: If rooms is empty but brief has room_requirements, construct clean rooms
    if (rooms.length === 0 && Array.isArray(brief?.room_requirements) && brief.room_requirements.length > 0) {
      let curX = 0;
      for (const req of brief.room_requirements) {
        const area = Number(req.suggested_area || 16);
        const side = Math.max(3.5, Math.round(Math.sqrt(area)));
        rooms.push({
          name: req.name || "Room",
          width: side,
          length: side,
          origin: [curX, 0, 0],
          floor_slab: true,
          ceiling_slab: true,
          doors: [{ wall: "south", offset: side / 2 - 0.45, width: 0.9, height: 2.1 }],
          windows: [{ wall: "north", offset: side / 2 - 0.6, width: 1.2, height: 1.4, sill_height: 0.9 }]
        });
        curX += side;
      }
    }

    processRooms(rooms, allowNoDoors);
    storey.rooms = rooms;

    // ONLY add exterior doors if we don't have explicit instructions to omit doors
    if (!allowNoDoors) {
      const hasExteriorDoor = rooms.some((room) => room.doors?.some((door) => !isInternalWall(room, String(door.wall), rooms)));
      if (!hasExteriorDoor && rooms.length > 0) {
        const target = rooms.find((room) => /living|entry|corridor|kitchen/i.test(String(room.name))) || rooms[0];
        const wall = WALLS.find((candidate) => !isInternalWall(target, candidate, rooms)) || "south";
        target.doors = target.doors || [];
        target.doors!.push(clampOpening({ wall, offset: wallLength(target, wall) / 2 - 0.5, width: 1.0, height: 2.1 }, target, 1.0));
      }
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

  // Use qwen3.8-max for Architect Agent
  let res = await callQwen(prompt, promptStr, true, "qwen3.8-max");
  if (!res || res.trim().length < 5) {
    throw new Error("qwen3.8-max returned an empty or invalid response.");
  }

  // Attempt JSON parse — retry once if it fails
  let parsed: any;
  try {
    parsed = cleanJsonResponse(res);
  } catch (firstErr) {
    console.warn("[handleArchitect] First parse failed, retrying with clean prompt:", String(firstErr).slice(0, 120));
    const retryPrompt = `You are an architect AI. Return ONLY valid JSON — no markdown, no text, no thinking.
The user wants: ${brief.project_type || "a building"} with these rooms: ${(brief.room_requirements || []).map((r: any) => r.name).join(", ")}.
Output a JSON object with keys: is_edit(false), roof_type, has_stairs, material_palette, storey_plans(array of floors with rooms having name/width/length/origin[x,y,z]/doors[]/windows[]), special_elements, structural_notes.`;
    res = await callQwen(retryPrompt, JSON.stringify(brief.room_requirements || brief), true, "qwen3.8-max");
    parsed = cleanJsonResponse(res);
  }

  if (isBuilding) {
    return repairPlan(parsed, brief);
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
