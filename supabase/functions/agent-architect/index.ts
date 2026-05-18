
import { CORS, callGLM, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Architectural Reasoning Agent.
Return ONLY raw JSON. No markdown. No prose.

Mission: convert the brief into a compact, buildable BIM plan.

Spatial laws:
- Rooms are adjacent rectangles in a clean grid.
- Every room has at least one door.
- Main entry opens from exterior into Entry/Living/Circulation.
- Bedrooms/bathrooms connect through Entry/Living/Circulation, not through each other.
- Windows only on exterior walls.
- Keep openings at least 0.45m from wall ends.
- No overlapping doors/windows on the same wall.
- Max 4 rooms per storey unless explicitly requested.

Defaults:
- Height 3m.
- One-bed apartment: LivingKitchen 5x4, Bedroom 4x3.5, Bathroom 2.4x2.2, Entry 2x2.
- Studio: LivingSleeping 5x5, Bathroom 2.4x2.2.
- Door widths: entry 1.0, room 0.9, bathroom 0.8.
- Window widths: living 1.8, bedroom 1.5, bathroom 0.6.
- Wall names: south,east,north,west. offset = distance from wall start.

Materials:
- Always include material_palette with wall, floor, door, window_glass, roof_or_ceiling.

Edits:
- If is_edit=true, return storey_plans=[] and structural_notes with exact target object types and changes.

Silent self-check before output:
1. every room has a door
2. every window is exterior
3. openings do not overlap
4. circulation works
5. materials exist

JSON schema:
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
      "height": "number",
      "rooms": [
        {
          "name": "string",
          "width": "number",
          "length": "number",
          "origin": ["number", "number", "number"],
          "doors": [{"wall": "string", "offset": "number", "width": "number"}],
          "windows": [{"wall": "string", "offset": "number", "width": "number"}]
        }
      ]
    }
  ],
  "structural_notes": ["string"]
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
  if (!plan || plan.is_edit || !Array.isArray(plan.storey_plans)) return plan;

  for (const storey of plan.storey_plans) {
    const rooms: Room[] = Array.isArray(storey.rooms) ? storey.rooms : [];
    for (const room of rooms) {
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const brief = await req.json();
    let promptStr = JSON.stringify(brief);
    if (brief.reviewHistory) {
      promptStr += `\n\nPREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(brief.reviewHistory)}`;
    }
    const msg = await callGLM(systemPrompt, promptStr);
    const result = repairPlan(cleanJsonResponse(msg.content));
    return new Response(JSON.stringify(result), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
