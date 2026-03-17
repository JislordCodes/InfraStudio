"""Stairs API Functions for IFC Bonsai MCP

Examples:
    create_stairs(width=1.2, height=3.0, stairs_type="STRAIGHT", num_steps=15, tread_depth=0.25)
    create_stairs(width=1.5, height=2.8, stairs_type="SPIRAL", num_steps=18, radius=1.0)
    create_stairs(width=1.0, height=3.5, stairs_type="L_SHAPED", num_steps=20, landing_width=1.2)
    create_stairs(width=1.3, height=4.0, stairs_type="U_SHAPED", num_steps=24, landing_depth=1.5)
    create_simple_stairs(name="Main Stairs", width=1.2, length=4.0, height=3.0)
"""
from typing import Any, Dict, List, Optional, Union, Tuple
from dataclasses import dataclass
import math
import numpy as np
import ifcopenshell
import ifcopenshell.api

from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    calculate_unit_scale, degrees_to_radians, create_transformation_matrix, 
    save_and_load_ifc, ensure_counter_clockwise
)

from . import register_command


STAIRS_TYPES = {
    "STRAIGHT": "STRAIGHT_RUN_STAIR",
    "SPIRAL": "SPIRAL_STAIR", 
    "CURVED": "CURVED_RUN_STAIR",
    "L_SHAPED": "QUARTER_TURN_STAIR",
    "U_SHAPED": "HALF_TURN_STAIR",
    "WINDING": "QUARTER_WINDING_STAIR",
    "BIFURCATED": "BIFURCATED_STAIR",
    "NOTDEFINED": "NOTDEFINED",
    "USERDEFINED": "USERDEFINED"
}


@dataclass
class StairsProperties:
    """Stairs properties for IFC creation."""
    name: str = "New Stairs"
    stairs_type: str = "STRAIGHT_RUN_STAIR"
    predefined_type: str = "NOTDEFINED"
    width: float = 1.2
    height: float = 3.0
    num_steps: int = 15
    tread_depth: float = 0.25
    riser_height: float = 0.2
    radius: Optional[float] = None
    landing_width: Optional[float] = None
    landing_depth: Optional[float] = None


def generate_stairs_geometry(
    stairs_type: str,
    width: float,
    height: float,
    num_steps: int,
    tread_depth: float = 0.25,
    riser_height: Optional[float] = None,
    radius: Optional[float] = None,
    landing_width: Optional[float] = None,
    landing_depth: Optional[float] = None
) -> Tuple[List[Tuple[float, float, float]], List[List[int]]]:
    """Generate stairs vertices and faces based on type and parameters.
    
    Args:
        stairs_type: Type of stairs (STRAIGHT, SPIRAL, L_SHAPED, U_SHAPED)
        width: Stairs width in meters
        height: Total height in meters
        num_steps: Number of steps
        tread_depth: Depth of each tread in meters
        riser_height: Height of each riser in meters
        radius: Radius for spiral stairs in meters
        landing_width: Landing width for L/U shaped stairs
        landing_depth: Landing depth for L/U shaped stairs
    """
    
    if riser_height is None:
        riser_height = height / num_steps
    
    vertices = []
    faces = []
    
    if stairs_type.upper() in ["STRAIGHT", "STRAIGHT_RUN_STAIR"]:
        vertices, faces = _generate_straight_stairs(width, height, num_steps, tread_depth, riser_height)
    
    elif stairs_type.upper() in ["SPIRAL", "SPIRAL_STAIR"]:
        if radius is None:
            radius = width * 1.5
        vertices, faces = _generate_spiral_stairs(width, height, num_steps, radius, riser_height)
    
    elif stairs_type.upper() in ["L_SHAPED", "QUARTER_TURN_STAIR"]:
        if landing_width is None:
            landing_width = width
        vertices, faces = _generate_l_shaped_stairs(width, height, num_steps, tread_depth, riser_height, landing_width)
    
    elif stairs_type.upper() in ["U_SHAPED", "HALF_TURN_STAIR"]:
        if landing_depth is None:
            landing_depth = width * 2
        vertices, faces = _generate_u_shaped_stairs(width, height, num_steps, tread_depth, riser_height, landing_depth)
    
    else:
        vertices, faces = _generate_straight_stairs(width, height, num_steps, tread_depth, riser_height)
    
    corrected_faces = []
    for face in faces:
        if len(face) >= 3:
            corrected_faces.append(ensure_counter_clockwise(face, vertices))
        else:
            corrected_faces.append(face)
    
    return vertices, corrected_faces


