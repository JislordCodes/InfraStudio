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
type SpatialEdge = { from: string; to: string; from_wall: string; to_wall: string; shared_length: number };
type SpatialConstraintResult = {
  status: "PASS";
  repairs: string[];
  issues: string[];
  adjacency_graph: { nodes: string[]; edges: SpatialEdge[] };
  exterior_walls: Record<string, string[]>;
};

const WALLS = ["south", "east", "north", "west"];

/*
 * The LLM is a planner, not the source of truth for minimum model content.  A
 * short or truncated JSON response used to pass straight through to the BIM
 * agent, which is why a request for an apartment could become one box.  These
 * program templates are deliberately conventional and give the executor a
 * complete, connected baseline whenever the proposed plan is incomplete.
 */
function requestedText(brief: any): string {
  return [
    brief?.project_type,
    ...(brief?.special_features || []),
    ...(brief?.constraints || []),
    ...(brief?.room_requirements || []).map((room: any) => room.name)
  ].filter(Boolean).join(" ").toLowerCase();
}

function room(name: string, width: number, length: number, x: number, y: number, z: number): Room {
  return {
    name, width, length, origin: [x, y, z], floor_slab: true, ceiling_slab: true,
    doors: [], windows: []
  };
}

function apartmentProgram(brief: any): any[] {
  const requestedStoreys = Math.max(2, Math.min(12, Number(brief?.storeys?.length || 4)));
  const plans: any[] = [];
  for (let floor = 0; floor < requestedStoreys; floor++) {
    const z = floor * 3.2;
    const rooms: Room[] = floor === 0
      ? [
          room("Entrance Lobby", 5, 4, 0, 0, z), room("Reception", 4, 4, 5, 0, z),
          room("Stair and Lift Core", 4, 5, 0, 4, z), room("Ground Floor Corridor", 10, 2, 4, 4, z),
          room("Service Room", 4, 3, 10, 0, z), room("Accessible Apartment", 7, 7, 10, 3, z)
        ]
      : [
          room("Stair and Lift Core", 4, 5, 0, 0, z), room("Central Corridor", 14, 2, 4, 3, z),
          room(`Apartment ${floor}A Living Kitchen`, 7, 5, 4, 0, z), room(`Apartment ${floor}A Bedroom`, 5, 4, 11, 0, z),
          room(`Apartment ${floor}A Bathroom`, 3, 3, 16, 0, z), room(`Apartment ${floor}B Living Kitchen`, 7, 5, 4, 5, z),
          room(`Apartment ${floor}B Bedroom`, 5, 4, 11, 5, z), room(`Apartment ${floor}B Bathroom`, 3, 3, 16, 5, z)
        ];
    plans.push({ name: floor === 0 ? "Ground Floor" : `Level ${floor}`, elevation: z, height: 3.2, rooms });
  }
  return plans;
}

