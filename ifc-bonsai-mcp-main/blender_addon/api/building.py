"""Building Orchestration Layer for IFC Bonsai MCP

This module provides high-level building composition tools that the LLM can call
with structured JSON specifications. The backend deterministically handles all
geometry computation, GUID management, rotation math, and BIM topology.

Hierarchy of orchestration tools (from smallest to largest):

  1. create_wall_assembly  — Single wall with doors + windows embedded
  2. create_room           — Rectangular room (4 walls + slabs + openings)  [in room.py]
  3. create_floor_plan     — Multiple rooms arranged on a single level
  4. create_building       — Multi-storey building with roof

Each tool eliminates the LLM's need to:
  - Calculate coordinates or rotations
  - Track GUIDs across tool calls
  - Manage BIM topology (opening→wall, filling→opening)
  - Sequence individual element creation calls
"""

import math
import logging
from typing import Any, Dict, List, Optional, Tuple

from . import register_command

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# 1. WALL ASSEMBLY — Single wall with embedded doors/windows
# ──────────────────────────────────────────────────────────────────────────────

@register_command('create_wall_assembly', description="Create a wall with embedded doors and windows in a single call")
def create_wall_assembly(
    name: str = "Wall Assembly",
    start_point: Optional[List[float]] = None,
    end_point: Optional[List[float]] = None,
    height: float = 3.0,
    thickness: float = 0.2,
    doors: Optional[List[Dict[str, Any]]] = None,
    windows: Optional[List[Dict[str, Any]]] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create a single wall with properly embedded doors and windows.
    
    Use this when you need a wall with openings but NOT a full room.
    Examples: partition walls, facade sections, feature walls.
    
    The backend computes all opening positions, creates the wall,
    creates openings in the wall, and fills them with doors/windows.
    
    Args:
        name: Name for the wall
        start_point: [x, y, z] start of wall (default: [0, 0, 0])
        end_point: [x, y, z] end of wall (required for direction/length)
        height: Wall height in meters
        thickness: Wall thickness in meters
        doors: List of door specs:
            - offset (float): Distance from wall start in meters (REQUIRED)
            - width (float): Door width in meters (default: 0.9)
            - height (float): Door height in meters (default: 2.1)
            - operation_type (str): Swing type (default: "SINGLE_SWING_LEFT")
        windows: List of window specs:
            - offset (float): Distance from wall start in meters (REQUIRED)
            - width (float): Window width in meters (default: 1.2)
            - height (float): Window height in meters (default: 1.5)
            - sill_height (float): Height from floor (default: 0.9)
            
    Returns:
        Dict with wall GUID, door/window GUIDs, and positions.
    """
    if start_point is None:
        start_point = [0.0, 0.0, 0.0]
    if end_point is None:
        end_point = [5.0, 0.0, 0.0]
    if doors is None:
        doors = []
    if windows is None:
        windows = []
    
    # Compute wall length and direction
    dx = end_point[0] - start_point[0]
    dy = end_point[1] - start_point[1]
    wall_length = math.sqrt(dx * dx + dy * dy)
    
    if wall_length < 0.01:
        raise ValueError("Wall start and end points are too close together")
    
    # Unit direction vector
    dir_x = dx / wall_length
    dir_y = dy / wall_length
    
    # Wall rotation in degrees (angle from +X axis)
    rotation_deg = math.degrees(math.atan2(dy, dx))
    
    # Validate all openings before creating anything
    all_openings = []
    for i, door_spec in enumerate(doors):
        d_offset = door_spec.get("offset", 0.0)
        d_width = door_spec.get("width", 0.9)
        if d_offset < 0 or d_offset + d_width > wall_length:
            raise ValueError(
                f"Door #{i}: offset ({d_offset}m) + width ({d_width}m) = "
                f"{d_offset + d_width}m exceeds wall length ({wall_length:.2f}m)"
            )
        all_openings.append(("door", i, d_offset, d_width))
    
    for i, win_spec in enumerate(windows):
        w_offset = win_spec.get("offset", 0.0)
        w_width = win_spec.get("width", 1.2)
        if w_offset < 0 or w_offset + w_width > wall_length:
            raise ValueError(
                f"Window #{i}: offset ({w_offset}m) + width ({w_width}m) = "
                f"{w_offset + w_width}m exceeds wall length ({wall_length:.2f}m)"
            )
        all_openings.append(("window", i, w_offset, w_width))
    
    # Check for overlapping openings
    all_openings.sort(key=lambda x: x[2])
    for j in range(len(all_openings) - 1):
        t1, i1, o1, w1 = all_openings[j]
        t2, i2, o2, w2 = all_openings[j + 1]
        if o1 + w1 > o2:
            raise ValueError(
                f"{t1.capitalize()} #{i1} and {t2} #{i2} overlap: "
                f"{t1} ends at {o1 + w1}m but {t2} starts at {o2}m"
            )
    
    result = {
        "success": True,
        "name": name,
        "wall": None,
        "doors": [],
        "windows": [],
        "errors": [],
    }
    
    # PHASE 1: Create the wall
    try:
        from .wall import create_two_point_wall
        
        wall_result = create_two_point_wall(
            start_point=tuple(start_point),
            end_point=tuple(end_point),
            name=name,
            thickness=thickness,
            height=height,
        )
        
        if wall_result.get("success"):
            wall_guid = wall_result.get("wall_guid")
            result["wall"] = {
                "guid": wall_guid,
                "name": name,
                "length": wall_length,
                "start": start_point,
                "end": end_point,
                "rotation_deg": rotation_deg,
            }
        else:
            result["errors"].append(f"Wall creation failed: {wall_result}")
            result["success"] = False
            return result
    except Exception as e:
        result["errors"].append(f"Wall creation error: {str(e)}")
        result["success"] = False
        return result
    
    # PHASE 2: Create doors with openings
    for i, door_spec in enumerate(doors):
        try:
            d_offset = door_spec.get("offset", 0.0)
            d_width = door_spec.get("width", 0.9)
            d_height = door_spec.get("height", 2.1)
            d_operation = door_spec.get("operation_type", "SINGLE_SWING_LEFT")
            d_name = door_spec.get("name", f"{name}_Door_{i+1}")
            
            # Compute position along wall axis
            center = d_offset + d_width / 2.0
            pos_x = start_point[0] + center * dir_x
            pos_y = start_point[1] + center * dir_y
            pos_z = start_point[2]  # doors at floor level
            
            from .door import create_door
            
            door_result = create_door(
                name=d_name,
                dimensions={"width": d_width, "height": d_height},
                operation_type=d_operation,
                location=[pos_x, pos_y, pos_z],
                rotation=[0.0, 0.0, rotation_deg],
                wall_guid=wall_guid,
                create_opening=True,
                verbose=verbose,
            )
            
            if door_result.get("success"):
                result["doors"].append({
                    "guid": door_result.get("door_guid"),
                    "name": d_name,
                    "offset": d_offset,
                    "width": d_width,
                    "height": d_height,
                })
            else:
                result["errors"].append(f"Door #{i}: {door_result.get('error', 'unknown')}")
        except Exception as e:
            result["errors"].append(f"Door #{i} error: {str(e)}")
    
    # PHASE 3: Create windows with openings
    for i, win_spec in enumerate(windows):
        try:
            w_offset = win_spec.get("offset", 0.0)
            w_width = win_spec.get("width", 1.2)
            w_height = win_spec.get("height", 1.5)
            w_sill = win_spec.get("sill_height", 0.9)
            w_partition = win_spec.get("partition_type", "SINGLE_PANEL")
            w_name = win_spec.get("name", f"{name}_Window_{i+1}")
            
            center = w_offset + w_width / 2.0
            pos_x = start_point[0] + center * dir_x
            pos_y = start_point[1] + center * dir_y
            pos_z = start_point[2] + w_sill
            
            from .window import create_window
            
            window_result = create_window(
                name=w_name,
                dimensions={"width": w_width, "height": w_height},
                partition_type=w_partition,
                location=[pos_x, pos_y, pos_z],
                rotation=[0.0, 0.0, rotation_deg],
                wall_guid=wall_guid,
                create_opening=True,
                verbose=verbose,
            )
            
            if window_result.get("success"):
                result["windows"].append({
                    "guid": window_result.get("window_guid"),
                    "name": w_name,
                    "offset": w_offset,
                    "width": w_width,
                    "height": w_height,
                    "sill_height": w_sill,
                })
            else:
                result["errors"].append(f"Window #{i}: {window_result.get('error', 'unknown')}")
        except Exception as e:
            result["errors"].append(f"Window #{i} error: {str(e)}")
    
    result["message"] = (
        f"Wall assembly '{name}': 1 wall ({wall_length:.1f}m), "
        f"{len(result['doors'])} doors, {len(result['windows'])} windows"
    )
    
    return result


# ──────────────────────────────────────────────────────────────────────────────
# 2. FLOOR PLAN — Multiple rooms arranged on a single level
# ──────────────────────────────────────────────────────────────────────────────

@register_command('create_floor_plan', description="Create a multi-room floor plan from a list of room specifications")
def create_floor_plan(
    plan_name: str = "Floor Plan",
    rooms: Optional[List[Dict[str, Any]]] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create a complete floor plan with multiple rooms.
    
    Each room is placed at its specified origin. The backend handles all
    wall creation, slab generation, and door/window placement for every room.
    
    Use this when the user describes a layout like "apartment with kitchen,
    bedroom, bathroom" or "office with 3 rooms and a corridor".
    
    Args:
        plan_name: Name for the floor plan
        rooms: List of room specifications, each with:
            - name (str): Room name (e.g., "Kitchen")
            - width (float): Room width in meters (X-axis)
            - length (float): Room length in meters (Y-axis)
            - height (float): Wall height (default: 3.0)
            - wall_thickness (float): Wall thickness (default: 0.2)
            - origin (list): [x, y, z] position of SW corner (REQUIRED for layout)
            - floor_slab (bool): Create floor slab (default: True)
            - ceiling_slab (bool): Create ceiling slab (default: False)
            - doors (list): Door specs (same as build_room)
            - windows (list): Window specs (same as build_room)
    
    Returns:
        Dict with all room results, GUIDs, and layout summary.
        
    Example:
        create_floor_plan(
            plan_name="2BR Apartment",
            rooms=[
                {
                    "name": "Living Room",
                    "width": 6, "length": 5, "height": 3,
                    "origin": [0, 0, 0],
                    "doors": [{"wall": "east", "offset": 1.5, "width": 0.9}],
                    "windows": [{"wall": "south", "offset": 2.0, "width": 1.8}]
                },
                {
                    "name": "Bedroom",
                    "width": 4, "length": 4, "height": 3,
                    "origin": [6, 0, 0],
                    "doors": [{"wall": "west", "offset": 1.5, "width": 0.9}],
                    "windows": [{"wall": "east", "offset": 1.5, "width": 1.2}]
                },
                {
                    "name": "Bathroom",
                    "width": 3, "length": 3, "height": 3,
                    "origin": [6, 4, 0],
                    "doors": [{"wall": "west", "offset": 1.0, "width": 0.8}]
                }
            ]
        )
    """
    if rooms is None or len(rooms) == 0:
        raise ValueError("Floor plan requires at least one room specification")
    
    from .room import create_room
    
    result = {
        "success": True,
        "plan_name": plan_name,
        "rooms": [],
        "errors": [],
        "total_area": 0.0,
    }
    
    for i, room_spec in enumerate(rooms):
        room_name = room_spec.get("name", f"{plan_name}_Room_{i+1}")
        
        try:
            room_result = create_room(
                room_name=room_name,
                width=room_spec.get("width", 4.0),
                length=room_spec.get("length", 4.0),
                height=room_spec.get("height", 3.0),
                wall_thickness=room_spec.get("wall_thickness", 0.2),
                origin=room_spec.get("origin", [0.0, 0.0, 0.0]),
                floor_slab=room_spec.get("floor_slab", True),
                floor_thickness=room_spec.get("floor_thickness", 0.2),
                ceiling_slab=room_spec.get("ceiling_slab", False),
                ceiling_thickness=room_spec.get("ceiling_thickness", 0.15),
                doors=room_spec.get("doors", []),
                windows=room_spec.get("windows", []),
                verbose=verbose,
            )
            
            if room_result.get("success"):
                room_width = room_spec.get("width", 4.0)
                room_length = room_spec.get("length", 4.0)
                result["rooms"].append({
                    "name": room_name,
                    "origin": room_spec.get("origin", [0, 0, 0]),
                    "area": room_width * room_length,
                    "result": room_result,
                })
                result["total_area"] += room_width * room_length
            else:
                result["errors"].append(f"Room '{room_name}': {room_result.get('errors', [])}")
                
        except Exception as e:
            result["errors"].append(f"Room '{room_name}' error: {str(e)}")
    
    result["summary"] = {
        "rooms_created": len(result["rooms"]),
        "rooms_failed": len(rooms) - len(result["rooms"]),
        "total_area_sqm": round(result["total_area"], 2),
        "errors": len(result["errors"]),
    }
    
    result["message"] = (
        f"Floor plan '{plan_name}': {len(result['rooms'])}/{len(rooms)} rooms created, "
        f"{result['total_area']:.1f}m² total area"
    )
    
    if result["errors"]:
        result["message"] += f" ({len(result['errors'])} errors)"
    
    return result


# ──────────────────────────────────────────────────────────────────────────────
# 3. BUILDING — Multi-storey structure with roof
# ──────────────────────────────────────────────────────────────────────────────

@register_command('create_building', description="Create a complete multi-storey building from a structured specification")
def create_building(
    building_name: str = "Building",
    storeys: Optional[List[Dict[str, Any]]] = None,
    roof: Optional[Dict[str, Any]] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create a complete multi-storey building with optional roof.
    
    Each storey contains a floor plan (list of rooms). The backend automatically
    stacks storeys at the correct elevation and handles all geometry.
    
    Args:
        building_name: Name for the building
        storeys: List of storey specifications, each with:
            - name (str): Storey name (e.g., "Ground Floor")
            - elevation (float): Floor elevation in meters (auto-computed if omitted)
            - height (float): Floor-to-floor height (default: 3.0)
            - rooms (list): Room specs (same format as create_floor_plan)
        roof: Optional roof specification:
            - type (str): Roof type (FLAT, GABLE_ROOF, HIP_ROOF, etc.)
            - angle (float): Slope angle in degrees (default: 30)
            - thickness (float): Roof thickness in meters (default: 0.3)
            - overhang (float): Roof overhang in meters (default: 0.5)
            
    Returns:
        Dict with all storey/room results and building summary.
        
    Example:
        create_building(
            building_name="Two-Storey House",
            storeys=[
                {
                    "name": "Ground Floor",
                    "height": 3.0,
                    "rooms": [
                        {"name": "Living", "width": 6, "length": 5, "origin": [0,0,0],
                         "doors": [{"wall": "south", "offset": 2, "width": 1.2}],
                         "windows": [{"wall": "east", "offset": 1.5, "width": 1.8}]},
                        {"name": "Kitchen", "width": 4, "length": 5, "origin": [6,0,0],
                         "windows": [{"wall": "south", "offset": 1, "width": 1.2}]}
                    ]
                },
                {
                    "name": "First Floor",
                    "height": 3.0,
                    "rooms": [
                        {"name": "Bedroom 1", "width": 5, "length": 5, "origin": [0,0,0],
                         "windows": [{"wall": "east", "offset": 1.5, "width": 1.2}]},
                        {"name": "Bedroom 2", "width": 5, "length": 5, "origin": [5,0,0],
                         "windows": [{"wall": "east", "offset": 1.5, "width": 1.2}]}
                    ]
                }
            ],
            roof={"type": "GABLE_ROOF", "angle": 35, "thickness": 0.3}
        )
    """
    if storeys is None or len(storeys) == 0:
        raise ValueError("Building requires at least one storey specification")
    
    result = {
        "success": True,
        "building_name": building_name,
        "storeys": [],
        "roof": None,
        "errors": [],
    }
    
    # Compute elevations if not provided
    current_elevation = 0.0
    for storey_spec in storeys:
        if "elevation" not in storey_spec:
            storey_spec["elevation"] = current_elevation
        current_elevation = storey_spec["elevation"] + storey_spec.get("height", 3.0)
    
    # Create each storey
    for i, storey_spec in enumerate(storeys):
        storey_name = storey_spec.get("name", f"{building_name}_Storey_{i}")
        storey_height = storey_spec.get("height", 3.0)
        storey_elevation = storey_spec.get("elevation", 0.0)
        storey_rooms = storey_spec.get("rooms", [])
        
        # Adjust room origins to include storey elevation
        for room_spec in storey_rooms:
            origin = room_spec.get("origin", [0, 0, 0])
            if len(origin) < 3:
                origin = origin + [0.0] * (3 - len(origin))
            # Override Z to storey elevation
            origin[2] = storey_elevation
            room_spec["origin"] = origin
            # Use storey height for walls if not specified
            if "height" not in room_spec:
                room_spec["height"] = storey_height
        
        try:
            floor_result = create_floor_plan(
                plan_name=f"{building_name}_{storey_name}",
                rooms=storey_rooms,
                verbose=verbose,
            )
            
            result["storeys"].append({
                "name": storey_name,
                "elevation": storey_elevation,
                "height": storey_height,
                "rooms_created": floor_result.get("summary", {}).get("rooms_created", 0),
                "area": floor_result.get("total_area", 0),
                "result": floor_result,
            })
            
            if floor_result.get("errors"):
                result["errors"].extend(
                    [f"Storey '{storey_name}': {e}" for e in floor_result["errors"]]
                )
                
        except Exception as e:
            result["errors"].append(f"Storey '{storey_name}' error: {str(e)}")
    
    # Create roof if specified
    if roof:
        try:
            roof_type = roof.get("type", "FLAT")
            roof_angle = roof.get("angle", 30.0)
            roof_thickness = roof.get("thickness", 0.3)
            overhang = roof.get("overhang", 0.5)
            
            # Compute roof outline from the topmost storey's room extents
            top_storey = storeys[-1]
            top_rooms = top_storey.get("rooms", [])
            top_elevation = top_storey.get("elevation", 0.0) + top_storey.get("height", 3.0)
            
            # Find bounding box of all rooms in top storey
            min_x, min_y = float('inf'), float('inf')
            max_x, max_y = float('-inf'), float('-inf')
            
            for room_spec in top_rooms:
                origin = room_spec.get("origin", [0, 0, 0])
                r_width = room_spec.get("width", 4.0)
                r_length = room_spec.get("length", 4.0)
                
                min_x = min(min_x, origin[0])
                min_y = min(min_y, origin[1])
                max_x = max(max_x, origin[0] + r_width)
                max_y = max(max_y, origin[1] + r_length)
            
            # Add overhang
            roof_polyline = [
                [min_x - overhang, min_y - overhang, top_elevation],
                [max_x + overhang, min_y - overhang, top_elevation],
                [max_x + overhang, max_y + overhang, top_elevation],
                [min_x - overhang, max_y + overhang, top_elevation],
            ]
            
            from .roof import create_roof as _create_roof
            
            roof_result = _create_roof(
                polyline=roof_polyline,
                roof_type=roof_type,
                angle=roof_angle,
                thickness=roof_thickness,
                name=f"{building_name}_Roof",
                verbose=verbose,
            )
            
            if roof_result.get("success"):
                result["roof"] = {
                    "guid": roof_result.get("roof_guid"),
                    "type": roof_type,
                    "elevation": top_elevation,
                }
            else:
                result["errors"].append(f"Roof creation failed: {roof_result}")
                
        except Exception as e:
            result["errors"].append(f"Roof error: {str(e)}")
    
    # Summary
    total_rooms = sum(s.get("rooms_created", 0) for s in result["storeys"])
    total_area = sum(s.get("area", 0) for s in result["storeys"])
    
    result["summary"] = {
        "storeys": len(result["storeys"]),
        "total_rooms": total_rooms,
        "total_area_sqm": round(total_area, 2),
        "has_roof": result["roof"] is not None,
        "errors": len(result["errors"]),
    }
    
    result["message"] = (
        f"Building '{building_name}': {len(result['storeys'])} storeys, "
        f"{total_rooms} rooms, {total_area:.1f}m²"
        + (f", {roof_type} roof" if result["roof"] else "")
    )
    
    return result