def _generate_straight_stairs(width, height, num_steps, tread_depth, riser_height):
    """Generate straight stairs geometry."""
    vertices = []
    faces = []
    
    for step in range(num_steps):
        y_pos = step * tread_depth
        z_pos = step * riser_height
        
        v0 = (0.0, y_pos, z_pos)
        v1 = (width, y_pos, z_pos)
        v2 = (width, y_pos + tread_depth, z_pos)
        v3 = (0.0, y_pos + tread_depth, z_pos)
        
        v4 = (0.0, y_pos, z_pos + riser_height)
        v5 = (width, y_pos, z_pos + riser_height)
        v6 = (width, y_pos + tread_depth, z_pos + riser_height)
        v7 = (0.0, y_pos + tread_depth, z_pos + riser_height)
        
        base_idx = len(vertices)
        vertices.extend([v0, v1, v2, v3, v4, v5, v6, v7])
        
        faces.append([base_idx + 3, base_idx + 2, base_idx + 1, base_idx + 0])
        faces.append([base_idx + 4, base_idx + 5, base_idx + 6, base_idx + 7])
        faces.append([base_idx + 0, base_idx + 1, base_idx + 5, base_idx + 4])
        faces.append([base_idx + 2, base_idx + 3, base_idx + 7, base_idx + 6])
        faces.append([base_idx + 3, base_idx + 0, base_idx + 4, base_idx + 7])
        faces.append([base_idx + 1, base_idx + 2, base_idx + 6, base_idx + 5])
    
    return vertices, faces


def _generate_spiral_stairs(width, height, num_steps, radius, riser_height):
    """Generate spiral stairs geometry."""
    vertices = []
    faces = []
    
    angle_per_step = 2 * math.pi / num_steps
    
    for step in range(num_steps):
        angle = step * angle_per_step
        z_pos = step * riser_height
        
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        cos_a_next = math.cos(angle + angle_per_step)
        sin_a_next = math.sin(angle + angle_per_step)
        
        inner_r = radius - width / 2
        outer_r = radius + width / 2
        
        v0 = (inner_r * cos_a, inner_r * sin_a, z_pos)
        v1 = (outer_r * cos_a, outer_r * sin_a, z_pos)
        v2 = (outer_r * cos_a_next, outer_r * sin_a_next, z_pos)
        v3 = (inner_r * cos_a_next, inner_r * sin_a_next, z_pos)
        
        v4 = (inner_r * cos_a, inner_r * sin_a, z_pos + riser_height)
        v5 = (outer_r * cos_a, outer_r * sin_a, z_pos + riser_height)
        v6 = (outer_r * cos_a_next, outer_r * sin_a_next, z_pos + riser_height)
        v7 = (inner_r * cos_a_next, inner_r * sin_a_next, z_pos + riser_height)
        
        base_idx = len(vertices)
        vertices.extend([v0, v1, v2, v3, v4, v5, v6, v7])
        
        faces.append([base_idx + 3, base_idx + 2, base_idx + 1, base_idx + 0])
        faces.append([base_idx + 4, base_idx + 5, base_idx + 6, base_idx + 7])
        faces.append([base_idx + 0, base_idx + 1, base_idx + 5, base_idx + 4])
        faces.append([base_idx + 2, base_idx + 3, base_idx + 7, base_idx + 6])
        faces.append([base_idx + 3, base_idx + 0, base_idx + 4, base_idx + 7])
        faces.append([base_idx + 1, base_idx + 2, base_idx + 6, base_idx + 5])
    
    return vertices, faces