function apartmentUnitProgram(brief: any): any[] {
  const requested = Array.isArray(brief?.room_requirements) ? brief.room_requirements : [];
  const requestedNames = requested.map((item: any) => String(item.name || "").toLowerCase()).join(" ");
  const text = requestedText(brief);
  const numberedBedrooms = new Set<string>();
  requestedNames.replace(/bed(?:room)?\s*(\d+)/g, (_match, number) => {
    numberedBedrooms.add(String(number));
    return "";
  });
  const explicitBedroomRooms = requested.filter((item: any) => {
    const name = String(item.name || "").toLowerCase();
    return /bed(room)?/.test(name) && !/bath|toilet|wc|ensuite|en-suite/.test(name);
  }).length;
  const textBedroomMatch = text.match(/\b(\d+)\s*(?:bed|bedroom)\b/);
  const wordBedroomCount = /\bthree\s*(?:bed|bedroom)/.test(text) ? 3 : /\btwo\s*(?:bed|bedroom)/.test(text) ? 2 : /\bone\s*(?:bed|bedroom)/.test(text) ? 1 : 0;
  const bedrooms = Math.max(1, Math.min(6, Number(textBedroomMatch?.[1] || 0) || wordBedroomCount || numberedBedrooms.size || explicitBedroomRooms || 1));
  const variant = Math.abs(Number(brief?.design_seed || Date.now())) % 4;
  const rooms: Room[] = [];

  if (variant === 0) {
    rooms.push(room("Parlour / Living Room", 6, 5, 0, 0, 0), room("Kitchen", 3, 5, 6, 0, 0));
    for (let bedroom = 0; bedroom < bedrooms; bedroom++) {
      const y = 5 + bedroom * 4;
      rooms.push(room(`Bedroom ${bedroom + 1}`, 4.5, 4, 0, y, 0));
      rooms.push(room(`Bedroom ${bedroom + 1} En-suite Bathroom`, 2.5, 2, 4.5, y, 0));
    }
  } else if (variant === 1) {
    rooms.push(room("Parlour / Living Room", 5.8, 4.8, 3.2, 0, 0), room("Kitchen", 3.4, 3.6, 9, 0, 0));
    for (let bedroom = 0; bedroom < bedrooms; bedroom++) {
      if (bedroom % 2 === 0) {
        const y = 4.8 + Math.floor(bedroom / 2) * 4.2;
        rooms.push(room(`Bedroom ${bedroom + 1}`, 4.4, 4.2, 3.2, y, 0));
        rooms.push(room(`Bedroom ${bedroom + 1} En-suite Bathroom`, 2.4, 2.2, 7.6, y, 0));
      } else {
        const y = 0 + Math.floor(bedroom / 2) * 4.2;
        rooms.push(room(`Bedroom ${bedroom + 1}`, 4.2, 4.2, -1.0, y, 0));
        rooms.push(room(`Bedroom ${bedroom + 1} En-suite Bathroom`, 2.2, 2.2, -3.2, y, 0));
      }
    }
  } else if (variant === 2) {
    rooms.push(room("Entry Hall", 3.2, 3.2, 0, 0, 0), room("Parlour / Living Room", 6.2, 4.6, 3.2, 0, 0), room("Kitchen", 3.4, 4.6, 9.4, 0, 0));
    for (let bedroom = 0; bedroom < bedrooms; bedroom++) {
      const x = bedroom % 2 === 0 ? 0 : 5.2;
      const y = 3.2 + Math.floor(bedroom / 2) * 6.4;
      rooms.push(room(`Bedroom ${bedroom + 1}`, 5.2, 4.2, x, y, 0));
      rooms.push(room(`Bedroom ${bedroom + 1} En-suite Bathroom`, 2.6, 2.2, x + 2.6, y + 4.2, 0));
    }
  } else {
    rooms.push(room("Parlour / Living Room", 5.4, 5.2, 0, 0, 0), room("Kitchen", 3.8, 3.2, 5.4, 0, 0), room("Dining Nook", 3.8, 2.0, 5.4, 3.2, 0));
    for (let bedroom = 0; bedroom < bedrooms; bedroom++) {
      const y = bedroom === 0 ? 5.2 : 5.2 + (bedroom - 1) * 4.1;
      const x = bedroom === 0 ? 0 : 4.6;
      rooms.push(room(`Bedroom ${bedroom + 1}`, 4.6, 4.1, x, y, 0));
      rooms.push(room(`Bedroom ${bedroom + 1} En-suite Bathroom`, 2.3, 2.1, x + 4.6, y, 0));
    }
  }

  // Provide actual external windows. build_room only creates openings supplied
  // in the plan, so relying on the model to remember them caused failed reviews.
  const living = rooms.find((item) => /living|parlour/.test(String(item.name).toLowerCase())) || rooms[0];
  const kitchen = rooms.find((item) => /kitchen/.test(String(item.name).toLowerCase())) || rooms[1];
  if (living) living.windows = [{ wall: "south", offset: 2.1, width: 1.8, height: 1.4, sill_height: 0.9 }];
  if (kitchen) kitchen.windows = [{ wall: "east", offset: 1.2, width: 1.2, height: 1.2, sill_height: 1.0 }];
  rooms.filter((item) => /^Bedroom \d+$/.test(String(item.name))).forEach((item) => {
    item.windows = [{ wall: "west", offset: 1.5, width: 1.2, height: 1.2, sill_height: 0.9 }];
  });
  return [{ name: `Ground Floor Apartment Variant ${variant + 1}`, elevation: 0, height: 3.2, rooms }];
}

