"""Room API — Deterministic Geometry Orchestration Layer for IFC Bonsai MCP

This module provides a high-level `create_room` command that accepts a structured
JSON specification and deterministically generates all IFC geometry:

  - Closed wall loops with correct coordinates and rotations
  - Floor/ceiling slabs matching the room perimeter
  - Doors with openings properly hosted in walls
  - Windows with openings properly hosted in walls
  - Correct BIM topology (opening→wall, filling→opening)

The LLM never needs to calculate coordinates, manage GUIDs, compute rotations,
or sequence individual tool calls. It only describes architectural intent.

Example spec:
    {
        "room_name": "Living Room",
        "width": 4.0,
        "length": 5.0,
        "height": 3.0,
        "wall_thickness": 0.2,
        "origin": [0, 0, 0],
        "floor_slab": true,
        "ceiling_slab": false,
        "doors": [
            {"wall": "south", "offset": 1.5, "width": 0.9, "height": 2.1}
        ],
        "windows": [
            {"wall": "east", "offset": 2.0, "width": 1.2, "height": 1.5, "sill_height": 0.9}
        ]
    }
"""

import math
import logging
from typing import Any, Dict, List, Optional, Tuple

from . import register_command

logger = logging.getLogger(__name__)


# ─── Wall orientation mapping ────────────────────────────────────────────────
#
# Room coordinate system (looking down, +Y is north):
#
#        NW ─────────── NE
#        │               │
#  west  │     room      │ east
#        │               │
#        SW ─────────── SE
#              south
#
# Origin (SW corner) = user-specified origin
# Width  = X-axis (west→east)
# Length  = Y-axis (south→north)
#
# Wall definitions:
#   south: SW → SE  (along +X, rotation=0°)
#   east:  SE → NE  (along +Y, rotation=90°)
#   north: NE → NW  (along −X, rotation=180°)
#   west:  NW → SW  (along −Y, rotation=270°)
#
# "Offset" for doors/windows = distance from the START of the wall segment
# ──────────────────────────────────────────────────────────────────────────────


def _compute_wall_segments(
    width: float,
    length: float,
    origin: Tuple[float, float, float],
    wall_thickness: float = 0.2,
) -> Dict[str, Dict[str, Any]]:
    """Compute the four wall placement points for a rectangular room.

    Each wall is placed at its START outer-face corner. The wall body is
    centred on its axis by passing offset=-thickness/2 to create_wall.
    This avoids corner gaps: the body fills exactly from outer face to
    outer face of adjacent walls.

    Layout (looking down, +Y = north):

        NW ─────── north ─────── NE
        |                         |
       west      interior        east
        |                         |
        SW ─────── south ─────── SE

    Wall extents after centring:
        south: SW → SE  full width
        east:  SE → NE  full length
        north: NE → NW  full width
        west:  NW → SW  full length
    """
    ox, oy, oz = origin

    # Outer-face corner points
    sw = (ox,         oy,          oz)
    se = (ox + width, oy,          oz)
    ne = (ox + width, oy + length, oz)
    nw = (ox,         oy + length, oz)

    return {
        "south": {
            "start": sw,
            "end": se,
            "wall_length": width,
            "rotation_deg": 0.0,
        },
        "east": {
            "start": se,
            "end": ne,
            "wall_length": length,
            "rotation_deg": 90.0,
        },
        "north": {
            "start": ne,
            "end": nw,
            "wall_length": width,
            "rotation_deg": 180.0,
        },
        "west": {
            "start": nw,
            "end": sw,
            "wall_length": length,
            "rotation_deg": 270.0,
        },
    }



def _validate_opening_fits(
    opening_offset: float,
    opening_width: float,
    wall_length: float,
    wall_name: str,
    opening_type: str,  # "door" or "window"
    opening_idx: int,
) -> None:
    """Validate that an opening fits within its host wall."""
    if opening_offset < 0:
        raise ValueError(
            f"{opening_type.capitalize()} #{opening_idx} on {wall_name} wall: "
            f"offset ({opening_offset}m) cannot be negative"
        )
    if opening_offset + opening_width > wall_length:
        raise ValueError(
            f"{opening_type.capitalize()} #{opening_idx} on {wall_name} wall: "
            f"offset ({opening_offset}m) + width ({opening_width}m) = "
            f"{opening_offset + opening_width}m exceeds wall length ({wall_length}m)"
        )