def _generate_l_shaped_stairs(width, height, num_steps, tread_depth, riser_height, landing_width):
    """Generate L-shaped stairs geometry."""
    run1_steps = num_steps // 2
    run2_steps = num_steps - run1_steps
    
    vertices = []
    faces = []
    
    run1_vertices, run1_faces = _generate_straight_stairs(width, run1_steps * riser_height, run1_steps, tread_depth, riser_height)
    vertices.extend(run1_vertices)
    faces.extend(run1_faces)
    
    landing_z = run1_steps * riser_height
    landing_length = tread_depth * 2
    
    landing_verts = [
        (0.0, run1_steps * tread_depth, landing_z),
        (width, run1_steps * tread_depth, landing_z),
        (width, run1_steps * tread_depth + landing_length, landing_z),
        (width + landing_width, run1_steps * tread_depth + landing_length, landing_z),
        (width + landing_width, run1_steps * tread_depth, landing_z),
        (0.0, run1_steps * tread_depth, landing_z + riser_height),
        (width, run1_steps * tread_depth, landing_z + riser_height),
        (width, run1_steps * tread_depth + landing_length, landing_z + riser_height),
        (width + landing_width, run1_steps * tread_depth + landing_length, landing_z + riser_height),
        (width + landing_width, run1_steps * tread_depth, landing_z + riser_height)
    ]
    
    base_idx = len(vertices)
    vertices.extend(landing_verts)
    
    faces.append([base_idx + 4, base_idx + 3, base_idx + 2, base_idx + 1, base_idx + 0])
    faces.append([base_idx + 5, base_idx + 6, base_idx + 7, base_idx + 8, base_idx + 9])
    
    for step in range(run2_steps):
        x_pos = width + step * tread_depth
        z_pos = (run1_steps + step + 1) * riser_height
        
        step_verts = [
            (x_pos, run1_steps * tread_depth, z_pos),
            (x_pos + tread_depth, run1_steps * tread_depth, z_pos),
            (x_pos + tread_depth, run1_steps * tread_depth + landing_width, z_pos),
            (x_pos, run1_steps * tread_depth + landing_width, z_pos),
            (x_pos, run1_steps * tread_depth, z_pos + riser_height),
            (x_pos + tread_depth, run1_steps * tread_depth, z_pos + riser_height),
            (x_pos + tread_depth, run1_steps * tread_depth + landing_width, z_pos + riser_height),
            (x_pos, run1_steps * tread_depth + landing_width, z_pos + riser_height)
        ]
        
        base_idx = len(vertices)
        vertices.extend(step_verts)
        
        faces.append([base_idx + 3, base_idx + 2, base_idx + 1, base_idx + 0])
        faces.append([base_idx + 4, base_idx + 5, base_idx + 6, base_idx + 7])
        faces.append([base_idx + 0, base_idx + 1, base_idx + 5, base_idx + 4])
        faces.append([base_idx + 2, base_idx + 3, base_idx + 7, base_idx + 6])
        faces.append([base_idx + 3, base_idx + 0, base_idx + 4, base_idx + 7])
        faces.append([base_idx + 1, base_idx + 2, base_idx + 6, base_idx + 5])
    
    return vertices, faces


def _generate_u_shaped_stairs(width, height, num_steps, tread_depth, riser_height, landing_depth):
    """Generate U-shaped stairs geometry."""
    run1_steps = num_steps // 3
    run2_steps = num_steps // 3
    run3_steps = num_steps - run1_steps - run2_steps
    
    vertices = []
    faces = []
    
    run1_vertices, run1_faces = _generate_straight_stairs(width, run1_steps * riser_height, run1_steps, tread_depth, riser_height)
    vertices.extend(run1_vertices)
    faces.extend(run1_faces)
    
    landing1_z = run1_steps * riser_height
    landing1_y = run1_steps * tread_depth
    
    run2_offset_x = width + landing_depth
    for step in range(run2_steps):
        y_pos = landing1_y + (run2_steps - step - 1) * tread_depth
        z_pos = (run1_steps + step + 1) * riser_height
        
        step_verts = [
            (run2_offset_x, y_pos, z_pos),
            (run2_offset_x + width, y_pos, z_pos),
            (run2_offset_x + width, y_pos + tread_depth, z_pos),
            (run2_offset_x, y_pos + tread_depth, z_pos),
            (run2_offset_x, y_pos, z_pos + riser_height),
            (run2_offset_x + width, y_pos, z_pos + riser_height),
            (run2_offset_x + width, y_pos + tread_depth, z_pos + riser_height),
            (run2_offset_x, y_pos + tread_depth, z_pos + riser_height)
        ]
        
        base_idx = len(vertices)
        vertices.extend(step_verts)
        
        faces.append([base_idx + 3, base_idx + 2, base_idx + 1, base_idx + 0])
        faces.append([base_idx + 4, base_idx + 5, base_idx + 6, base_idx + 7])
        faces.append([base_idx + 0, base_idx + 1, base_idx + 5, base_idx + 4])
        faces.append([base_idx + 2, base_idx + 3, base_idx + 7, base_idx + 6])
        faces.append([base_idx + 3, base_idx + 0, base_idx + 4, base_idx + 7])
        faces.append([base_idx + 1, base_idx + 2, base_idx + 6, base_idx + 5])
    
    return vertices, faces