function creativeHouseProgram(seed: number): { storeys: any[]; footprint: number[][]; roof: string } {
  const variant = Math.abs(seed) % 3;
  if (variant === 0) {
    return {
      roof: "hip",
      footprint: [[0, 0], [10, 0], [10, 5], [6, 5], [6, 9], [0, 9]],
      storeys: [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms: [
        room("Living Room", 6, 5, 0, 0, 0), room("Kitchen Dining", 4, 3, 6, 0, 0),
        room("Primary Bedroom", 4, 4, 0, 5, 0), room("Bathroom", 2, 2.5, 4, 5, 0), room("Study", 4, 2, 6, 3, 0)
      ] }]
    };
  }
  if (variant === 1) {
    return {
      roof: "gable",
      footprint: [[0, 0], [12, 0], [12, 4], [8, 4], [8, 8], [4, 8], [4, 4], [0, 4]],
      storeys: [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms: [
        room("Living Room", 4, 4, 4, 0, 0), room("Kitchen Dining", 4, 4, 8, 0, 0), room("Entry Hall", 4, 4, 0, 0, 0),
        room("Primary Bedroom", 4, 4, 4, 4, 0), room("Bathroom", 2, 4, 2, 4, 0)
      ] }]
    };
  }
  return {
    roof: "shed",
    footprint: [[0, 0], [12, 0], [12, 9], [8, 9], [8, 5], [4, 5], [4, 9], [0, 9]],
    storeys: [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms: [
      room("Living Room", 4, 5, 4, 0, 0), room("Kitchen Dining", 4, 5, 8, 0, 0), room("Entry Hall", 4, 5, 0, 0, 0),
      room("Primary Bedroom", 4, 4, 0, 5, 0), room("Bathroom", 4, 4, 8, 5, 0)
    ] }]
  };
}

function minimumBuildingPlan(brief: any): any[] {
  const text = requestedText(brief);
  if (brief?.autonomous_design) return creativeHouseProgram(Number(brief?.design_seed || Date.now())).storeys;
  if (/residential block|multi.?family|apartment block|flats?|multi.?storey/.test(text)) return apartmentProgram(brief);
  if (/apartment/.test(text)) return apartmentUnitProgram(brief);

  const requirements = Array.isArray(brief?.room_requirements) ? brief.room_requirements : [];
  const rooms: Room[] = [];
  const source = requirements.length ? requirements : [
    { name: "Entrance Hall", suggested_area: 10 }, { name: "Living Room", suggested_area: 28 },
    { name: "Kitchen", suggested_area: 16 }, { name: "Bedroom", suggested_area: 16 }, { name: "Bathroom", suggested_area: 7 }
  ];
  let x = 0, y = 0;
  source.forEach((requirement: any, index: number) => {
    const area = Math.max(7, Number(requirement.suggested_area || 16));
    const width = Math.max(2.8, Math.round(Math.sqrt(area) * 10) / 10);
    const length = Math.max(2.8, Math.round((area / width) * 10) / 10);
    rooms.push(room(requirement.name || `Room ${index + 1}`, width, length, x, y, 0));
    if (index % 2 === 0) x += width; else { y += length; x = 0; }
  });
  return [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms }];
}

function bridgeProgram(name: string): any[] {
  const components: any[] = [];
  const span = 48, deckWidth = 12, deckZ = 9;
  components.push({ name: "Bridge deck slab", ifc_class: "IfcSlab", geometry_type: "box", dimensions: { length: span, width: deckWidth, height: 0.8 }, position: [span / 2, 0, deckZ], material: "reinforced concrete" });
  components.push({ name: "West abutment", ifc_class: "IfcFooting", geometry_type: "box", dimensions: { length: 2.5, width: deckWidth + 2, height: 7 }, position: [0, 0, 3.5], material: "reinforced concrete" });
  components.push({ name: "East abutment", ifc_class: "IfcFooting", geometry_type: "box", dimensions: { length: 2.5, width: deckWidth + 2, height: 7 }, position: [span, 0, 3.5], material: "reinforced concrete" });
  [16, 32].forEach((x, i) => {
    components.push({ name: `Pier ${i + 1} footing`, ifc_class: "IfcFooting", geometry_type: "box", dimensions: { length: 5, width: 5, height: 1.2 }, position: [x, 0, 0.6], material: "reinforced concrete" });
    components.push({ name: `Pier ${i + 1}`, ifc_class: "IfcColumn", geometry_type: "box", dimensions: { length: 3, width: 4, height: 7.2 }, position: [x, 0, 4.2], material: "reinforced concrete" });
  });
  [-4.5, 4.5].forEach((y, i) => components.push({ name: `Main steel girder ${i + 1}`, ifc_class: "IfcBeam", geometry_type: "box", dimensions: { length: span, width: 0.7, height: 1.6 }, position: [span / 2, y, deckZ - 1.1], material: "structural steel" }));
  [-6, 6].forEach((y, i) => components.push({ name: `Safety parapet ${i + 1}`, ifc_class: "IfcMember", geometry_type: "box", dimensions: { length: span, width: 0.15, height: 1.3 }, position: [span / 2, y, deckZ + 1], material: "galvanized steel" }));
  return components;
}

