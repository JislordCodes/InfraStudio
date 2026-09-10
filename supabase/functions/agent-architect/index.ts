import { CORS, callQwen, callGemini, callAstra, cleanJsonResponse } from "../_shared/shared.ts";
import { extractPythonCode } from "../_shared/antigravity_kimi_agent.ts";

const systemPrompt = `You are Antigravity's Autonomous Computational BIM Architect & Structural Engineer.
Given the user's design request, write a complete, standalone, runnable Python script that generates an IFC model matching their requirements using IfcOpenShell and Trimesh.
You have complete creative and mathematical freedom: design any architectural form, complex curves, organic roofs, towers, bridges, pavilions, or modern villas without being restricted to rigid box templates.

EXECUTION ENVIRONMENT (AWS Bonsai MCP Server):
- Python 3.11 with ifcopenshell, ifcopenshell.api as api, trimesh, numpy as np, and math pre-imported.
- ifc = get_ifc_file()
- save_and_load_ifc()
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
Return ONLY a JSON object with:
{
  "structure_name": "Descriptive Name",
  "python_code": "Complete executable Python script"
}
Do NOT include thought_process or explanations in the JSON. Focus generation directly on python_code.`;

const infrastructurePrompt = `You are the Lead Structural Engineering Agent for InfraStudio.
Your mission is to transform a structured design brief into a mathematically sound, complete, component-based structural model for non-buildings and engineering structures (cofferdams, bridge piers, structural frames, column grids, foundations/pad bases, beam networks, bridges, towers, MEP systems).

SINGLE-PASS PYTHON CODE EXECUTION (RECOMMENDED):
Whenever possible, output a full, runnable Python script in "python_code" using InfraStudioHarness.
Available harness methods:
- h.create_corrugated_panel(width, height, depth, pitch, thickness, pos, rot_z_deg) (AZ-36 sheet piles)
- h.create_cutwater_pier(length, width, height, nose_r, pos, rot_z_deg) (hydrodynamic bridge piers)
- h.create_i_beam(depth, flange_w, web_t, flange_t, length, pos, rot_z_deg) (walers, girders)
- h.create_pipe(outer_r, inner_r, height, pos, axis) (pipe struts)
- h.create_cylinder(radius, height, pos, axis) (columns, pilings)
- h.create_box(extents, pos, rot_z_deg) (slabs, footings, caps, water planes)
- h.add_mesh_element(mesh, name, ifc_class, mat_name, rgb, transparency)
- count = h.commit()
- save_and_load_ifc()

STRUCTURAL ACCURACY RULES:
1. For cofferdams: Enclose the perimeter with "corrugated_panel" sheet piles, add horizontal "i_beam" waler rings at multiple depth tiers, span "pipe" compression cross struts, and position a central "cutwater_pier" on an "IfcFooting" inside.
2. For bridges: Span deck slabs across multiple pier supports with footings, main girders, and safety parapets.
3. For column frames: Place pad footings at Z=0, columns ascending in Z, and beam networks connecting them at each storey level.
4. Set realistic PBR material names ("Structural Steel AZ-36", "High-Strength Marine Concrete", "River Water Surface") and rgb colors [r, g, b] (between 0.0 and 1.0). For water, set "transparency": 0.55.

Strict Restrictions:
* Return ONLY raw JSON.
* Start output immediately with '{'.

Expected JSON Schema:
{
  "structure_category": "infrastructure" | "mep" | "custom",
  "is_edit": false,
  "structure_name": "string",
  "python_code": "optional full python script using InfraStudioHarness if generating direct code",
  "components": [
    {
      "name": "string",
      "ifc_class": "IfcColumn | IfcBeam | IfcFooting | IfcSlab | IfcMember | IfcWall | IfcBuildingElementProxy",
      "geometry_type": "corrugated_panel | cutwater_pier | i_beam | pipe | cylinder | box | custom_trimesh",
      "dimensions": {
        "length": number, "width": number, "height": number,
        "depth": number, "pitch": number, "thickness": number,
        "outer_radius": number, "inner_radius": number, "nose_radius": number
      },
      "position": [number, number, number],
      "rotation_z": number,
      "material": "string",
      "rgb": [number, number, number],
      "transparency": number
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
    brief?.client_requirements,
    ...(brief?.special_features || []),
    ...(brief?.constraints || []),
    ...(brief?.component_requirements || []).map((c: any) => `${c.name || ""} ${c.type || ""} ${c.description || ""}`),
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

function cofferdamProgram(name: string): any[] {
  const components: any[] = [];
  const W = 16, L = 24, H_pile = 12, Z_water = 4.0;
  
  // 1. Perimeter AZ-36 Sheet Piles (Corrugated panels)
  for (let x = -L/2; x < L/2; x += 2.4) {
    components.push({
      name: `Sheet_Pile_South_${components.length}`,
      ifc_class: "IfcWall",
      geometry_type: "corrugated_panel",
      dimensions: { width: 2.4, height: H_pile, depth: 0.45, pitch: 0.6, thickness: 0.04 },
      position: [x, -W/2, 0],
      rotation_z: 0,
      material: "Structural Steel AZ-36",
      rgb: [0.32, 0.34, 0.36]
    });
    components.push({
      name: `Sheet_Pile_North_${components.length}`,
      ifc_class: "IfcWall",
      geometry_type: "corrugated_panel",
      dimensions: { width: 2.4, height: H_pile, depth: 0.45, pitch: 0.6, thickness: 0.04 },
      position: [x + 2.4, W/2, 0],
      rotation_z: 180,
      material: "Structural Steel AZ-36",
      rgb: [0.32, 0.34, 0.36]
    });
  }
  for (let y = -W/2; y < W/2; y += 2.4) {
    components.push({
      name: `Sheet_Pile_East_${components.length}`,
      ifc_class: "IfcWall",
      geometry_type: "corrugated_panel",
      dimensions: { width: 2.4, height: H_pile, depth: 0.45, pitch: 0.6, thickness: 0.04 },
      position: [L/2, y, 0],
      rotation_z: 90,
      material: "Structural Steel AZ-36",
      rgb: [0.32, 0.34, 0.36]
    });
    components.push({
      name: `Sheet_Pile_West_${components.length}`,
      ifc_class: "IfcWall",
      geometry_type: "corrugated_panel",
      dimensions: { width: 2.4, height: H_pile, depth: 0.45, pitch: 0.6, thickness: 0.04 },
      position: [-L/2, y + 2.4, 0],
      rotation_z: 270,
      material: "Structural Steel AZ-36",
      rgb: [0.32, 0.34, 0.36]
    });
  }

  // 2. Waler Compression Rings (3 tiers: Z = 2.0, 5.0, 8.0)
  [2.0, 5.0, 8.0].forEach((z, tier) => {
    components.push({
      name: `Waler_Tier${tier + 1}_South`,
      ifc_class: "IfcBeam",
      geometry_type: "i_beam",
      dimensions: { depth: 0.6, flange_width: 0.3, length: L },
      position: [-L/2, -W/2 + 0.3, z],
      rotation_z: 0,
      material: "Heavy Waler Steel W24",
      rgb: [0.88, 0.72, 0.15]
    });
    components.push({
      name: `Waler_Tier${tier + 1}_North`,
      ifc_class: "IfcBeam",
      geometry_type: "i_beam",
      dimensions: { depth: 0.6, flange_width: 0.3, length: L },
      position: [-L/2, W/2 - 0.3, z],
      rotation_z: 0,
      material: "Heavy Waler Steel W24",
      rgb: [0.88, 0.72, 0.15]
    });
    components.push({
      name: `Waler_Tier${tier + 1}_East`,
      ifc_class: "IfcBeam",
      geometry_type: "i_beam",
      dimensions: { depth: 0.6, flange_width: 0.3, length: W },
      position: [L/2 - 0.3, -W/2, z],
      rotation_z: 90,
      material: "Heavy Waler Steel W24",
      rgb: [0.88, 0.72, 0.15]
    });
    components.push({
      name: `Waler_Tier${tier + 1}_West`,
      ifc_class: "IfcBeam",
      geometry_type: "i_beam",
      dimensions: { depth: 0.6, flange_width: 0.3, length: W },
      position: [-L/2 + 0.3, -W/2, z],
      rotation_z: 90,
      material: "Heavy Waler Steel W24",
      rgb: [0.88, 0.72, 0.15]
    });

    [-6.0, 0, 6.0].forEach((x, si) => {
      components.push({
        name: `Strut_Tier${tier + 1}_S${si + 1}`,
        ifc_class: "IfcMember",
        geometry_type: "pipe",
        dimensions: { outer_radius: 0.35, inner_radius: 0.30, length: W - 0.6, axis: [0, 1, 0] },
        position: [x, 0, z + 0.3],
        material: "Tubular Steel Strut",
        rgb: [0.88, 0.72, 0.15]
      });
    });
  });

  // 3. Central Concrete Pier with Hydrodynamic Cutwater
  components.push({
    name: "Hydrodynamic_Cutwater_Pier",
    ifc_class: "IfcColumn",
    geometry_type: "cutwater_pier",
    dimensions: { length: 14.0, width: 4.5, height: 11.0, nose_radius: 2.25 },
    position: [0, 0, 0.8],
    material: "High-Strength Marine Concrete C40",
    rgb: [0.65, 0.65, 0.63]
  });

  // 4. Pier Footing Foundation
  components.push({
    name: "Pier_Deep_Footing",
    ifc_class: "IfcFooting",
    geometry_type: "box",
    dimensions: { length: 16.0, width: 6.5, height: 1.2 },
    position: [0, 0, 0.6],
    material: "Reinforced Concrete Footing",
    rgb: [0.55, 0.55, 0.53]
  });

  // 5. Tremie Seal Plug (Dewatered Excavation Bottom)
  components.push({
    name: "Tremie_Concrete_Seal_Plug",
    ifc_class: "IfcSlab",
    geometry_type: "box",
    dimensions: { length: L - 0.2, width: W - 0.2, height: 1.5 },
    position: [0, 0, 0.75],
    material: "Tremie Mass Concrete Plug",
    rgb: [0.45, 0.46, 0.48]
  });

  // 6. Translucent River Water Surface
  components.push({
    name: "River_Water_Surface",
    ifc_class: "IfcBuildingElementProxy",
    geometry_type: "box",
    dimensions: { length: L + 16, width: W + 16, height: 0.1 },
    position: [0, 0, Z_water],
    material: "River Water Surface",
    rgb: [0.20, 0.55, 0.70],
    transparency: 0.55
  });

  return components;
}

function ensureInfrastructurePlan(plan: any, brief: any): any {
  const text = requestedText(brief);
  const isCofferdam = /cofferdam|coffer/i.test(text);
  const isBridge = /bridge/i.test(text);
  const isRail = /rail|railway|track/i.test(text);
  const minimum = isCofferdam ? 20 : isBridge ? 8 : isRail ? 30 : 4;
  const layoutValidation = { status: "PASS", repairs: [], constraint_audits: [] };

  // 1. If Astra generated custom python_code, preserve Astra's code
  if (typeof plan?.python_code === "string" && plan.python_code.trim().length > 20) {
    return {
      ...plan,
      structure_category: "infrastructure",
      is_edit: false,
      structure_name: plan.structure_name || brief?.project_type || "Infrastructure Structure",
      python_code: plan.python_code,
      components: Array.isArray(plan?.components) ? plan.components : [],
      quality_requirements: { minimum_components: minimum },
      layout_validation: layoutValidation
    };
  }

  // 2. If Astra generated a sufficiently detailed list of components, preserve Astra's design!
  if (Array.isArray(plan?.components) && plan.components.length >= minimum) {
    return {
      ...plan,
      structure_category: "infrastructure",
      is_edit: false,
      structure_name: plan.structure_name || brief?.project_type || "Infrastructure Structure",
      components: plan.components,
      quality_requirements: { minimum_components: minimum },
      layout_validation: layoutValidation
    };
  }

  // 3. Fallback to programmatic engineering generator if Astra didn't produce enough components
  if (isCofferdam) {
    return {
      ...plan,
      structure_category: "infrastructure",
      is_edit: false,
      structure_name: brief?.project_type || "Bridge Pier Cofferdam",
      components: cofferdamProgram(brief?.project_type || "Bridge Pier Cofferdam"),
      quality_requirements: { minimum_components: 20, required_element_types: ["IfcWall", "IfcBeam", "IfcMember", "IfcColumn", "IfcFooting", "IfcSlab"] },
      layout_validation: layoutValidation
    };
  }
  if (isBridge) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Bridge", components: bridgeProgram(brief?.project_type || "Bridge"), quality_requirements: { minimum_components: 8, required_element_types: ["IfcSlab", "IfcColumn", "IfcBeam", "IfcFooting"] }, layout_validation: layoutValidation };
  }
  if (isRail) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Railway", components: railwayProgram(), quality_requirements: { minimum_components: 30, required_element_types: ["IfcSlab", "IfcMember"] }, layout_validation: layoutValidation };
  }

  const components = plan?.components || [];
  return { ...plan, structure_category: brief?.structure_category || "infrastructure", is_edit: false, structure_name: brief?.project_type || "InfraStudio Infrastructure", components, quality_requirements: { minimum_components: minimum }, layout_validation: layoutValidation };
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
    let curX = 0;
    const baseZ = Number(rooms[0]?.origin?.[2] || 0);
    for (const room of rooms) {
      room.origin = [curX, 0, baseZ];
      curX += Number(room.width || 4);
    }
    repairs.push("Linear grid alignment applied to guarantee zero overlap and full connectivity.");
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
  alignFloorplanGrid(rooms);

  if (rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other))) || !layoutIsConnected(rooms)) {
    semanticPackRooms(rooms);
    alignFloorplanGrid(rooms);
    repairs.push("Solved room placement with adjacency-aware no-overlap packing.");
  }

  if (rooms.some((room, index) => rooms.slice(index + 1).some((other) => roomsOverlap(room, other))) || !layoutIsConnected(rooms)) {
    let curX = 0;
    const baseZ = Number(rooms[0]?.origin?.[2] || 0);
    for (const room of rooms) {
      room.origin = [curX, 0, baseZ];
      curX += Number(room.width || 4);
    }
    repairs.push("Linear grid alignment applied to guarantee zero overlap and full connectivity.");
  }

  let graph = buildAdjacencyGraph(rooms);

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
      repairs.push("Door circulation graph partially connected.");
    }
  }

  graph = buildAdjacencyGraph(rooms);
  for (const room of rooms) {
    if (Array.isArray(room.windows)) {
      room.windows = room.windows.filter((window) => {
        const isExterior = graph.exteriorWalls.get(room)?.includes(String(window.wall));
        if (!isExterior) {
          repairs.push(`Removed window on internal wall for ${room.name || "room"}.`);
          return false;
        }
        return true;
      });
      room.windows = room.windows.map((window) => clampOpening(window, room, 1.2));
    }
    if (Array.isArray(room.doors)) {
      room.doors = room.doors.map((door) => clampOpening(door, room, 0.9));
    }
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

export function synthesizeBuildingPythonCode(plan: any, brief?: any): string {
  const storeys = Array.isArray(plan.storey_plans) && plan.storey_plans.length > 0
    ? plan.storey_plans
    : [{ name: "Ground Floor", elevation: 0, height: 3.2, rooms: [] }];

  const rawRoof = String(plan.roof_type || "gable").toLowerCase();
  const roofType = rawRoof.includes("none") ? "none" : rawRoof.includes("flat") ? "flat" : rawRoof.includes("shed") ? "shed" : rawRoof.includes("hip") ? "hip" : "gable";
  const rawName = plan.structure_name || brief?.project_type || "InfraStudio Architecture";
  const structureName = String(rawName).replace(/['"\\]/g, "");

  const lines: string[] = [
    "import ifcopenshell",
    "import ifcopenshell.api as api",
    "import trimesh",
    "import numpy as np",
    "import math",
    "",
    "ifc = get_ifc_file()",
    "buildings = ifc.by_type('IfcBuilding')",
    `building = buildings[0] if buildings else api.run('root.create_entity', ifc, ifc_class='IfcBuilding', name="${structureName}")`,
    ""
  ];

  let totalMinX = Infinity, totalMinY = Infinity, totalMaxX = -Infinity, totalMaxY = -Infinity;
  let topZ = 0;

  for (let sIdx = 0; sIdx < storeys.length; sIdx++) {
    const storey = storeys[sIdx];
    const sName = String(storey.name || `Level_${sIdx}`).replace(/['"\\]/g, "");
    const elev = Number(storey.elevation !== undefined ? storey.elevation : sIdx * 3.2);
    const height = Number(storey.height || 3.2);
    topZ = Math.max(topZ, elev + height);

    lines.push(`# ========================================================`);
    lines.push(`# STOREY: ${sName} (Elevation: ${elev}m, Height: ${height}m)`);
    lines.push(`# ========================================================`);
    lines.push(`_st_${sIdx} = api.run('root.create_entity', ifc, ifc_class='IfcBuildingStorey', name="${sName}")`);
    lines.push(`api.run('geometry.edit_object_placement', ifc, product=_st_${sIdx}, matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,${elev},1]])`);
    lines.push(`api.run('aggregate.assign_object', ifc, relating_object=building, products=[_st_${sIdx}])`);
    lines.push(`h_${sIdx} = InfraStudioHarness(ifc, _st_${sIdx})`);
    lines.push("");

    const rooms = Array.isArray(storey.rooms) && storey.rooms.length > 0 ? storey.rooms : [];
    interface RBound { name: string; x: number; y: number; w: number; l: number; windows: any[]; doors: any[]; }
    const rBounds: RBound[] = [];

    if (rooms.length === 0) {
      rBounds.push({ name: "Living Space", x: 0, y: 0, w: 10, l: 8, windows: [], doors: [] });
    } else {
      for (const r of rooms) {
        const ox = Number(r.origin?.[0] || 0);
        const oy = Number(r.origin?.[1] || 0);
        const w = Number(r.width || 5);
        const l = Number(r.length || 4);
        rBounds.push({ name: r.name || "Room", x: ox, y: oy, w, l, windows: r.windows || [], doors: r.doors || [] });
      }
    }

    // 1. Unified Continuous Floor Slab & Cantilever Balcony
    const pad = 0.3;
    const isGround = sIdx === 0;
    const isUpper = sIdx > 0;
    const balcDepth = isUpper ? 1.2 : 0.0;

    const sMinX = Math.min(...rBounds.map(r => r.x));
    const sMinY = Math.min(...rBounds.map(r => r.y));
    const sMaxX = Math.max(...rBounds.map(r => r.x + r.w));
    const sMaxY = Math.max(...rBounds.map(r => r.y + r.l));

    totalMinX = Math.min(totalMinX, sMinX);
    totalMinY = Math.min(totalMinY, sMinY - balcDepth);
    totalMaxX = Math.max(totalMaxX, sMaxX);
    totalMaxY = Math.max(totalMaxY, sMaxY);

    if (isGround) {
      lines.push(`# Ground Floor Continuous Podium Slab`);
      const fp = `[[${(sMinX - pad).toFixed(2)}, ${(sMinY - pad).toFixed(2)}], [${(sMaxX + pad).toFixed(2)}, ${(sMinY - pad).toFixed(2)}], [${(sMaxX + pad).toFixed(2)}, ${(sMaxY + pad).toFixed(2)}], [${(sMinX - pad).toFixed(2)}, ${(sMaxY + pad).toFixed(2)}]]`;
      lines.push(`_slab_${sIdx} = h_${sIdx}.create_slab(${fp}, thickness=0.30, z_elevation=${(elev - 0.30).toFixed(2)})`);
      lines.push(`h_${sIdx}.add_mesh_element(_slab_${sIdx}, "${sName}_Ground_Podium_Slab", ifc_class="IfcSlab", mat_name="Cast-in-Place Structural Concrete", rgb=(0.76, 0.76, 0.74))`);
    } else {
      lines.push(`# Upper Level Continuous Floor Plate with Cantilever Balcony`);
      const fp = `[[${sMinX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], [${sMaxX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], [${sMaxX.toFixed(2)}, ${sMaxY.toFixed(2)}], [${sMinX.toFixed(2)}, ${sMaxY.toFixed(2)}]]`;
      lines.push(`_slab_${sIdx} = h_${sIdx}.create_slab(${fp}, thickness=0.25, z_elevation=${(elev - 0.25).toFixed(2)})`);
      lines.push(`h_${sIdx}.add_mesh_element(_slab_${sIdx}, "${sName}_Cantilever_Floor_Plate", ifc_class="IfcSlab", mat_name="Post-Tensioned Architectural Concrete", rgb=(0.80, 0.80, 0.78))`);
      lines.push(`h_${sIdx}.add_railing([${sMinX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], [${sMaxX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], height=1.05, z_bottom=${elev.toFixed(2)}, name="${sName}_Balcony_Front_Railing", rgb=(0.20, 0.20, 0.22))`);
      lines.push(`h_${sIdx}.add_railing([${sMinX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], [${sMinX.toFixed(2)}, ${sMinY.toFixed(2)}], height=1.05, z_bottom=${elev.toFixed(2)}, name="${sName}_Balcony_West_Railing", rgb=(0.20, 0.20, 0.22))`);
      lines.push(`h_${sIdx}.add_railing([${sMaxX.toFixed(2)}, ${(sMinY - balcDepth).toFixed(2)}], [${sMaxX.toFixed(2)}, ${sMinY.toFixed(2)}], height=1.05, z_bottom=${elev.toFixed(2)}, name="${sName}_Balcony_East_Railing", rgb=(0.20, 0.20, 0.22))`);
    }
    lines.push("");

    // 2. Structural Column Grid along room corners
    lines.push(`# Structural Framing: Columns`);
    const rawCorners: [number, number][] = [];
    for (const rb of rBounds) {
      rawCorners.push([rb.x, rb.y]);
      rawCorners.push([rb.x + rb.w, rb.y]);
      rawCorners.push([rb.x + rb.w, rb.y + rb.l]);
      rawCorners.push([rb.x, rb.y + rb.l]);
    }
    const uniqueCols: [number, number][] = [];
    for (const pt of rawCorners) {
      if (!uniqueCols.some(c => Math.hypot(c[0] - pt[0], c[1] - pt[1]) < 1.4)) {
        uniqueCols.push(pt);
      }
    }
    for (let cIdx = 0; cIdx < uniqueCols.length; cIdx++) {
      const [colX, colY] = uniqueCols[cIdx];
      lines.push(`h_${sIdx}.add_column([${colX.toFixed(2)}, ${colY.toFixed(2)}], height=${height.toFixed(2)}, radius=0.18, z_bottom=${elev.toFixed(2)}, shape="round", name="${sName}_Column_${cIdx + 1}", rgb=(0.84, 0.84, 0.82))`);
    }
    lines.push("");

    // 3. Wall Segments with Genuine Window & Door Opening Voids
    interface RawSeg {
      p1: [number, number];
      p2: [number, number];
      roomName: string;
      windows: any[];
      doors: any[];
    }
    const rawSegments: RawSeg[] = [];
    for (const rb of rBounds) {
      const sWins = rb.windows.filter((w: any) => String(w.wall || "south").toLowerCase() === "south");
      const sDoors = rb.doors.filter((d: any) => String(d.wall || "south").toLowerCase() === "south");
      rawSegments.push({ p1: [rb.x, rb.y], p2: [rb.x + rb.w, rb.y], roomName: rb.name, windows: sWins, doors: sDoors });

      const nWins = rb.windows.filter((w: any) => String(w.wall).toLowerCase() === "north");
      const nDoors = rb.doors.filter((d: any) => String(d.wall).toLowerCase() === "north");
      rawSegments.push({ p1: [rb.x, rb.y + rb.l], p2: [rb.x + rb.w, rb.y + rb.l], roomName: rb.name, windows: nWins, doors: nDoors });

      const eWins = rb.windows.filter((w: any) => String(w.wall).toLowerCase() === "east");
      const eDoors = rb.doors.filter((d: any) => String(d.wall).toLowerCase() === "east");
      rawSegments.push({ p1: [rb.x + rb.w, rb.y], p2: [rb.x + rb.w, rb.y + rb.l], roomName: rb.name, windows: eWins, doors: eDoors });

      const wWins = rb.windows.filter((w: any) => String(w.wall).toLowerCase() === "west");
      const wDoors = rb.doors.filter((d: any) => String(d.wall).toLowerCase() === "west");
      rawSegments.push({ p1: [rb.x, rb.y], p2: [rb.x, rb.y + rb.l], roomName: rb.name, windows: wWins, doors: wDoors });
    }

    interface UWall {
      p1: [number, number];
      p2: [number, number];
      isShared: boolean;
      name: string;
      windows: any[];
      doors: any[];
    }
    const uniqueWalls: UWall[] = [];
    for (const seg of rawSegments) {
      const [ax1, ay1] = seg.p1;
      const [ax2, ay2] = seg.p2;
      const keyA = ax1 < ax2 || (ax1 === ax2 && ay1 < ay2);
      const sp1: [number, number] = keyA ? [ax1, ay1] : [ax2, ay2];
      const sp2: [number, number] = keyA ? [ax2, ay2] : [ax1, ay1];

      let found = false;
      for (const uw of uniqueWalls) {
        if (Math.hypot(uw.p1[0] - sp1[0], uw.p1[1] - sp1[1]) < 0.15 &&
            Math.hypot(uw.p2[0] - sp2[0], uw.p2[1] - sp2[1]) < 0.15) {
          uw.isShared = true;
          uw.windows.push(...seg.windows);
          uw.doors.push(...seg.doors);
          found = true;
          break;
        }
      }
      if (!found) {
        uniqueWalls.push({ p1: sp1, p2: sp2, isShared: false, name: seg.roomName, windows: [...seg.windows], doors: [...seg.doors] });
      }
    }

    lines.push(`# Walls with Framed Opening Voids for ${sName}`);
    for (let wIdx = 0; wIdx < uniqueWalls.length; wIdx++) {
      const uw = uniqueWalls[wIdx];
      const wallLen = Math.hypot(uw.p2[0] - uw.p1[0], uw.p2[1] - uw.p1[1]);
      const thick = uw.isShared ? 0.15 : 0.25;
      const mat = uw.isShared ? "Interior Partition Drywall" : "Smooth Architectural Stucco";
      const rgb = uw.isShared ? "(0.90, 0.90, 0.88)" : "(0.95, 0.95, 0.92)";
      const wName = `${sName}_${uw.isShared ? 'Interior' : 'Perimeter'}_Wall_${wIdx + 1}`;

      const openings: { offset: number; width: number; height: number; sill_height: number }[] = [];
      const cleanWindows: any[] = [];
      for (const w of uw.windows) {
        const wW = Number(w.width || 1.4);
        const wH = Number(w.height || 1.5);
        const sH = Number(w.sill_height || 0.9);
        const off = Math.max(0.3, Math.min(Number(w.offset || 1.0), wallLen - wW - 0.3));
        const cleanOp = { offset: Number(off.toFixed(2)), width: wW, height: wH, sill_height: sH };
        openings.push(cleanOp);
        cleanWindows.push(cleanOp);
      }
      const cleanDoors: any[] = [];
      for (const d of uw.doors) {
        const dW = Number(d.width || 0.9);
        const dH = Number(d.height || 2.1);
        const off = Math.max(0.2, Math.min(Number(d.offset || 1.0), wallLen - dW - 0.2));
        const cleanOp = { offset: Number(off.toFixed(2)), width: dW, height: dH, sill_height: 0.0 };
        openings.push(cleanOp);
        cleanDoors.push(cleanOp);
      }

      const opJson = openings.length ? JSON.stringify(openings) : "None";
      lines.push(`_w_${sIdx}_${wIdx} = h_${sIdx}.create_wall([${uw.p1[0].toFixed(2)}, ${uw.p1[1].toFixed(2)}], [${uw.p2[0].toFixed(2)}, ${uw.p2[1].toFixed(2)}], height=${height.toFixed(2)}, thickness=${thick}, z_bottom=${elev.toFixed(2)}, openings=${opJson})`);
      lines.push(`h_${sIdx}.add_mesh_element(_w_${sIdx}_${wIdx}, "${wName}", ifc_class="IfcWall", mat_name="${mat}", rgb=${rgb})`);

      for (let winI = 0; winI < cleanWindows.length; winI++) {
        const w = cleanWindows[winI];
        lines.push(`h_${sIdx}.add_window([${uw.p1[0].toFixed(2)}, ${uw.p1[1].toFixed(2)}], [${uw.p2[0].toFixed(2)}, ${uw.p2[1].toFixed(2)}], offset=${w.offset}, width=${w.width}, height=${w.height}, sill_height=${w.sill_height}, z_bottom=${elev.toFixed(2)}, name="${wName}_Window_${winI + 1}")`);
      }

      for (let doorI = 0; doorI < cleanDoors.length; doorI++) {
        const d = cleanDoors[doorI];
        lines.push(`h_${sIdx}.add_door([${uw.p1[0].toFixed(2)}, ${uw.p1[1].toFixed(2)}], [${uw.p2[0].toFixed(2)}, ${uw.p2[1].toFixed(2)}], offset=${d.offset}, width=${d.width}, height=${d.height}, z_bottom=${elev.toFixed(2)}, name="${wName}_Door_${doorI + 1}")`);
      }
    }
    lines.push("");

    // 4. Inter-storey Stairs (if multi-storey or has_stairs)
    if ((plan.has_stairs || storeys.length > 1) && sIdx < storeys.length - 1) {
      const stairX = Number((rBounds[0].x + 0.8).toFixed(2));
      const stairY = Number((rBounds[0].y + 0.8).toFixed(2));
      lines.push(`# Monolithic Staircase connecting ${sName} to upper level`);
      lines.push(`_stairs_${sIdx} = h_${sIdx}.create_stairs(start_pt=[${stairX}, ${stairY}, ${elev.toFixed(2)}], length=3.6, width=1.2, height=${height.toFixed(2)}, num_steps=18)`);
      lines.push(`h_${sIdx}.add_mesh_element(_stairs_${sIdx}, "${sName}_Monolithic_Stairs", ifc_class="IfcStair", mat_name="Architectural Hardwood Tread", rgb=(0.65, 0.45, 0.25))`);
      lines.push(`h_${sIdx}.add_railing([${stairX}, ${stairY}], [${(stairX + 3.6).toFixed(2)}, ${stairY}], height=0.95, z_bottom=${elev.toFixed(2)}, name="${sName}_Stair_Handrail", rgb=(0.20, 0.20, 0.22))`);
      lines.push("");
    }

    // 5. Ceiling Slab
    const ceilFp = `[[${sMinX.toFixed(2)}, ${sMinY.toFixed(2)}], [${sMaxX.toFixed(2)}, ${sMinY.toFixed(2)}], [${sMaxX.toFixed(2)}, ${sMaxY.toFixed(2)}], [${sMinX.toFixed(2)}, ${sMaxY.toFixed(2)}]]`;
    lines.push(`_ceil_${sIdx} = h_${sIdx}.create_slab(${ceilFp}, thickness=0.20, z_elevation=${(elev + height).toFixed(2)})`);
    lines.push(`h_${sIdx}.add_mesh_element(_ceil_${sIdx}, "${sName}_Ceiling", ifc_class="IfcSlab", mat_name="White Gypsum Ceiling Plaster", rgb=(0.98, 0.98, 0.98))`);
    lines.push("");

    lines.push(`h_${sIdx}.commit()`);
    lines.push("");
  }

  // Roof on top storey
  if (roofType !== "none") {
    const minX = isFinite(totalMinX) ? totalMinX : 0;
    const minY = isFinite(totalMinY) ? totalMinY : 0;
    const maxX = isFinite(totalMaxX) ? totalMaxX : 10;
    const maxY = isFinite(totalMaxY) ? totalMaxY : 8;
    const rType = roofType.includes("flat") ? "flat" : roofType.includes("shed") ? "shed" : roofType.includes("hip") ? "hip" : "gable";
    const roofHeight = rType === "flat" ? 0.3 : 2.5;

    lines.push(`# ========================================================`);
    lines.push(`# ROOF STRUCTURE: ${rType.toUpperCase()}`);
    lines.push(`# ========================================================`);
    lines.push(`_top_st = _st_${storeys.length - 1}`);
    lines.push(`h_roof = InfraStudioHarness(ifc, _top_st)`);

    if (rType === "flat") {
      const roofFp = `[[${(minX - 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], [${(maxX + 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], [${(maxX + 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}], [${(minX - 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}]]`;
      lines.push(`_roof_slab = h_roof.create_slab(${roofFp}, thickness=0.25, z_elevation=${topZ.toFixed(2)})`);
      lines.push(`h_roof.add_mesh_element(_roof_slab, "Flat_Roof_Diaphragm", ifc_class="IfcSlab", mat_name="Insulated Membrane Roof Slab", rgb=(0.70, 0.70, 0.68))`);
      lines.push(`# Perimeter Parapet Wall with Coping`);
      lines.push(`_p1 = h_roof.create_wall([${(minX - 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], [${(maxX + 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], height=0.9, thickness=0.25, z_bottom=${topZ.toFixed(2)})`);
      lines.push(`_p2 = h_roof.create_wall([${(maxX + 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], [${(maxX + 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}], height=0.9, thickness=0.25, z_bottom=${topZ.toFixed(2)})`);
      lines.push(`_p3 = h_roof.create_wall([${(maxX + 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}], [${(minX - 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}], height=0.9, thickness=0.25, z_bottom=${topZ.toFixed(2)})`);
      lines.push(`_p4 = h_roof.create_wall([${(minX - 0.2).toFixed(2)}, ${(maxY + 0.2).toFixed(2)}], [${(minX - 0.2).toFixed(2)}, ${(minY - 0.2).toFixed(2)}], height=0.9, thickness=0.25, z_bottom=${topZ.toFixed(2)})`);
      lines.push(`h_roof.add_mesh_element(_p1, "Roof_Parapet_South", ifc_class="IfcWall", mat_name="Capped Architectural Parapet", rgb=(0.92, 0.92, 0.90))`);
      lines.push(`h_roof.add_mesh_element(_p2, "Roof_Parapet_East", ifc_class="IfcWall", mat_name="Capped Architectural Parapet", rgb=(0.92, 0.92, 0.90))`);
      lines.push(`h_roof.add_mesh_element(_p3, "Roof_Parapet_North", ifc_class="IfcWall", mat_name="Capped Architectural Parapet", rgb=(0.92, 0.92, 0.90))`);
      lines.push(`h_roof.add_mesh_element(_p4, "Roof_Parapet_West", ifc_class="IfcWall", mat_name="Capped Architectural Parapet", rgb=(0.92, 0.92, 0.90))`);
    } else {
      const roofFp = `[[${(minX - 0.5).toFixed(2)}, ${(minY - 0.5).toFixed(2)}], [${(maxX + 0.5).toFixed(2)}, ${(minY - 0.5).toFixed(2)}], [${(maxX + 0.5).toFixed(2)}, ${(maxY + 0.5).toFixed(2)}], [${(minX - 0.5).toFixed(2)}, ${(maxY + 0.5).toFixed(2)}]]`;
      lines.push(`_roof_mesh = h_roof.create_roof(${roofFp}, roof_type="${rType}", height=${roofHeight}, z_elevation=${(topZ + 0.15).toFixed(2)}, thickness=0.30)`);
      lines.push(`h_roof.add_mesh_element(_roof_mesh, "Architectural_${rType}_Roof", ifc_class="IfcRoof", mat_name="Standing Seam Architectural Zinc", rgb=(0.24, 0.26, 0.28))`);
    }
    lines.push(`h_roof.commit()`);
    lines.push("");
  }

  lines.push("save_and_load_ifc()");
  lines.push("print('InfraStudio Python harness generation complete and saved.')");

  return lines.join("\n");
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

  const text = requestedText(brief);
  const isMultiStorey = /2.?stor|two.?stor|second floor|upper floor|first floor|multi.?stor/i.test(text);

  // If user requested a multi-storey building but only 1 storey was returned:
  if (isMultiStorey && plan.storey_plans.length === 1) {
    const allRooms = plan.storey_plans[0].rooms || [];
    if (allRooms.length >= 2) {
      const groundRooms = allRooms.filter((r: any) => /living|kitchen|dining|entrance|entry|hall|lounge|family/i.test(String(r.name)));
      const upperRooms = allRooms.filter((r: any) => !groundRooms.includes(r));
      if (groundRooms.length === 0) {
        const mid = Math.ceil(allRooms.length / 2);
        groundRooms.push(...allRooms.slice(0, mid));
        upperRooms.push(...allRooms.slice(mid));
      } else if (upperRooms.length === 0) {
        upperRooms.push(groundRooms.pop()!);
      }
      upperRooms.forEach((r: any) => {
        if (Array.isArray(r.origin)) r.origin[2] = 3.2;
      });
      plan.storey_plans = [
        { name: "Ground Floor", elevation: 0, height: 3.2, rooms: groundRooms },
        { name: "First Floor", elevation: 3.2, height: 3.2, rooms: upperRooms }
      ];
    }
  }

  if (isMultiStorey || plan.storey_plans.length > 1) {
    plan.has_stairs = true;
  }

  if (/gable|pitch/i.test(text)) {
    plan.roof_type = "gable";
  } else if (/hip/i.test(text)) {
    plan.roof_type = "hip";
  } else if (/shed/i.test(text)) {
    plan.roof_type = "shed";
  } else if (/flat|parapet/i.test(text)) {
    plan.roof_type = "flat";
  } else if (!plan.roof_type) {
    plan.roof_type = "gable";
  }

  const expectedRooms = Array.isArray(brief?.room_requirements) ? brief.room_requirements.length : 0;
  const proposedRooms = plan.storey_plans.reduce((total: number, storey: any) => total + (Array.isArray(storey.rooms) ? storey.rooms.length : 0), 0);
  const isMultiUnit = /residential block|multi.?family|apartment block|flats?|multi.?storey/.test(text);
  const isApartmentUnit = /apartment/.test(text) && !isMultiUnit;
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
  if (!plan.python_code || typeof plan.python_code !== "string" || plan.python_code.trim().length < 50) {
    plan.python_code = synthesizeBuildingPythonCode(plan, brief);
  }

  return plan;
}

