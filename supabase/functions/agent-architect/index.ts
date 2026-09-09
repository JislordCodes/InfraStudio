import { CORS, callQwen, callGemini, cleanJsonResponse } from "../_shared/shared.ts";

const systemPrompt = `You are the Lead Master Architect & Computational BIM Engineer for InfraStudio.
Your mission is to transform a design brief into a complete, visually striking, mathematically sound, and watertight architectural BIM model.

SINGLE-PASS PYTHON CODE EXECUTION (CRITICAL REQUIREMENT):
You do NOT use piecemeal single-room tools.
Instead, you write complete, high-performance, executable Python code in "python_code" that executes in a single pass via execute_ifc_code_tool using InfraStudioHarness and ifcopenshell.

EXECUTION ENVIRONMENT & INFRASTUDIO HARNESS:
The Python execution environment has ifcopenshell, trimesh, numpy, and math pre-imported.
It also provides InfraStudioHarness(ifc, storey).

Structure your "python_code" like this:
"""
import ifcopenshell
import ifcopenshell.api as api
import trimesh
import numpy as np
import math

ifc = get_ifc_file()
buildings = ifc.by_type("IfcBuilding")
building = buildings[0] if buildings else api.run("root.create_entity", ifc, ifc_class="IfcBuilding", name="Architectural Project")

# Storey setup:
storeys = ifc.by_type("IfcBuildingStorey")
storey = storeys[0] if storeys else api.run("root.create_entity", ifc, ifc_class="IfcBuildingStorey", name="Ground Floor")
api.run("aggregate.assign_object", ifc, relating_object=building, products=[storey])

h = InfraStudioHarness(ifc, storey)

# AVAILABLE HARNESS METHODS:
# 1. h.create_slab(polygon_2d, thickness=0.30, z_elevation=0.0) -> trimesh.Trimesh
# 2. h.create_wall(p1, p2, height=3.2, thickness=0.25, z_bottom=0.0) -> trimesh.Trimesh
# 3. h.create_stairs(start_pt=[x,y,z], length=3.5, width=1.2, height=3.2, num_steps=16) -> trimesh.Trimesh
# 4. h.create_roof(footprint_2d, roof_type="gable|flat|shed|hip", height=2.5, z_elevation=3.2, thickness=0.3) -> trimesh.Trimesh
# 5. h.create_cylinder(radius=0.25, height=3.5, pos=[x,y,z], axis=[0,0,1]) -> trimesh.Trimesh (columns)
# 6. h.create_i_beam(depth=0.5, flange_w=0.25, web_t=0.02, flange_t=0.03, length=8.0, pos=[x,y,z], rot_z_deg=0.0) -> trimesh.Trimesh (beams)
# 7. h.create_box(extents=[l,w,h], pos=[x,y,z], rot_z_deg=0.0) -> trimesh.Trimesh (curtain walls, glass panels, parapets)
# 8. h.add_mesh_element(mesh, name, ifc_class="IfcWall|IfcSlab|IfcRoof|IfcColumn|IfcBeam|IfcStair|IfcDoor|IfcWindow|IfcFooting", mat_name="...", rgb=(r,g,b), transparency=0.0)

# Build:
# 1. Ground floor slab & upper slabs
# 2. Exterior facade walls & interior partitions (avoid duplicate overlapping walls)
# 3. Floor-to-ceiling glass curtain walls or picture windows (use ifc_class="IfcWindow", mat_name="Low-E Glass", rgb=(0.85, 0.92, 0.98), transparency=0.7)
# 4. Monolithic staircases for multi-storey buildings (ifc_class="IfcStair", mat_name="Timber Tread", rgb=(0.76, 0.58, 0.38))
# 5. Structural columns/beams for large open spans
# 6. Ceiling slabs & Roof structure (pitched gable, hip, shed, or flat parapet)

count = h.commit()
save_and_load_ifc()
print(f"Committed {count} elements.")
"""

ARCHITECTURAL DIVERSITY & FOOTPRINTS:
Dynamically choose expressive modern footprints (L-Shape, U-Shape with courtyard, Cantilevered dual-volume, Modern glass pavilion).
Do NOT produce a boring 1-room box!

Strict Restrictions:
* Return ONLY raw JSON matching the schema below. Start your output immediately with '{'.

Expected JSON Schema:
{
  "structure_name": "string",
  "structure_category": "building",
  "is_edit": boolean,
  "roof_type": "flat|gable|hip|shed|butterfly|none",
  "has_stairs": boolean,
  "material_palette": {
    "wall": "string",
    "floor": "string",
    "door": "string",
    "window_glass": "string",
    "roof_or_ceiling": "string"
  },
  "python_code": "complete runnable python script using InfraStudioHarness(ifc, storey)",
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
          "doors": [],
          "windows": []
        }
      ]
    }
  ],
  "structural_notes": ["string"]
}`;

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

  // 1. If Astra generated custom python_code, preserve Astra's code
  if (typeof plan?.python_code === "string" && plan.python_code.trim().length > 20) {
    return {
      ...plan,
      structure_category: "infrastructure",
      is_edit: false,
      structure_name: plan.structure_name || brief?.project_type || "Infrastructure Structure",
      python_code: plan.python_code,
      components: Array.isArray(plan?.components) ? plan.components : [],
      quality_requirements: { minimum_components: minimum }
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
      quality_requirements: { minimum_components: minimum }
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
      quality_requirements: { minimum_components: 20, required_element_types: ["IfcWall", "IfcBeam", "IfcMember", "IfcColumn", "IfcFooting", "IfcSlab"] }
    };
  }
  if (isBridge) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Bridge", components: bridgeProgram(brief?.project_type || "Bridge"), quality_requirements: { minimum_components: 8, required_element_types: ["IfcSlab", "IfcColumn", "IfcBeam", "IfcFooting"] } };
  }
  if (isRail) {
    return { ...plan, structure_category: "infrastructure", is_edit: false, structure_name: brief?.project_type || "Railway", components: railwayProgram(), quality_requirements: { minimum_components: 30, required_element_types: ["IfcSlab", "IfcMember"] } };
  }

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

    // 1. Floor Slabs
    for (let rIdx = 0; rIdx < rBounds.length; rIdx++) {
      const rb = rBounds[rIdx];
      totalMinX = Math.min(totalMinX, rb.x);
      totalMinY = Math.min(totalMinY, rb.y);
      totalMaxX = Math.max(totalMaxX, rb.x + rb.w);
      totalMaxY = Math.max(totalMaxY, rb.y + rb.l);

      const fp = `[[${rb.x}, ${rb.y}], [${rb.x + rb.w}, ${rb.y}], [${rb.x + rb.w}, ${rb.y + rb.l}], [${rb.x}, ${rb.y + rb.l}]]`;
      const cleanName = rb.name.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`_slab_${sIdx}_${rIdx} = h_${sIdx}.create_slab(${fp}, thickness=0.25, z_elevation=${elev - 0.25})`);
      lines.push(`h_${sIdx}.add_mesh_element(_slab_${sIdx}_${rIdx}, "${sName}_${cleanName}_Floor_Slab", ifc_class="IfcSlab", mat_name="Polished Architectural Concrete", rgb=(0.78, 0.78, 0.76))`);
    }
    lines.push("");

    // 2. Walls with deduplication at shared boundaries
    const rawSegments: { p1: [number, number]; p2: [number, number]; roomName: string }[] = [];
    for (const rb of rBounds) {
      rawSegments.push({ p1: [rb.x, rb.y], p2: [rb.x + rb.w, rb.y], roomName: rb.name });
      rawSegments.push({ p1: [rb.x + rb.w, rb.y], p2: [rb.x + rb.w, rb.y + rb.l], roomName: rb.name });
      rawSegments.push({ p1: [rb.x + rb.w, rb.y + rb.l], p2: [rb.x, rb.y + rb.l], roomName: rb.name });
      rawSegments.push({ p1: [rb.x, rb.y + rb.l], p2: [rb.x, rb.y], roomName: rb.name });
    }

    const uniqueWalls: { p1: [number, number]; p2: [number, number]; isShared: boolean; name: string }[] = [];
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
          found = true;
          break;
        }
      }
      if (!found) {
        uniqueWalls.push({ p1: sp1, p2: sp2, isShared: false, name: seg.roomName });
      }
    }

    lines.push(`# Walls for ${sName}`);
    for (let wIdx = 0; wIdx < uniqueWalls.length; wIdx++) {
      const uw = uniqueWalls[wIdx];
      const thick = uw.isShared ? 0.15 : 0.25;
      const mat = uw.isShared ? "Interior Partition Drywall" : "Smooth Architectural Stucco";
      const rgb = uw.isShared ? "(0.90, 0.90, 0.88)" : "(0.95, 0.95, 0.92)";
      const wName = `${sName}_${uw.isShared ? 'Interior' : 'Perimeter'}_Wall_${wIdx + 1}`;
      lines.push(`_w_${sIdx}_${wIdx} = h_${sIdx}.create_wall([${uw.p1[0]}, ${uw.p1[1]}], [${uw.p2[0]}, ${uw.p2[1]}], height=${height}, thickness=${thick}, z_bottom=${elev})`);
      lines.push(`h_${sIdx}.add_mesh_element(_w_${sIdx}_${wIdx}, "${wName}", ifc_class="IfcWall", mat_name="${mat}", rgb=${rgb})`);
    }
    lines.push("");

    // 3. Glazed Panels / Windows
    for (let rIdx = 0; rIdx < rBounds.length; rIdx++) {
      const rb = rBounds[rIdx];
      for (let winIdx = 0; winIdx < rb.windows.length; winIdx++) {
        const win = rb.windows[winIdx];
        const winW = Number(win.width || 1.4);
        const winH = Number(win.height || 1.5);
        const sillH = Number(win.sill_height || 0.9);
        const offset = Number(win.offset || 1.0);
        const wall = String(win.wall || "south").toLowerCase();

        let cx = rb.x + offset + winW / 2;
        let cy = rb.y;
        let rotZ = 0;
        if (wall === "north") {
          cy = rb.y + rb.l;
          rotZ = 0;
        } else if (wall === "east") {
          cx = rb.x + rb.w;
          cy = rb.y + offset + winW / 2;
          rotZ = 90;
        } else if (wall === "west") {
          cx = rb.x;
          cy = rb.y + offset + winW / 2;
          rotZ = 90;
        }
        const cz = elev + sillH + winH / 2;
        const cleanName = rb.name.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`_win_${sIdx}_${rIdx}_${winIdx} = h_${sIdx}.create_box(extents=[${winW}, 0.08, ${winH}], pos=[${cx}, ${cy}, ${cz}], rot_z_deg=${rotZ})`);
        lines.push(`h_${sIdx}.add_mesh_element(_win_${sIdx}_${rIdx}_${winIdx}, "${sName}_${cleanName}_Window_${winIdx + 1}", ifc_class="IfcWindow", mat_name="Low-E Insulated Architectural Glass", rgb=(0.85, 0.92, 0.98), transparency=0.7)`);
      }
    }
    lines.push("");

    // 4. Doors
    for (let rIdx = 0; rIdx < rBounds.length; rIdx++) {
      const rb = rBounds[rIdx];
      const doorList = rb.doors.length > 0 ? rb.doors : [{ wall: "south", offset: 1.0, width: 0.9, height: 2.1 }];
      for (let doorIdx = 0; doorIdx < doorList.length; doorIdx++) {
        const door = doorList[doorIdx];
        const doorW = Number(door.width || 0.9);
        const doorH = Number(door.height || 2.1);
        const offset = Number(door.offset || 1.0);
        const wall = String(door.wall || "south").toLowerCase();

        let cx = rb.x + offset + doorW / 2;
        let cy = rb.y;
        let rotZ = 0;
        if (wall === "north") {
          cy = rb.y + rb.l;
          rotZ = 0;
        } else if (wall === "east") {
          cx = rb.x + rb.w;
          cy = rb.y + offset + doorW / 2;
          rotZ = 90;
        } else if (wall === "west") {
          cx = rb.x;
          cy = rb.y + offset + doorW / 2;
          rotZ = 90;
        }
        const cz = elev + doorH / 2;
        const cleanName = rb.name.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`_door_${sIdx}_${rIdx}_${doorIdx} = h_${sIdx}.create_box(extents=[${doorW}, 0.08, ${doorH}], pos=[${cx}, ${cy}, ${cz}], rot_z_deg=${rotZ})`);
        lines.push(`h_${sIdx}.add_mesh_element(_door_${sIdx}_${rIdx}_${doorIdx}, "${sName}_${cleanName}_Door_${doorIdx + 1}", ifc_class="IfcDoor", mat_name="Solid Architectural Wood Door", rgb=(0.58, 0.38, 0.22))`);
      }
    }
    lines.push("");

    // 4. Stairs (if multi-storey or has_stairs)
    if ((plan.has_stairs || storeys.length > 1) && sIdx < storeys.length - 1) {
      const stairX = rBounds[0].x + 1.0;
      const stairY = rBounds[0].y + 1.0;
      lines.push(`# Monolithic Staircase connecting ${sName} to upper level`);
      lines.push(`_stairs_${sIdx} = h_${sIdx}.create_stairs(start_pt=[${stairX}, ${stairY}, ${elev}], length=3.5, width=1.2, height=${height}, num_steps=16)`);
      lines.push(`h_${sIdx}.add_mesh_element(_stairs_${sIdx}, "${sName}_Monolithic_Stairs", ifc_class="IfcStair", mat_name="Architectural Hardwood Tread", rgb=(0.76, 0.58, 0.38))`);
      lines.push("");
    }

    // 5. Ceiling Slab
    for (let rIdx = 0; rIdx < rBounds.length; rIdx++) {
      const rb = rBounds[rIdx];
      const fp = `[[${rb.x}, ${rb.y}], [${rb.x + rb.w}, ${rb.y}], [${rb.x + rb.w}, ${rb.y + rb.l}], [${rb.x}, ${rb.y + rb.l}]]`;
      const cleanName = rb.name.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`_ceil_${sIdx}_${rIdx} = h_${sIdx}.create_slab(${fp}, thickness=0.20, z_elevation=${elev + height})`);
      lines.push(`h_${sIdx}.add_mesh_element(_ceil_${sIdx}_${rIdx}, "${sName}_${cleanName}_Ceiling", ifc_class="IfcSlab", mat_name="White Gypsum Ceiling Plaster", rgb=(0.98, 0.98, 0.98))`);
    }
    lines.push("");

    lines.push(`h_${sIdx}.commit()`);
    lines.push("");
  }

  // Roof on top storey
  if (roofType !== "none") {
    const minX = isFinite(totalMinX) ? totalMinX - 0.4 : -0.4;
    const minY = isFinite(totalMinY) ? totalMinY - 0.4 : -0.4;
    const maxX = isFinite(totalMaxX) ? totalMaxX + 0.4 : 10.4;
    const maxY = isFinite(totalMaxY) ? totalMaxY + 0.4 : 8.4;
    const roofFp = `[[${minX}, ${minY}], [${maxX}, ${minY}], [${maxX}, ${maxY}], [${minX}, ${maxY}]]`;
    const rType = roofType.includes("flat") ? "flat" : roofType.includes("shed") ? "shed" : roofType.includes("hip") ? "hip" : "gable";
    const roofHeight = rType === "flat" ? 0.3 : 2.4;

    lines.push(`# ========================================================`);
    lines.push(`# ROOF STRUCTURE: ${rType.toUpperCase()}`);
    lines.push(`# ========================================================`);
    lines.push(`_top_st = _st_${storeys.length - 1}`);
    lines.push(`h_roof = InfraStudioHarness(ifc, _top_st)`);
    lines.push(`_roof_mesh = h_roof.create_roof(${roofFp}, roof_type="${rType}", height=${roofHeight}, z_elevation=${topZ + 0.2}, thickness=0.30)`);
    lines.push(`h_roof.add_mesh_element(_roof_mesh, "Architectural_${rType}_Roof", ifc_class="IfcRoof", mat_name="Dark Anthracite Standing Seam Roof", rgb=(0.25, 0.26, 0.28))`);
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
  const fallbackPlan = (reason: unknown) => {
    const modelFailure = String(reason instanceof Error ? reason.message : reason).slice(0, 280);
    if (isBuilding) {
      return repairPlan({
        is_edit: false,
        generation_source: "constraint_program_fallback",
        model_status: "qwen_unavailable",
        model_failure: modelFailure,
        roof_type: "flat",
        has_stairs: false,
        structural_notes: ["Generated from the validated spatial programme after the AI planner was unavailable."],
        storey_plans: minimumBuildingPlan(brief),
      }, brief);
    }
    return ensureInfrastructurePlan({
      structure_category: category,
      is_edit: false,
      generation_source: "constraint_program_fallback",
      model_status: "qwen_unavailable",
      model_failure: modelFailure,
    }, brief);
  };
  
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

  // Attempt JSON parse — retry once if it fails
  let parsed: any;
  try {
    parsed = cleanJsonResponse(res);
  } catch (firstErr) {
    console.warn("[handleArchitect] First parse failed, retrying with clean prompt:", String(firstErr).slice(0, 120));
    const retryPrompt = `You are an architect AI. Return ONLY valid JSON — no markdown, no text, no thinking.
The user wants: ${brief.project_type || "a building"} with these rooms: ${(brief.room_requirements || []).map((r: any) => r.name).join(", ")}.
Output a JSON object with keys: is_edit(false), roof_type, has_stairs, material_palette, storey_plans(array of floors with rooms having name/width/length/origin[x,y,z]/doors[]/windows[]), special_elements, structural_notes.`;
    res = await callQwen(retryPrompt, JSON.stringify(brief.room_requirements || brief), true, selectedModel);
    parsed = cleanJsonResponse(res);
  }

  if (isBuilding) {
    return repairPlan(parsed, brief);
  } else {
    return ensureInfrastructurePlan({ ...parsed, structure_category: category, is_edit: false }, brief);
  }
  } catch (error) {
    console.warn("[handleArchitect] Qwen planning failed; using constrained fallback:", String(error));
    return fallbackPlan(error);
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