def _compute_opening_position(
    wall_segment: Dict[str, Any],
    offset_along_wall: float,
    opening_width: float,
    opening_height: float,
    sill_height: float,
    wall_thickness: float,
) -> Tuple[List[float], List[float]]:
    """Compute the 3D position and rotation for a door/window opening.
    
    The opening is positioned along the wall axis at the specified offset,
    centered on the opening width, at the sill height.
    
    Returns (location, rotation_degrees).
    """
    sx, sy, sz = wall_segment["start"]
    ex, ey, ez = wall_segment["end"]
    wall_len = wall_segment["wall_length"]
    rot_deg = wall_segment["rotation_deg"]
    
    # Unit direction vector along the wall
    if wall_len > 0:
        dx = (ex - sx) / wall_len
        dy = (ey - sy) / wall_len
    else:
        dx, dy = 1.0, 0.0
    
    # Position = start + (offset + half_width) * direction
    # This centers the opening on the specified offset point
    center_along = offset_along_wall + opening_width / 2.0
    
    pos_x = sx + center_along * dx
    pos_y = sy + center_along * dy
    pos_z = sz + sill_height
    
    return [pos_x, pos_y, pos_z], [0.0, 0.0, rot_deg]


@register_command('create_room', description="Create a complete room with walls, slabs, doors, and windows from a structured specification")
def create_room(
    room_name: str = "Room",
    width: float = 4.0,
    length: float = 5.0,
    height: float = 3.0,
    wall_thickness: float = 0.2,
    origin: Optional[List[float]] = None,
    floor_slab: bool = True,
    floor_thickness: float = 0.2,
    ceiling_slab: bool = False,
    ceiling_thickness: float = 0.15,
    doors: Optional[List[Dict[str, Any]]] = None,
    windows: Optional[List[Dict[str, Any]]] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create a complete rectangular room deterministically.
    
    This function is the core of the geometry orchestration layer. It:
    1. Computes wall coordinates from width/length/origin
    2. Creates a closed wall loop using create_polyline_walls
    3. Creates floor slab matching the room perimeter
    4. Creates doors with proper openings in host walls
    5. Creates windows with proper openings in host walls
    6. Returns a complete scene graph with all GUIDs
    
    Args:
        room_name: Name prefix for all elements
        width: Room width in meters (X-axis, west→east)
        length: Room length in meters (Y-axis, south→north)
        height: Wall height in meters
        wall_thickness: Wall thickness in meters
        origin: [x, y, z] position of south-west corner (default: [0, 0, 0])
        floor_slab: Whether to create a floor slab
        floor_thickness: Floor slab thickness in meters
        ceiling_slab: Whether to create a ceiling slab
        ceiling_thickness: Ceiling slab thickness in meters
        doors: List of door specifications, each with:
            - wall (str): "south", "north", "east", or "west"
            - offset (float): Distance from start of wall in meters
            - width (float): Door width in meters (default: 0.9)
            - height (float): Door height in meters (default: 2.1)
            - operation_type (str): Door swing type (default: "SINGLE_SWING_LEFT")
        windows: List of window specifications, each with:
            - wall (str): "south", "north", "east", or "west"
            - offset (float): Distance from start of wall in meters
            - width (float): Window width in meters (default: 1.2)
            - height (float): Window height in meters (default: 1.5)
            - sill_height (float): Height from floor in meters (default: 0.9)
            - partition_type (str): Window panel config (default: "SINGLE_PANEL")
        verbose: Print debug information
        
    Returns:
        Dict with success status and complete scene graph including all GUIDs.
    """
    if origin is None:
        origin = [0.0, 0.0, 0.0]
    if doors is None:
        doors = []
    if windows is None:
        windows = []
    
    # ── Validate dimensions ──────────────────────────────────────────────────
    if width <= 0 or length <= 0 or height <= 0:
        raise ValueError(f"Room dimensions must be positive: width={width}, length={length}, height={height}")
    if wall_thickness <= 0 or wall_thickness >= min(width, length) / 2:
        raise ValueError(f"Wall thickness ({wall_thickness}m) must be positive and less than half the smallest room dimension")
    
    # ── Compute wall geometry ────────────────────────────────────────────────
    wall_segments = _compute_wall_segments(width, length, tuple(origin), wall_thickness)
    
    # ── Validate all openings before creating anything ───────────────────────
    valid_wall_names = {"south", "east", "north", "west"}
    
    for i, door_spec in enumerate(doors):
        wall_name = door_spec.get("wall", "").lower()
        if wall_name not in valid_wall_names:
            raise ValueError(
                f"Door #{i}: wall must be one of {valid_wall_names}, got '{wall_name}'"
            )
        door_width = door_spec.get("width", 0.9)
        door_offset = door_spec.get("offset", 0.0)
        wall_len = wall_segments[wall_name]["wall_length"]
        _validate_opening_fits(door_offset, door_width, wall_len, wall_name, "door", i)
    
    for i, win_spec in enumerate(windows):
        wall_name = win_spec.get("wall", "").lower()
        if wall_name not in valid_wall_names:
            raise ValueError(
                f"Window #{i}: wall must be one of {valid_wall_names}, got '{wall_name}'"
            )
        win_width = win_spec.get("width", 1.2)
        win_offset = win_spec.get("offset", 0.0)
        wall_len = wall_segments[wall_name]["wall_length"]
        _validate_opening_fits(win_offset, win_width, wall_len, wall_name, "window", i)
    
    # ── Results accumulator ──────────────────────────────────────────────────
    result = {
        "success": True,
        "room_name": room_name,
        "dimensions": {"width": width, "length": length, "height": height},
        "origin": origin,
        "walls": {},
        "slabs": {},
        "doors": [],
        "windows": [],
        "errors": [],
    }
    
    # ── PHASE 1: Create walls ────────────────────────────────────────────────
    #
    # Each wall is created individually so we can set geometry_properties.
    #
    # KEY: offset = -(wall_thickness / 2) centres the wall body on its axis.
    # The default offset=0 extrudes the body entirely to one side (left of
    # travel), which causes north and west walls to protrude outward.
    #
    # With centred offset + outer-face start points, each wall's body spans
    # exactly from its outer face to the adjacent wall's outer face.
    #
    from .wall import create_wall as _create_wall

    try:
        for cardinal in ["south", "east", "north", "west"]:
            seg = wall_segments[cardinal]
            sx, sy, sz = seg["start"]
            wall_name_c = f"{room_name}_Wall_{cardinal.capitalize()}"

            wr = _create_wall(
                name=wall_name_c,
                dimensions={
                    "length": seg["wall_length"],
                    "height": height,
                    "thickness": wall_thickness,
                },
                location=[sx, sy, sz],
                rotation=[0.0, 0.0, seg["rotation_deg"]],
                geometry_properties={
                    "direction_sense": "POSITIVE",
                    "offset": -(wall_thickness / 2.0),
                    "x_angle": 0.0,
                },
            )

            if wr.get("success"):
                result["walls"][cardinal] = {
                    "guid": wr["wall_guid"],
                    "name": wall_name_c,
                    "length": seg["wall_length"],
                    "start": list(seg["start"]),
                    "end": list(seg["end"]),
                }
                if verbose:
                    logger.info(f"Created {cardinal} wall guid={wr['wall_guid']}")
            else:
                result["errors"].append(f"{cardinal} wall failed: {wr}")
                result["success"] = False
                return result

    except Exception as e:
        result["errors"].append(f"Wall creation error: {str(e)}")
        result["success"] = False
        return result
    
    # ── PHASE 2: Create floor slab ───────────────────────────────────────────
    if floor_slab:
        try:
            from .slab import create_slab
            
            # Slab polyline matches the room perimeter (2D points)
            slab_polyline = [
                (0.0, 0.0),
                (width, 0.0),
                (width, length),
                (0.0, length),
            ]
            
            floor_result = create_slab(
                name=f"{room_name}_Floor",
                polyline=slab_polyline,
                depth=floor_thickness,
                location=[ox, oy, oz],
            )
            
            if floor_result.get("success"):
                result["slabs"]["floor"] = {
                    "guid": floor_result.get("slab_guid"),
                    "name": floor_result.get("name"),
                    "thickness": floor_thickness,
                }
                if verbose:
                    logger.info(f"Created floor slab for {room_name}")
            else:
                result["errors"].append(f"Floor slab failed: {floor_result}")
                
        except Exception as e:
            result["errors"].append(f"Floor slab error: {str(e)}")
    
    # ── PHASE 2b: Create ceiling slab ────────────────────────────────────────
    if ceiling_slab:
        try:
            from .slab import create_slab
            
            ceiling_polyline = [
                (0.0, 0.0),
                (width, 0.0),
                (width, length),
                (0.0, length),
            ]
            
            ceiling_result = create_slab(
                name=f"{room_name}_Ceiling",
                polyline=ceiling_polyline,
                depth=ceiling_thickness,
                location=[ox, oy, oz + height],
            )
            
            if ceiling_result.get("success"):
                result["slabs"]["ceiling"] = {
                    "guid": ceiling_result.get("slab_guid"),
                    "name": ceiling_result.get("name"),
                    "thickness": ceiling_thickness,
                }
                if verbose:
                    logger.info(f"Created ceiling slab for {room_name}")
            else:
                result["errors"].append(f"Ceiling slab failed: {ceiling_result}")
                
        except Exception as e:
            result["errors"].append(f"Ceiling slab error: {str(e)}")
    
    # ── PHASE 3: Create doors with openings ──────────────────────────────────
    for i, door_spec in enumerate(doors):
        try:
            wall_name = door_spec.get("wall", "south").lower()
            door_width = door_spec.get("width", 0.9)
            door_height = door_spec.get("height", 2.1)
            door_offset = door_spec.get("offset", 0.0)
            operation_type = door_spec.get("operation_type", "SINGLE_SWING_LEFT")
            door_name = door_spec.get("name", f"{room_name}_Door_{i+1}")
            
            # Get the wall GUID for this cardinal direction
            wall_info = result["walls"].get(wall_name)
            if not wall_info or not wall_info.get("guid"):
                result["errors"].append(f"Door #{i}: no wall GUID for '{wall_name}' wall")
                continue
            
            wall_guid = wall_info["guid"]
            segment = wall_segments[wall_name]
            
            # Compute door position along the wall
            location, rotation = _compute_opening_position(
                wall_segment=segment,
                offset_along_wall=door_offset,
                opening_width=door_width,
                opening_height=door_height,
                sill_height=0.0,  # Doors start at floor level
                wall_thickness=wall_thickness,
            )
            
            from .door import create_door
            
            door_result = create_door(
                name=door_name,
                dimensions={"width": door_width, "height": door_height},
                operation_type=operation_type,
                location=location,
                rotation=rotation,
                wall_guid=wall_guid,
                create_opening=True,
                verbose=verbose,
            )
            
            if door_result.get("success"):
                result["doors"].append({
                    "guid": door_result.get("door_guid"),
                    "name": door_name,
                    "wall": wall_name,
                    "wall_guid": wall_guid,
                    "width": door_width,
                    "height": door_height,
                    "offset": door_offset,
                    "location": location,
                })
                if verbose:
                    logger.info(f"Created door '{door_name}' on {wall_name} wall")
            else:
                result["errors"].append(
                    f"Door #{i} on {wall_name}: {door_result.get('error', 'unknown error')}"
                )
                
        except Exception as e:
            result["errors"].append(f"Door #{i} error: {str(e)}")
    
    # ── PHASE 4: Create windows with openings ────────────────────────────────
    for i, win_spec in enumerate(windows):
        try:
            wall_name = win_spec.get("wall", "east").lower()
            win_width = win_spec.get("width", 1.2)
            win_height = win_spec.get("height", 1.5)
            win_offset = win_spec.get("offset", 0.0)
            sill_height = win_spec.get("sill_height", 0.9)
            partition_type = win_spec.get("partition_type", "SINGLE_PANEL")
            win_name = win_spec.get("name", f"{room_name}_Window_{i+1}")
            
            # Get the wall GUID for this cardinal direction
            wall_info = result["walls"].get(wall_name)
            if not wall_info or not wall_info.get("guid"):
                result["errors"].append(f"Window #{i}: no wall GUID for '{wall_name}' wall")
                continue
            
            wall_guid = wall_info["guid"]
            segment = wall_segments[wall_name]
            
            # Compute window position along the wall
            location, rotation = _compute_opening_position(
                wall_segment=segment,
                offset_along_wall=win_offset,
                opening_width=win_width,
                opening_height=win_height,
                sill_height=sill_height,
                wall_thickness=wall_thickness,
            )
            
            from .window import create_window
            
            window_result = create_window(
                name=win_name,
                dimensions={"width": win_width, "height": win_height},
                partition_type=partition_type,
                location=location,
                rotation=rotation,
                wall_guid=wall_guid,
                create_opening=True,
                verbose=verbose,
            )
            
            if window_result.get("success"):
                result["windows"].append({
                    "guid": window_result.get("window_guid"),
                    "name": win_name,
                    "wall": wall_name,
                    "wall_guid": wall_guid,
                    "width": win_width,
                    "height": win_height,
                    "sill_height": sill_height,
                    "offset": win_offset,
                    "location": location,
                })
                if verbose:
                    logger.info(f"Created window '{win_name}' on {wall_name} wall")
            else:
                result["errors"].append(
                    f"Window #{i} on {wall_name}: {window_result.get('error', 'unknown error')}"
                )
                
        except Exception as e:
            result["errors"].append(f"Window #{i} error: {str(e)}")
    
    # ── Build summary ────────────────────────────────────────────────────────
    result["summary"] = {
        "walls_created": len(result["walls"]),
        "slabs_created": len(result["slabs"]),
        "doors_created": len(result["doors"]),
        "windows_created": len(result["windows"]),
        "errors": len(result["errors"]),
    }
    
    result["message"] = (
        f"Room '{room_name}' created: "
        f"{result['summary']['walls_created']} walls, "
        f"{result['summary']['slabs_created']} slabs, "
        f"{result['summary']['doors_created']} doors, "
        f"{result['summary']['windows_created']} windows"
    )
    
    if result["errors"]:
        result["message"] += f" ({len(result['errors'])} warnings)"
    
    return result