function railwayProgram(): any[] {
  const components: any[] = [
    { name: "Railway ballast bed", ifc_class: "IfcSlab", geometry_type: "box", dimensions: { length: 80, width: 6, height: 0.5 }, position: [40, 0, 0], material: "crushed stone ballast" },
    { name: "Left rail", ifc_class: "IfcMember", geometry_type: "box", dimensions: { length: 80, width: 0.15, height: 0.18 }, position: [40, -0.75, 0.55], material: "steel rail" },
    { name: "Right rail", ifc_class: "IfcMember", geometry_type: "box", dimensions: { length: 80, width: 0.15, height: 0.18 }, position: [40, 0.75, 0.55], material: "steel rail" }
  ];
  for (let x = 0; x <= 80; x += 1) components.push({ name: `Sleeper ${x + 1}`, ifc_class: "IfcMember", geometry_type: "box", dimensions: { length: 0.25, width: 2.8, height: 0.2 }, position: [x, 0, 0.35], material: "precast concrete" });
  return components;
}

function ensureInfrastructurePlan(plan: any, brief: any): any {
  const text = requestedText(brief);
  // Bridge and rail systems are safety-critical, repeatable assemblies.  Do
  // not let a plausible-looking list of arbitrary cubes override the known
  // load path / track template merely because it contains enough items.
  if (/bridge/.test(text)) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Bridge", components: bridgeProgram(brief?.project_type || "Bridge"), quality_requirements: { minimum_components: 8, required_element_types: ["IfcSlab", "IfcColumn", "IfcBeam", "IfcFooting"] } };
  }
  if (/rail|railway|track/.test(text)) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Railway", components: railwayProgram(), quality_requirements: { minimum_components: 30, required_element_types: ["IfcSlab", "IfcMember"] } };
  }
  const minimum = /bridge/.test(text) ? 8 : /rail|railway|track/.test(text) ? 30 : 4;
  if (Array.isArray(plan?.components) && plan.components.length >= minimum) return plan;
  const components = plan?.components || [];
  return { ...plan, structure_category: brief?.structure_category || "infrastructure", is_edit: false, structure_name: brief?.project_type || "InfraStudio Infrastructure", components, quality_requirements: { minimum_components: minimum } };
}

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

  // Only snap near-identical coordinates. The former 1.2m tolerance could
  // silently shrink rooms and turn an intended layout into overlapping boxes.
  const clusterMap = (coords: number[], tolerance = 0.05) => {
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

  const xMap = clusterMap(xCoords, 0.05);
  const yMap = clusterMap(yCoords, 0.05);

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

function roomBounds(room: Room) {
  const [x, y] = room.origin || [0, 0, 0];
  return { x0: Number(x), y0: Number(y), x1: Number(x) + Number(room.width || 4), y1: Number(y) + Number(room.length || 4) };
}

function roomsOverlap(a: Room, b: Room): boolean {
  const A = roomBounds(a), B = roomBounds(b);
  return Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) > 0.05 && Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) > 0.05;
}

function roomsTouch(a: Room, b: Room): boolean {
  const A = roomBounds(a), B = roomBounds(b);
  const xOverlap = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
  const yOverlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  return (Math.abs(A.x1 - B.x0) < 0.06 || Math.abs(B.x1 - A.x0) < 0.06) && yOverlap > 0.4 ||
    (Math.abs(A.y1 - B.y0) < 0.06 || Math.abs(B.y1 - A.y0) < 0.06) && xOverlap > 0.4;
}

function roomId(room: Room, index: number): string {
  return `${index + 1}:${String(room.name || `Room ${index + 1}`)}`;
}

function sharedBoundary(a: Room, b: Room): { aWall: string; bWall: string; sharedLength: number } | null {
  const A = roomBounds(a), B = roomBounds(b);
  const xOverlap = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
  const yOverlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  if (Math.abs(A.x1 - B.x0) < 0.06 && yOverlap > 0.4) return { aWall: "east", bWall: "west", sharedLength: Number(yOverlap.toFixed(2)) };
  if (Math.abs(B.x1 - A.x0) < 0.06 && yOverlap > 0.4) return { aWall: "west", bWall: "east", sharedLength: Number(yOverlap.toFixed(2)) };
  if (Math.abs(A.y1 - B.y0) < 0.06 && xOverlap > 0.4) return { aWall: "north", bWall: "south", sharedLength: Number(xOverlap.toFixed(2)) };
  if (Math.abs(B.y1 - A.y0) < 0.06 && xOverlap > 0.4) return { aWall: "south", bWall: "north", sharedLength: Number(xOverlap.toFixed(2)) };
  return null;
}

