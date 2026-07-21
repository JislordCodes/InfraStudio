
import { CORS, callQwen, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Architectural Reasoning Agent for InfraStudio.
Your mission is to transform a structured architectural brief into a spatially coherent, mathematically sound topological layout. You act as the "thinking" brain of the pipeline.

Spatial Axioms & Laws:
 * Rooms must be adjacent non-overlapping rectangles aligned to a clean 2D coordinate grid (origin [x, y, z]).
 * Every defined room MUST have at least one door connecting to a circulation space (Living Room, Corridor, Entry) or an adjacent valid room.
 * MAIN ENTRY: The building MUST have at least one entry door on an exterior wall (usually south or north of the Entry/Living room) leading to the outside world.
 * CIRCULATION: Bathrooms and bedrooms must connect via a central circulation space (Living Room/Corridor/Entry), NEVER through each other.
 * WINDOW PLACEMENT: Windows MUST ONLY be placed on EXTERIOR walls (walls that do not touch any adjacent room).
 * EDGE OFFSETS: Keep all door and window openings at least 0.45m away from wall vertices/corners.
 * OPENING SIZES: Entry doors = 1.0m width, Interior doors = 0.9m width, Bathroom doors = 0.8m width. Living windows = 1.8m width, Bedroom windows = 1.5m width, Bathroom windows = 0.6m width. Standard door height = 2.1m. Standard window sill height = 0.9m, height = 1.2m.
 * Wall names use cardinal directions: "south", "east", "north", "west" relative to the room's local origin. "offset" is the distance in meters from the start of the wall.

Workflow:
 1. Calculate the bounding box coordinates for all requested rooms.
 2. Ensure circulation paths are logical (e.g., bedrooms do not connect through bathrooms).
 3. If "is_edit": true is passed from the Interpreter, focus ONLY on the spatial logic required for the modification.

Strict Restrictions:
 * You MUST NOT generate IFC code or call external tools.
 * Return ONLY raw JSON matching the schema below. No markdown codeblocks or prose.

Expected JSON Schema:
{
  "is_edit": boolean,
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
  "walls": [
    {
      "id": "string",
      "start_pt": [number, number],
      "end_pt": [number, number],
      "thickness": number
    }
  ],
  "openings": [
    {
      "host_wall_id": "string",
      "type": "door|window",
      "offset_from_start": number,
      "width": number
    }
  ],
  "adjacency_graph": ["string"],
  "circulation_paths": ["string"],
  "structural_notes": ["string"],
  "design_rationale": "string"
}`;

type Opening = { wall?: string; offset?: number; width?: number; height?: number; sill_height?: number; operation_type?: string };
type Room = { name?: string; width?: number; length?: number; height?: number; origin?: number[]; doors?: Opening[]; windows?: Opening[] };

const WALLS = ["south", "east", "north", "west"];

function wallLength(room: Room, wall: string): number {
  return wall === "south" || wall === "north" ? Number(room.width || 4) : Number(room.length || 4);
}

function clampOpening(opening: Opening, room: Room, defaultWidth: number): Opening {
  const wall = WALLS.includes(String(opening.wall)) ? String(opening.wall) : "south";
  const width = Math.max(0.6, Math.min(Number(opening.width || defaultWidth), wallLength(room, wall) - 0.9));
  const maxOffset = Math.max(0.45, wallLength(room, wall) - width - 0.45);
  const offset = Math.max(0.45, Math.min(Number(opening.offset || 0.9), maxOffset));
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

function repairPlan(plan: any): any {
  if (!plan || plan.is_edit) return plan;

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
  let promptStr = JSON.stringify(brief);
  if (brief.reviewHistory) {
    promptStr += `\n\nPREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(brief.reviewHistory)}`;
  }
  const res = await callQwen(systemPrompt, promptStr, true, "glm-5.1");
  return repairPlan(cleanJsonResponse(res));
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