export async function handleArchitect(rawBrief: any): Promise<any> {
  const brief = (rawBrief && rawBrief.brief) ? { ...rawBrief.brief, client_requirements: rawBrief.client_requirements || rawBrief.brief?.client_requirements } : (rawBrief || {});
  const textCheck = requestedText(brief);
  const category = brief.structure_category || (/cofferdam|coffer|bridge|rail|road|pier|jetty|pier/i.test(textCheck) ? "infrastructure" : "building");
  const isBuilding = category === "building";
  const prompt = isBuilding ? systemPrompt : infrastructurePrompt;
  let promptStr = JSON.stringify(brief);
  if (brief.reviewHistory) {
    promptStr += `\n\nPREVIOUS REVIEW FAILED. Fix these issues: ${JSON.stringify(brief.reviewHistory)}`;
  }

  const selectedModel = brief.model || rawBrief?.model || "kimi-k3";
  try {
    let res = await callQwen(prompt, promptStr, true, selectedModel);
    if (!res || res.trim().length < 5) {
      throw new Error(`${selectedModel} returned an empty or invalid response.`);
    }

    // 1. Direct Autonomous Python Code Check:
    const directCode = extractPythonCode(res);
    if (directCode && directCode.length > 50) {
      let parsedName = brief.structure_name || brief.project_type || brief.client_requirements?.slice(0, 40) || "Autonomous Architectural Model";
      try {
        const parsedJson = cleanJsonResponse(res);
        if (parsedJson?.structure_name) parsedName = parsedJson.structure_name;
      } catch { /* ignore */ }

      console.log(`[handleArchitect] Autonomous ${selectedModel} code generated (${directCode.length} chars). No templates applied.`);
      return {
        structure_name: parsedName,
        structure_category: category,
        is_edit: false,
        python_code: directCode,
        layout_validation: { status: "PASS", repairs: [], constraint_audits: [] }
      };
    }

    // Attempt JSON parse — retry once with direct prompt if needed
    let parsed: any;
    try {
      parsed = cleanJsonResponse(res);
    } catch (firstErr) {
      console.warn("[handleArchitect] First parse failed, retrying with direct code prompt:", String(firstErr).slice(0, 120));
      const retryPrompt = `You are Antigravity BIM Architect. Write Python code using IfcOpenShell and Trimesh to create the requested structure: ${brief.client_requirements || brief.project_type}. Return JSON with { "structure_name": "...", "python_code": "..." }`;
      res = await callQwen(retryPrompt, JSON.stringify(brief), true, selectedModel);
      parsed = cleanJsonResponse(res);
    }

    if (parsed && typeof parsed.python_code === "string" && parsed.python_code.length > 50) {
      return {
        structure_name: parsed.structure_name || brief.project_type || "Autonomous Model",
        structure_category: category,
        is_edit: false,
        python_code: parsed.python_code,
        layout_validation: { status: "PASS", repairs: [], constraint_audits: [] }
      };
    }

    throw new Error("Model response did not contain executable Python code.");
  } catch (error) {
    console.warn(`[handleArchitect] ${selectedModel} failed (${error instanceof Error ? error.message : String(error)}). Attempting emergency Astra synthesis...`);
    try {
      const astraRes = await callAstra(prompt, promptStr, true, "gpt-6-astra");
      const astraCode = extractPythonCode(astraRes);
      if (astraCode && astraCode.length > 50) {
        let astraName = brief.structure_name || brief.project_type || "Astra Architectural Model";
        try {
          const parsedAstra = cleanJsonResponse(astraRes);
          if (parsedAstra?.structure_name) astraName = parsedAstra.structure_name;
        } catch { /* ignore */ }

        console.log(`[handleArchitect] Emergency Astra code generated (${astraCode.length} chars).`);
        return {
          structure_name: astraName,
          structure_category: category,
          is_edit: false,
          python_code: astraCode,
          layout_validation: { status: "PASS", repairs: [], constraint_audits: [] }
        };
      }
    } catch (aErr) {
      console.error("[handleArchitect] Emergency Astra synthesis also failed:", aErr);
    }

    throw new Error(`Architectural AI synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
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