function buildAdjacencyGraph(rooms: Room[]): { nodes: string[]; edges: SpatialEdge[]; exteriorWalls: Map<Room, string[]> } {
  const nodes = rooms.map(roomId);
  const edges: SpatialEdge[] = [];
  const internalWalls = new Map<Room, Set<string>>();
  rooms.forEach((room) => internalWalls.set(room, new Set()));

  rooms.forEach((room, index) => {
    rooms.slice(index + 1).forEach((other, offset) => {
      const boundary = sharedBoundary(room, other);
      if (!boundary) return;
      const otherIndex = index + 1 + offset;
      internalWalls.get(room)!.add(boundary.aWall);
      internalWalls.get(other)!.add(boundary.bWall);
      edges.push({
        from: roomId(room, index),
        to: roomId(other, otherIndex),
        from_wall: boundary.aWall,
        to_wall: boundary.bWall,
        shared_length: boundary.sharedLength,
      });
    });
  });

  const exteriorWalls = new Map<Room, string[]>();
  for (const room of rooms) {
    const internal = internalWalls.get(room) || new Set<string>();
    exteriorWalls.set(room, WALLS.filter((wall) => !internal.has(wall)));
  }
  return { nodes, edges, exteriorWalls };
}

function roomPriority(room: Room): number {
  const name = String(room.name || "").toLowerCase();
  if (/corridor|hall|lobby|entry|entrance|stair|core|living|parlour|reception/.test(name)) return 0;
  if (/kitchen|dining/.test(name)) return 1;
  if (/bed/.test(name) && !/bath|toilet|ensuite|en-suite/.test(name)) return 2;
  if (/bath|toilet|wc|ensuite|en-suite/.test(name)) return 3;
  return 4;
}

function chooseAnchor(room: Room, placed: Room[]): Room {
  const name = String(room.name || "").toLowerCase();
  if (/ensuite|en-suite/.test(name)) {
    const bedroomToken = name.match(/bedroom\s*\d+/)?.[0];
    const match = placed.find((candidate) => bedroomToken && String(candidate.name || "").toLowerCase().includes(bedroomToken));
    if (match) return match;
  }
  if (/kitchen|dining/.test(name)) {
    return placed.find((candidate) => /living|parlour|reception|dining/.test(String(candidate.name || "").toLowerCase())) || placed[0];
  }
  if (/bath|toilet|wc/.test(name)) {
    return placed.find((candidate) => /bed|corridor|hall|core/.test(String(candidate.name || "").toLowerCase())) || placed[0];
  }
  if (/bed/.test(name)) {
    return placed.find((candidate) => /corridor|hall|living|parlour|core/.test(String(candidate.name || "").toLowerCase())) || placed[0];
  }
  return placed[0];
}

function preferredDirections(room: Room): string[] {
  const name = String(room.name || "").toLowerCase();
  if (/ensuite|en-suite|bath|toilet|wc/.test(name)) return ["east", "west", "north", "south"];
  if (/kitchen|dining/.test(name)) return ["east", "north", "south", "west"];
  if (/bed/.test(name)) return ["north", "west", "east", "south"];
  return ["east", "north", "west", "south"];
}

function candidateOrigin(anchor: Room, room: Room, direction: string): number[] {
  const A = roomBounds(anchor);
  const w = Number(room.width || 4);
  const l = Number(room.length || 4);
  const z = Number(anchor.origin?.[2] || room.origin?.[2] || 0);
  if (direction === "east") return [A.x1, A.y0, z];
  if (direction === "west") return [A.x0 - w, A.y0, z];
  if (direction === "north") return [A.x0, A.y1, z];
  return [A.x0, A.y0 - l, z];
}

function roomWouldOverlap(room: Room, rooms: Room[]): boolean {
  return rooms.some((other) => roomsOverlap(room, other));
}

function semanticPackRooms(rooms: Room[]): void {
  if (rooms.length <= 1) return;
  const ordered = [...rooms].sort((a, b) => roomPriority(a) - roomPriority(b));
  const baseZ = Number(ordered[0].origin?.[2] || 0);
  ordered[0].origin = [0, 0, baseZ];

  const placed: Room[] = [ordered[0]];
  for (const room of ordered.slice(1)) {
    const anchor = chooseAnchor(room, placed);
    let placedRoom = false;
    const anchors = [anchor, ...placed.filter((candidate) => candidate !== anchor)];
    for (const candidate of anchors) {
      for (const direction of preferredDirections(room)) {
        room.origin = candidateOrigin(candidate, room, direction);
        if (!roomWouldOverlap(room, placed)) {
          placedRoom = true;
          break;
        }
      }
      if (placedRoom) break;
    }

    if (!placedRoom) {
      const bounds = placed.reduce((acc, item) => {
        const b = roomBounds(item);
        return { minX: Math.min(acc.minX, b.x0), minY: Math.min(acc.minY, b.y0), maxX: Math.max(acc.maxX, b.x1), maxY: Math.max(acc.maxY, b.y1) };
      }, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
      room.origin = [bounds.maxX, bounds.minY, baseZ];
    }
    placed.push(room);
  }
}

function layoutIsConnected(rooms: Room[]): boolean {
  if (rooms.length < 2) return true;
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length) {
    const current = queue.shift()!;
    rooms.forEach((room, index) => {
      if (!seen.has(index) && roomsTouch(rooms[current], room)) { seen.add(index); queue.push(index); }
    });
  }
  return seen.size === rooms.length;
}

