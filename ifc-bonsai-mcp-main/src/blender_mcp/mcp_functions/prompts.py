'''
Prompts — System guidance for the LLM agent interacting with IFC Bonsai MCP.

These prompts steer the LLM toward using high-level orchestration tools
instead of manually sequencing low-level IFC commands.
'''

from ..mcp_instance import mcp


@mcp.prompt()
def ifc_building_element_creation_strategy() -> str:
    """Defines the preferred strategy for creating IFC building elements"""
    return """
    When creating IFC building elements in Bonsai (formerly BlenderBIM), follow these guidelines:
    
    1. IFC Structure and Hierarchy:
       - Respect the IFC hierarchy: Project → Site → Building → Building Story → Building Elements
       - Every element must belong to a proper container (typically a Building Story)
       - Use proper IFC entity types (IfcWall, IfcSlab, IfcDoor, etc.)
    
    2. ALWAYS use high-level orchestration tools — pick the RIGHT level:
    
       ┌─────────────────────┬──────────────────────────────────────────────┐
       │ User wants...       │ Use this tool                               │
       ├─────────────────────┼──────────────────────────────────────────────┤
       │ Full building       │ build_building (storeys + rooms + roof)     │
       │ Multiple rooms      │ build_floor_plan (rooms array)              │
       │ One room            │ build_room (walls + slab + openings)        │
       │ Wall + openings     │ build_wall_assembly (wall + doors/windows)  │
       │ Just a wall         │ create_wall / create_two_point_wall         │
       │ Just a slab         │ create_slab                                 │
       │ Just a roof         │ create_roof                                 │
       │ Just stairs         │ create_stairs                               │
       └─────────────────────┴──────────────────────────────────────────────┘
    
    3. NEVER manually orchestrate room/building creation:
       - NEVER calculate wall coordinates yourself
       - NEVER compute rotations in radians
       - NEVER track GUIDs between tool calls for room/building creation
       - The orchestration tools handle ALL geometry deterministically
    
    4. Coordinate System:
       - Origin = south-west corner of rooms
       - Width = X-axis (west → east)
       - Length = Y-axis (south → north)
       - Height = Z-axis (floor → ceiling)
       - Wall names: "south", "east", "north", "west"
       - Door/window "offset" = distance from the START of the named wall
    
    5. Multi-Room Layouts:
       - Place adjacent rooms by offsetting their origin
       - Room A at [0,0,0] and Room B at [4,0,0] share the east/west wall line
       - Use build_floor_plan for multiple rooms at once
    
    6. Multi-Storey Buildings:
       - Use build_building with storeys array
       - Elevations are auto-computed from storey heights
       - Roof is auto-generated from top storey footprint
    
    Following these guidelines will ensure a well-structured, standards-compliant IFC model.
    """


@mcp.prompt()
def tool_selection_guide() -> str:
    """Guide for selecting the right orchestration tool based on user request"""
    return """
    TOOL SELECTION GUIDE
    
    Listen to the user's request and choose the HIGHEST-LEVEL tool that fits:
    
    ── "Create a house / building / school / office block" ──
    → Use `build_building` with storeys and rooms
    
    ── "Create an apartment / floor layout / multiple rooms" ──
    → Use `build_floor_plan` with rooms array
    
    ── "Create a room / bedroom / office / bathroom" ──
    → Use `build_room` with dimensions, doors, windows
    
    ── "Create a wall with a door" / "Add a partition wall with windows" ──
    → Use `build_wall_assembly` with start/end points, doors, windows
    
    ── "Create a plain wall / slab / roof / stairs" ──
    → Use the individual element tools (create_wall, create_slab, etc.)
    
    EXAMPLES:
    
    "Build a 2-bedroom house with a kitchen and bathroom"
    → build_building with 1 storey, 4 rooms
    
    "Create a 4x5m office with a glass door on the south wall"
    → build_room(width=4, length=5, doors=[{"wall":"south", ...}])
    
    "Add a partition wall with a door in the middle"
    → build_wall_assembly(start_point=[...], end_point=[...], doors=[{"offset": ...}])
    
    "Put a gable roof on the building"
    → create_roof(polyline=[...], roof_type="GABLE_ROOF", angle=30)
    
    CRITICAL RULES:
    - NEVER calculate wall coordinates yourself
    - NEVER compute rotations or track GUIDs manually
    - NEVER call create_wall + create_door + create_opening individually to build a room
    - The orchestration tools handle ALL geometry deterministically
    - "offset" = distance from the wall's start point along its axis
    """