@register_command('get_stairs_types', description="Get all supported stairs types")
def get_stairs_types() -> Dict[str, Any]:
    """Get all stairs types with descriptions."""
    try:
        return {
            "success": True,
            "stairs_types": STAIRS_TYPES,
            "message": f"Found {len(STAIRS_TYPES)} stairs types"
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "stairs_types": {}
        }


@register_command('create_stairs', description="Create stairs using IFC mesh representation")
def create_stairs(
    width: float,
    height: float,
    stairs_type: str = "STRAIGHT",
    num_steps: Optional[int] = None,
    length: float = 4.0,
    riser_height: Optional[float] = None,
    radius: Optional[float] = None,
    landing_width: Optional[float] = None,
    landing_depth: Optional[float] = None,
    name: Optional[str] = None,
    location: Optional[List[float]] = None,
    rotation: Optional[List[float]] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    unit_scale: Optional[float] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Create parametric IfcStair using add_mesh_representation.
    
    Args:
        width: Stairs width in meters
        height: Total height in meters
        stairs_type: Type of stairs (STRAIGHT, SPIRAL, L_SHAPED, U_SHAPED)
        num_steps: Number of steps (auto-calculated if None)
        length: Length of each tread in meters
        riser_height: Height of each riser in meters (auto-calculated if None)
        radius: Radius for spiral stairs in meters
        landing_width: Landing width for L/U shaped stairs
        landing_depth: Landing depth for L/U shaped stairs
        name: Optional stairs name
        location: [x,y,z] offset position
        rotation: [rx,ry,rz] rotation angles in degrees
        transformation_matrix: Optional 4x4 transformation matrix
        unit_scale: IFC unit scale factor
        verbose: Print debug information
    """
    
    try:
        if width <= 0 or height <= 0:
            return {"success": False, "error": "Width and height must be positive", "stairs_guid": None}
        
        if name is None:
            name = f"Stairs_{stairs_type}_{width:.1f}x{height:.1f}"
        if location is None:
            location = [0.0, 0.0, 0.0]
        if rotation is None:
            rotation = [0.0, 0.0, 0.0]
        
        if num_steps is None:
            ideal_riser = 0.175
            num_steps = max(int(height / ideal_riser), 3)
        
        if riser_height is None:
            riser_height = height / num_steps

        tread_depth = length / num_steps if num_steps > 0 else 0.25

        stairs_type_ifc = STAIRS_TYPES.get(stairs_type.upper(), "NOTDEFINED")
        
        ifc_file = get_ifc_file()
        container = get_default_container()
        
        if unit_scale is None:
            unit_scale = calculate_unit_scale(ifc_file)
        
        stair = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcStair",
            name=name,
            predefined_type=stairs_type_ifc
        )
        
        ifcopenshell.api.run(
            "spatial.assign_container",
            ifc_file,
            products=[stair],
            relating_structure=container
        )
        
        body_context = get_or_create_body_context(ifc_file)
        
        vertices, faces = generate_stairs_geometry(
            stairs_type, width, height, num_steps, tread_depth, riser_height,
            radius, landing_width, landing_depth
        )
        
        stair_representation = ifcopenshell.api.run(
            "geometry.add_mesh_representation",
            ifc_file,
            context=body_context,
            vertices=[vertices],
            faces=[faces],
            unit_scale=unit_scale
        )
        
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=stair,
            representation=stair_representation
        )
        
        if transformation_matrix is not None:
            if isinstance(transformation_matrix, list):
                mat = np.array(transformation_matrix)
            else:
                mat = transformation_matrix
        else:
            mat = create_transformation_matrix(
                position_x=location[0],
                position_y=location[1], 
                position_z=location[2],
                rotation_x=rotation[0],
                rotation_y=rotation[1],
                rotation_z=rotation[2]
            )
        
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            ifc_file,
            product=stair,
            matrix=mat.tolist()
        )
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Created stairs: {name} with {len(vertices)} vertices and {len(faces)} faces")
        
        return {
            "success": True,
            "stairs_guid": stair.GlobalId,
            "name": name,
            "stairs_type": stairs_type_ifc,
            "width": width,
            "height": height,
            "num_steps": num_steps,
            "vertices_count": len(vertices),
            "faces_count": len(faces)
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "stairs_guid": None
        }


@register_command('update_stairs', description="Update existing stairs properties")
def update_stairs(
    stairs_guid: str,
    width: Optional[float] = None,
    height: Optional[float] = None,
    stairs_type: Optional[str] = None,
    num_steps: Optional[int] = None,
    name: Optional[str] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Update existing stairs properties and regenerate geometry.
    
    Args:
        stairs_guid: The GUID of the stairs to update
        width: New stairs width
        height: New stairs height
        stairs_type: New stairs type
        num_steps: New number of steps
        name: New name for the stairs
        verbose: Enable verbose logging
    """
    try:
        ifc_file = get_ifc_file()
        stair = _get_stairs_by_guid(stairs_guid, ifc_file)
        if not stair:
            return {"success": False, "error": f"Stairs with GUID {stairs_guid} not found"}
        
        needs_geometry_update = any(param is not None for param in [width, height, stairs_type, num_steps])
        
        if needs_geometry_update:
            current_params = _extract_stairs_geometry_params(stair)
            if not current_params:
                return {"success": False, "error": "Could not extract current stairs parameters"}
            
            new_width = width or current_params.get('width', 1.2)
            new_height = height or current_params.get('height', 3.0)
            new_type = stairs_type or current_params.get('stairs_type', 'STRAIGHT')
            new_steps = num_steps or current_params.get('num_steps', 15)
            
            vertices, faces = generate_stairs_geometry(new_type, new_width, new_height, new_steps)
            
            body_context = get_or_create_body_context(ifc_file)
            unit_scale = calculate_unit_scale(ifc_file)
            
            new_representation = ifcopenshell.api.run(
                "geometry.add_mesh_representation",
                ifc_file,
                context=body_context,
                vertices=[vertices],
                faces=[faces],
                unit_scale=unit_scale
            )
            
            ifcopenshell.api.run(
                "geometry.assign_representation",
                ifc_file,
                product=stair,
                representation=new_representation
            )
        else:
            if name:
                stair.Name = name
            if stairs_type:
                stair.PredefinedType = STAIRS_TYPES.get(stairs_type.upper(), "NOTDEFINED")
        
        save_and_load_ifc()
        
        return {
            "success": True,
            "stairs_guid": stairs_guid,
            "message": "Stairs updated successfully"
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('delete_stairs', description="Delete stairs by GUID")
def delete_stairs(stairs_guids: List[str]) -> Dict[str, Any]:
    """Delete stairs by their IFC GUIDs.
    
    Args:
        stairs_guids: List of stairs GUIDs to delete
    """
    
    try:
        ifc_file = get_ifc_file()
        deleted_count = 0
        errors = []
        
        for guid in stairs_guids:
            try:
                stair = ifc_file.by_guid(guid)
                if stair and stair.is_a("IfcStair"):
                    ifcopenshell.api.run("root.remove_product", ifc_file, product=stair)
                    deleted_count += 1
                else:
                    errors.append(f"Stairs with GUID {guid} not found")
            except Exception as e:
                errors.append(f"Error deleting stairs {guid}: {str(e)}")
        
        save_and_load_ifc()
        
        return {
            "success": deleted_count > 0,
            "deleted_count": deleted_count,
            "errors": errors,
            "message": f"Deleted {deleted_count} stairs"
        }
        
    except Exception as e:
        return {"success": False, "error": str(e), "deleted_count": 0}


def _get_stairs_by_guid(stairs_guid: str, ifc_file=None):
    """Get stairs entity by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()
    
    try:
        stair = ifc_file.by_guid(stairs_guid)
        if stair and stair.is_a("IfcStair"):
            return stair
    except:
        pass
    
    return None


def _extract_stairs_geometry_params(stair):
    """Extract geometry parameters from existing stairs representation."""
    try:
        if not stair.Representation or not stair.Representation.Representations:
            return None
        
        params = {
            'width': 1.2,
            'height': 3.0,
            'stairs_type': 'STRAIGHT',
            'num_steps': 15,
            'tread_depth': 0.25
        }
        
        psets = ifcopenshell.util.element.get_psets(stair)
        if psets:
            for pset_name, pset_data in psets.items():
                if 'Width' in pset_data:
                    params['width'] = pset_data['Width']
                if 'Height' in pset_data:
                    params['height'] = pset_data['Height']
                if 'NumberOfRisers' in pset_data:
                    params['num_steps'] = pset_data['NumberOfRisers']
        
        return params
    except Exception:
        return None