function reflowConnectedLayout(rooms: Room[]): void {
  semanticPackRooms(rooms);
}

function validateAndRepairLayout(rooms: Room[]): { status: "PASS"; repairs: string[] } {
  const repairs: string[] = [];
  const overlaps = rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other)));
  if (overlaps || !layoutIsConnected(rooms)) {
    reflowConnectedLayout(rooms);
    repairs.push(overlaps ? "Reflowed overlapping room footprints into a connected plan." : "Reflowed disconnected room footprints into a connected plan.");
  }
  if (rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other))) || !layoutIsConnected(rooms)) {
    throw new Error("Spatial layout validation failed: rooms remain overlapping or disconnected after repair.");
  }
  return { status: "PASS", repairs };
}

function doorTouchesBoundary(room: Room, wall: string, rooms: Room[]): boolean {
  return rooms.some((other) => other !== room && sharedBoundary(room, other)?.aWall === wall);
}

function ensureNonOverlappingOpenings(openings: Opening[], room: Room, defaultWidth: number): Opening[] {
  const result: Opening[] = [];
  for (const opening of openings) {
    const clean = clampOpening(opening, room, defaultWidth);
    if (!Number.isFinite(Number(clean.offset)) || !Number.isFinite(Number(clean.width))) continue;
    if (result.some((existing) => openingsOverlap(existing, clean))) {
      const wall = String(clean.wall || "south");
      const width = Number(clean.width || defaultWidth);
      const maxOffset = Math.max(0.45, wallLength(room, wall) - width - 0.45);
      let foundOffset: number | null = null;
      for (let offset = 0.45; offset <= maxOffset; offset += 0.25) {
        const candidate = { ...clean, offset: Number(offset.toFixed(2)) };
        if (!result.some((existing) => openingsOverlap(existing, candidate))) {
          foundOffset = candidate.offset!;
          break;
        }
      }
      if (foundOffset === null) continue;
      clean.offset = foundOffset;
    }
    result.push(clean);
  }
  return result;
}

function buildDoorConnectivity(rooms: Room[]): Set<number> {
  const graph = buildAdjacencyGraph(rooms);
  const connected = new Set<number>();
  const start = rooms.findIndex((room) => /living|parlour|corridor|hall|entry|entrance|lobby|core/i.test(String(room.name || "")));
  connected.add(start >= 0 ? start : 0);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      const fromIndex = graph.nodes.indexOf(edge.from);
      const toIndex = graph.nodes.indexOf(edge.to);
      const fromHasDoor = rooms[fromIndex]?.doors?.some((door) => door.wall === edge.from_wall);
      const toHasDoor = rooms[toIndex]?.doors?.some((door) => door.wall === edge.to_wall);
      if (!fromHasDoor && !toHasDoor) continue;
      if (connected.has(fromIndex) && !connected.has(toIndex)) { connected.add(toIndex); changed = true; }
      if (connected.has(toIndex) && !connected.has(fromIndex)) { connected.add(fromIndex); changed = true; }
    }
  }
  return connected;
}

function enforceSpatialConstraints(rooms: Room[], allowNoDoors = false, allowNoWindows = false): SpatialConstraintResult {
  const repairs: string[] = [];
  const issues: string[] = [];
  alignFloorplanGrid(rooms);

  if (rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other))) || !layoutIsConnected(rooms)) {
    semanticPackRooms(rooms);
    alignFloorplanGrid(rooms);
    repairs.push("Solved room placement with adjacency-aware no-overlap packing.");
  }

  let graph = buildAdjacencyGraph(rooms);
  if (!layoutIsConnected(rooms)) {
    issues.push("Rooms are still disconnected after constraint packing.");
  }
  if (rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other)))) {
    issues.push("Rooms still overlap after constraint packing.");
  }

  if (!allowNoDoors && rooms.length > 0) {
    const hasExteriorDoor = rooms.some((room) =>
      room.doors?.some((door) => graph.exteriorWalls.get(room)?.includes(String(door.wall)))
    );
    if (!hasExteriorDoor) {
      const target = rooms.find((room) => /living|parlour|entry|entrance|lobby|corridor|hall|core/i.test(String(room.name || ""))) || rooms[0];
      const exteriorWall = graph.exteriorWalls.get(target)?.[0];
      if (exteriorWall) {
        target.doors = target.doors || [];
        target.doors.push(clampOpening({ wall: exteriorWall, offset: wallLength(target, exteriorWall) / 2 - 0.5, width: 1.0, height: 2.1 }, target, 1.0));
        repairs.push(`Added exterior entrance door to ${target.name || "room"} on ${exteriorWall} wall.`);
      }
    }
  }

  for (const room of rooms) {
    room.doors = ensureNonOverlappingOpenings(Array.isArray(room.doors) ? room.doors : [], room, 0.9);
    room.windows = ensureNonOverlappingOpenings(Array.isArray(room.windows) ? room.windows : [], room, 1.2)
      .filter((window) => graph.exteriorWalls.get(room)?.includes(String(window.wall)));

    if (!allowNoDoors) {
      const internalWall = WALLS.find((wall) => doorTouchesBoundary(room, wall, rooms));
      const hasInternalDoor = internalWall && room.doors.some((door) => door.wall === internalWall);
      if (internalWall && !hasInternalDoor) {
        room.doors.push(clampOpening({ wall: internalWall, offset: wallLength(room, internalWall) / 2 - 0.45, width: 0.9, height: 2.1 }, room, 0.9));
        repairs.push(`Added circulation door to ${room.name || "room"} on ${internalWall} wall.`);
      }
    }

    if (!allowNoWindows && room.windows.length === 0) {
      const exteriorWall = graph.exteriorWalls.get(room)?.[0];
      if (exteriorWall) {
        room.windows.push(clampOpening({ wall: exteriorWall, offset: wallLength(room, exteriorWall) / 2 - 0.6, width: 1.2, height: 1.3, sill_height: 0.9 }, room, 1.2));
        repairs.push(`Added exterior window to ${room.name || "room"} on ${exteriorWall} wall.`);
      }
    }

    room.doors = ensureNonOverlappingOpenings(room.doors, room, 0.9);
    room.windows = ensureNonOverlappingOpenings(room.windows.filter((window) => !room.doors!.some((door) => openingsOverlap(window, door))), room, 1.2);
  }

  if (!allowNoDoors && rooms.length > 1) {
    let connected = buildDoorConnectivity(rooms);
    for (let guard = 0; connected.size < rooms.length && guard < rooms.length * 2; guard++) {
      const targetIndex = rooms.findIndex((_, index) => !connected.has(index));
      if (targetIndex < 0) break;
      const edge = graph.edges.find((candidate) => {
        const fromIndex = graph.nodes.indexOf(candidate.from);
        const toIndex = graph.nodes.indexOf(candidate.to);
        return (fromIndex === targetIndex && connected.has(toIndex)) || (toIndex === targetIndex && connected.has(fromIndex));
      });
      if (!edge) break;
      const fromIndex = graph.nodes.indexOf(edge.from);
      const targetWall = fromIndex === targetIndex ? edge.from_wall : edge.to_wall;
      const room = rooms[targetIndex];
      room.doors = room.doors || [];
      room.doors.push(clampOpening({ wall: targetWall, offset: wallLength(room, targetWall) / 2 - 0.45, width: 0.9, height: 2.1 }, room, 0.9));
      room.doors = ensureNonOverlappingOpenings(room.doors, room, 0.9);
      repairs.push(`Connected ${room.name || "room"} into the door circulation graph.`);
      connected = buildDoorConnectivity(rooms);
    }
    if (connected.size < rooms.length) {
      issues.push("Door circulation graph is not fully connected.");
    }
  }

  graph = buildAdjacencyGraph(rooms);
  for (const room of rooms) {
    for (const window of room.windows || []) {
      if (!graph.exteriorWalls.get(room)?.includes(String(window.wall))) {
        issues.push(`${room.name || "Room"} has a window on an internal wall.`);
      }
    }
    for (const opening of [...(room.doors || []), ...(room.windows || [])]) {
      if (Number(opening.offset || 0) < 0 || Number(opening.offset || 0) + Number(opening.width || 0) > wallLength(room, String(opening.wall))) {
        issues.push(`${room.name || "Room"} has an opening that does not fit on its host wall.`);
      }
    }
  }

  if (issues.length) {
    throw new Error(`Spatial constraint validation failed: ${[...new Set(issues)].join(" ")}`);
  }

  const exterior_walls: Record<string, string[]> = {};
  rooms.forEach((room, index) => { exterior_walls[roomId(room, index)] = graph.exteriorWalls.get(room) || []; });
  return {
    status: "PASS",
    repairs: [...new Set(repairs)],
    issues: [],
    adjacency_graph: { nodes: graph.nodes, edges: graph.edges },
    exterior_walls,
  };
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

    if (!room.origin.every((coordinate) => Number.isFinite(Number(coordinate)))) {
      throw new Error(`Spatial layout validation failed: ${room.name || "room"} has a non-finite coordinate.`);
    }

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
    if (!hasExplicitWindows && room.windows.length === 0 && !Boolean((room as any).allow_no_windows)) {
      const exteriorWall = WALLS.find((wall) => !isInternalWall(room, wall, rooms));
      if (exteriorWall) {
        room.windows.push(clampOpening({ wall: exteriorWall, offset: wallLength(room, exteriorWall) / 2 - 0.6, width: 1.2, height: 1.3, sill_height: 0.9 }, room, 1.2));
      }
    }
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
  const allowNoWindows = Boolean(plan.allow_no_windows);
  const layoutRepairs: string[] = [];
  const constraintAudits: any[] = [];

  if (brief?.autonomous_design && !plan.is_edit) {
    const generated = creativeHouseProgram(Number(brief?.design_seed || Date.now()));
    plan.storey_plans = generated.storeys;
    plan.roof_footprint = generated.footprint;
    plan.roof_type = generated.roof;
    plan.design_seed = brief?.design_seed || Date.now();
  }

  if (plan.is_edit) {
    if (Array.isArray(plan.new_rooms)) {
      processRooms(plan.new_rooms, allowNoDoors);
      layoutRepairs.push(...validateAndRepairLayout(plan.new_rooms).repairs);
      const audit = enforceSpatialConstraints(plan.new_rooms, allowNoDoors, allowNoWindows);
      layoutRepairs.push(...audit.repairs);
      constraintAudits.push({ scope: "new_rooms", ...audit });
    }
    plan.layout_validation = { status: "PASS", repairs: [...new Set(layoutRepairs)], constraint_audits: constraintAudits };
    return plan;
  }

  if (!Array.isArray(plan.storey_plans) || plan.storey_plans.length === 0) {
    plan.storey_plans = Array.isArray(plan.rooms) && plan.rooms.length
      ? [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms: plan.rooms }]
      : minimumBuildingPlan(brief);
  }

  const expectedRooms = Array.isArray(brief?.room_requirements) ? brief.room_requirements.length : 0;
  const proposedRooms = plan.storey_plans.reduce((total: number, storey: any) => total + (Array.isArray(storey.rooms) ? storey.rooms.length : 0), 0);
  const text = requestedText(brief);
  const isMultiUnit = /residential block|multi.?family|apartment block|flats?|multi.?storey/.test(text);
  const isApartmentUnit = /apartment/.test(text) && !isMultiUnit;
  // Multi-unit buildings need a larger programme, but a single apartment must
  // not be forced into the same fixed high-room-count template every time.
  if ((isMultiUnit && proposedRooms < 10) ||
      (isApartmentUnit && proposedRooms < Math.max(3, expectedRooms || 0)) ||
      (expectedRooms > 0 && proposedRooms < expectedRooms)) {
    plan.storey_plans = minimumBuildingPlan(brief);
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

    processRooms(rooms, allowNoDoors);
    layoutRepairs.push(...validateAndRepairLayout(rooms).repairs);
    const audit = enforceSpatialConstraints(rooms, allowNoDoors, allowNoWindows);
    layoutRepairs.push(...audit.repairs);
    constraintAudits.push({ scope: storey.name || "storey", ...audit });
    storey.rooms = rooms;
  }

  plan.material_palette = plan.material_palette || {
    wall: "painted plaster over blockwork",
    floor: "polished concrete or porcelain tile",
    door: "warm wood veneer",
    window_glass: "clear low-e glass",
    roof_or_ceiling: "white gypsum ceiling"
  };

  const roomCount = plan.storey_plans.reduce((total: number, storey: any) => total + (storey.rooms?.length || 0), 0);
  plan.quality_requirements = {
    minimum_rooms: roomCount,
    minimum_storeys: plan.storey_plans.length,
    required_element_types: ["IfcWall", "IfcSlab", "IfcDoor", "IfcWindow"]
  };
  plan.layout_validation = { status: "PASS", repairs: [...new Set(layoutRepairs)], constraint_audits: constraintAudits };

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
    return ensureInfrastructurePlan({ ...parsed, structure_category: category, is_edit: false }, brief);
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
