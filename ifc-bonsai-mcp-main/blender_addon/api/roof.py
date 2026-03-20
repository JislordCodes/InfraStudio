"""Roof API Functions for IFC Bonsai MCP - Version 2

Examples:
    create_roof(polyline=[[0.0, 0.0, 3.0], [10.0, 0.0, 3.0], [10.0, 10.0, 3.0], [0.0, 10.0, 3.0]], roof_type="FLAT", angle=0, thickness=0.3)
    create_roof(polyline=[[0.0, 0.0, 3.0], [15.0, 0.0, 3.0], [15.0, 8.0, 3.0], [0.0, 8.0, 3.0]], roof_type="SHED", angle=25, thickness=0.25)
    create_roof(polyline=[[0.0, 0.0, 3.0], [10.0, 0.0, 3.0], [10.0, 10.0, 3.0], [0.0, 10.0, 3.0]], roof_type="GABLE_ROOF", angle=30, thickness=0.3)
    create_roof(polyline=[[0.0, 0.0, 3.0], [12.0, 0.0, 3.0], [12.0, 12.0, 3.0], [0.0, 12.0, 3.0]], roof_type="HIP_ROOF", angle=35, thickness=0.4)
    create_roof_from_walls(use_selection=True, roof_type="HIP_ROOF", angle=30, overhang=0.5)
    create_simple_roof(name="Simple Roof", width=10.0, length=8.0, height=3.0, roof_type="GABLE_ROOF", angle=35)
"""

import math
import numpy as np
from typing import Any, Dict, List, Optional, Union, Tuple
from dataclasses import dataclass
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.unit
from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    calculate_unit_scale, degrees_to_radians,
    create_transformation_matrix, save_and_load_ifc, ensure_counter_clockwise
)

from . import register_command


ROOF_TYPES = {
    "FLAT": "FLAT_ROOF",
    "SHED": "SHED_ROOF", 
    "GABLE": "GABLE_ROOF",
    "GABLE_ROOF": "GABLE_ROOF",
    "HIP": "HIP_ROOF",
    "HIP_ROOF": "HIP_ROOF",
    "HIPPED_GABLE": "HIPPED_GABLE_ROOF",
    "GAMBREL": "GAMBREL_ROOF",
    "MANSARD": "MANSARD_ROOF",
    "BARREL": "BARREL_ROOF",
    "RAINBOW": "RAINBOW_ROOF",
    "BUTTERFLY": "BUTTERFLY_ROOF",
    "PAVILION": "PAVILION_ROOF",
    "DOME": "DOME_ROOF",
    "FREEFORM": "FREEFORM",
    "NOTDEFINED": "NOTDEFINED",
    "USERDEFINED": "USERDEFINED"
}


@dataclass
class RoofProperties:
    """Roof properties for IFC creation."""
    name: str = "New Roof"
    roof_type: str = "FLAT_ROOF"
    predefined_type: str = "NOTDEFINED"
    angle: float = 0.0  # degrees
    thickness: float = 0.3  # meters
    overhang: float = 0.0  # meters


def generate_roof_geometry(
    polyline: List[List[float]], 
    roof_type: str, 
    angle: float, 
    thickness: float
) -> Tuple[List[Tuple[float, float, float]], List[List[int]]]:
    """Generate roof vertices and faces based on type and parameters.
    
    Args:
        polyline: List of [x,y,z] coordinates defining roof outline
        roof_type: Type of roof (FLAT, GABLE_ROOF, HIP_ROOF, SHED_ROOF)
        angle: Roof slope angle in degrees
        thickness: Roof thickness in meters
    """
    
    if len(polyline) < 3:
        raise ValueError("Polyline must have at least 3 points")
    
    vertices = []
    faces = []
    
    base_points = [(float(p[0]), float(p[1]), float(p[2])) for p in polyline]
    n_points = len(base_points)
    
    min_x = min(p[0] for p in base_points)
    max_x = max(p[0] for p in base_points)
    min_y = min(p[1] for p in base_points)
    max_y = max(p[1] for p in base_points)
    base_z = base_points[0][2]
    
    width = max_x - min_x
    length = max_y - min_y
    center_x = (min_x + max_x) / 2
    center_y = (min_y + max_y) / 2
    
    if roof_type.upper() in ["FLAT", "FLAT_ROOF"]:
        vertices.extend(base_points)
        
        top_points = [(p[0], p[1], p[2] + thickness) for p in base_points]
        vertices.extend(top_points)
        
        faces.append(list(range(n_points-1, -1, -1)))
        faces.append(list(range(n_points, 2*n_points)))
        
        for i in range(n_points):
            next_i = (i + 1) % n_points
            faces.append([i, next_i, next_i + n_points, i + n_points])
    
    elif roof_type.upper() in ["GABLE_ROOF", "GABLE"]:
        vertices.extend(base_points)
        
        if width > length:
            ridge_height = length * 0.5 * math.tan(math.radians(angle))
            ridge_start = (min_x, center_y, base_z + thickness + ridge_height)
            ridge_end = (max_x, center_y, base_z + thickness + ridge_height)
        else:
            ridge_height = width * 0.5 * math.tan(math.radians(angle))
            ridge_start = (center_x, min_y, base_z + thickness + ridge_height)
            ridge_end = (center_x, max_y, base_z + thickness + ridge_height)
        
        vertices.extend([ridge_start, ridge_end])
        ridge_start_idx = n_points
        ridge_end_idx = n_points + 1
        
        faces.append(list(range(n_points-1, -1, -1)))
        
        if n_points == 4:
            if width > length:
                faces.append([0, 1, ridge_end_idx, ridge_start_idx])
                faces.append([2, 3, ridge_start_idx, ridge_end_idx])
                faces.append([3, 0, ridge_start_idx])
                faces.append([1, 2, ridge_end_idx])
            else:
                faces.append([1, 2, ridge_end_idx, ridge_start_idx])
                faces.append([3, 0, ridge_start_idx, ridge_end_idx])
                faces.append([0, 1, ridge_start_idx])
                faces.append([2, 3, ridge_end_idx])
        else:
            for i in range(n_points):
                next_i = (i + 1) % n_points
                p1 = base_points[i]
                p2 = base_points[next_i]
                edge_center = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
                
                dist_to_start = ((edge_center[0] - ridge_start[0])**2 + (edge_center[1] - ridge_start[1])**2)**0.5
                dist_to_end = ((edge_center[0] - ridge_end[0])**2 + (edge_center[1] - ridge_end[1])**2)**0.5
                
                if dist_to_start < dist_to_end:
                    faces.append([i, next_i, ridge_start_idx])
                else:
                    faces.append([i, next_i, ridge_end_idx])
    
    elif roof_type.upper() in ["HIP_ROOF", "HIP"]:
        vertices.extend(base_points)
        
        min_radius = min(width, length) * 0.5
        hip_height = min_radius * math.tan(math.radians(angle))
        
        hip_point = (center_x, center_y, base_z + thickness + hip_height)
        vertices.append(hip_point)
        hip_idx = n_points
        
        faces.append(list(range(n_points-1, -1, -1)))
        
        for i in range(n_points):
            next_i = (i + 1) % n_points
            faces.append([i, next_i, hip_idx])
    
    elif roof_type.upper() in ["SHED_ROOF", "SHED"]:
        vertices.extend(base_points)
        
        if width > length:
            rise = width * math.tan(math.radians(angle))
            top_points = []
            for p in base_points:
                factor = (p[0] - min_x) / width if width > 0 else 0
                height = base_z + thickness + rise * factor
                top_points.append((p[0], p[1], height))
        else:
            rise = length * math.tan(math.radians(angle))
            top_points = []
            for p in base_points:
                factor = (p[1] - min_y) / length if length > 0 else 0
                height = base_z + thickness + rise * factor
                top_points.append((p[0], p[1], height))
        
        vertices.extend(top_points)
        
        faces.append(list(range(n_points-1, -1, -1)))
        faces.append(list(range(n_points, 2*n_points)))
        
        for i in range(n_points):
            next_i = (i + 1) % n_points
            faces.append([i, next_i, next_i + n_points, i + n_points])
    
    else:
        return generate_roof_geometry(polyline, "FLAT", angle, thickness)
    
    corrected_faces = []
    for face in faces:
        if len(face) >= 3:
            corrected_faces.append(ensure_counter_clockwise(face, vertices))
        else:
            corrected_faces.append(face)
    
    return vertices, corrected_faces


@register_command('get_roof_types', description="Get all supported roof types")
def get_roof_types() -> Dict[str, Any]:
    """Get all roof types with descriptions."""
    try:
        return {
            "success": True,
            "roof_types": ROOF_TYPES,
            "message": f"Found {len(ROOF_TYPES)} roof types"
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "roof_types": {}
        }


@register_command('create_roof', description="Create roof from polyline outline using IFC mesh representation")
def create_roof(
    polyline: List[List[float]],
    roof_type: str = "FLAT",
    angle: float = 30.0,
    thickness: float = 0.3,
    name: Optional[str] = None,
    rotation: Optional[List[float]] = None,  # [rx, ry, rz] in degrees
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    unit_scale: Optional[float] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Create parametric IfcRoof using add_mesh_representation.
    
    Args:
        polyline: List of [x,y,z] coordinates defining roof outline
        roof_type: Type of roof (FLAT, GABLE_ROOF, HIP_ROOF, SHED_ROOF)
        angle: Roof slope angle in degrees
        thickness: Roof thickness in meters
        name: Optional roof name
        rotation: [rx,ry,rz] rotation angles in degrees
        transformation_matrix: Optional 4x4 transformation matrix
        unit_scale: IFC unit scale factor
        verbose: Print debug information
    """
    
    if not polyline or len(polyline) < 3:
        raise ValueError("Polyline must have at least 3 points")
    
    if name is None:
        name = f"Roof_{roof_type}"
    if rotation is None:
        rotation = [0.0, 0.0, 0.0]
        
    roof_type_ifc = ROOF_TYPES.get(roof_type.upper(), "NOTDEFINED")
    
    ifc_file = get_ifc_file()
    container = get_default_container()
    
    if unit_scale is None:
        unit_scale = calculate_unit_scale(ifc_file)
    
    roof = ifcopenshell.api.run(
        "root.create_entity",
        ifc_file,
        ifc_class="IfcRoof",
        name=name,
        predefined_type=roof_type_ifc
    )
    
    ifcopenshell.api.run(
        "spatial.assign_container",
        ifc_file,
        products=[roof],
        relating_structure=container
    )
    
    body_context = get_or_create_body_context(ifc_file)
    
    vertices, faces = generate_roof_geometry(polyline, roof_type, angle, thickness)
    
    roof_representation = ifcopenshell.api.run(
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
        product=roof,
        representation=roof_representation
    )
    
    if transformation_matrix is not None:
        if isinstance(transformation_matrix, list):
            mat = np.array(transformation_matrix)
        else:
            mat = transformation_matrix
    else:
        rotation_x, rotation_y, rotation_z = rotation[:3] if len(rotation) >= 3 else rotation + [0.0] * (3 - len(rotation))
        
        mat = create_transformation_matrix(
            0.0, 0.0, 0.0,
            rotation_x, rotation_y, rotation_z
        )
    
    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        ifc_file,
        product=roof,
        matrix=mat.tolist()
    )
    
    save_and_load_ifc()
    
    if verbose:
        print(f"Created roof '{name}' with type '{roof_type_ifc}', angle: {angle}°, thickness: {thickness}m")
    
    return {
        "success": True,
        "roof_guid": roof.GlobalId,
        "name": name,
        "roof_type": roof_type_ifc,
        "angle": angle,
        "thickness": thickness,
        "vertices_count": len(vertices),
        "faces_count": len(faces)
    }


# @register_command('create_roof_from_walls', description="Create roof from selected walls or wall GUIDs")
# def create_roof_from_walls(
#     wall_guids: Optional[List[str]] = None,
#     use_selection: bool = False,
#     roof_type: str = "HIP_ROOF",
#     angle: float = 30.0,
#     overhang: float = 0.5,
#     thickness: float = 0.3,
#     name: Optional[str] = None,
#     shape_method: str = "AUTO",  # AUTO, BOUNDING_BOX, CONVEX_HULL, EDGE_TRACE
#     verbose: bool = False
# ) -> Dict[str, Any]:
#     """Create roof from walls using outline extraction.
    
#     Args:
#         wall_guids: List of wall GUIDs to use
#         use_selection: Use currently selected walls
#         roof_type: Type of roof to create
#         angle: Roof slope angle in degrees
#         overhang: Roof overhang distance in meters
#         thickness: Roof thickness in meters
#         name: Optional roof name
#         shape_method: Method for extracting wall outline
#         verbose: Print debug information
#     """
    
#     try:
#         result = get_objects_from_guids_or_selection(wall_guids, use_selection, "IfcWall")
#         if not result["success"]:
#             return {
#                 "success": False,
#                 "error": f"Failed to get walls: {'; '.join(result['errors'])}",
#                 "roof_guid": None
#             }
        
#         wall_objects = result["objects"]
#         if not wall_objects:
#             return {
#                 "success": False,
#                 "error": "No valid wall objects found",
#                 "roof_guid": None
#             }
        
#         outline_points = _extract_wall_outline(wall_objects, shape_method, overhang)
#         if not outline_points:
#             return {
#                 "success": False,
#                 "error": "Failed to extract wall outline",
#                 "roof_guid": None
#             }
        
#         return create_roof(
#             polyline=outline_points,
#             roof_type=roof_type,
#             angle=angle,
#             thickness=thickness,
#             name=name or f"Roof_from_walls_{roof_type}",
#             verbose=verbose
#         )
        
#     except Exception as e:
#         return {
#             "success": False,
#             "error": str(e),
#             "roof_guid": None
#         }


@register_command('update_roof', description="Update existing roof properties")
def update_roof(
    roof_guid: str,
    roof_type: Optional[str] = None,
    angle: Optional[float] = None,
    thickness: Optional[float] = None,
    name: Optional[str] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """
    Updates the properties and geometry of a roof element in an IFC file.
    This function allows updating the roof's type, angle, thickness, and name.
    If any geometry-related parameters (roof_type, angle, thickness) are provided,
    the roof's geometry is regenerated and its IFC representation is updated.
    Otherwise, only the metadata (name, type) is updated.
    Args:
        roof_guid (str): The GUID of the roof to update.
        roof_type (Optional[str], optional): The new roof type (e.g., "FLAT", "GABLE").
        angle (Optional[float], optional): The new roof angle in degrees.
        thickness (Optional[float], optional): The new roof thickness.
        name (Optional[str], optional): The new name for the roof.
        verbose (bool, optional): If True, enables verbose logging (currently unused).
    Returns:
        Dict[str, Any]: A dictionary containing the result of the operation.
            On success: {"success": True, "roof_guid": str, "message": str}
            On failure: {"success": False, "error": str}
    Raises:
        Exception: Any exception encountered during the update process is caught and returned in the result.
    """
    try:
        ifc_file = get_ifc_file()
        roof = _get_roof_by_guid(roof_guid, ifc_file)
        if not roof:
            return {"success": False, "error": f"Roof with GUID {roof_guid} not found"}
        
        needs_geometry_update = angle is not None or thickness is not None or roof_type is not None
        
        if needs_geometry_update:
            existing_params = _extract_roof_geometry_params(roof)
            if not existing_params:
                return {"success": False, "error": "Could not extract existing roof geometry parameters"}
            
            new_roof_type = roof_type or existing_params.get("roof_type", "FLAT")
            new_angle = angle if angle is not None else existing_params.get("angle", 30.0)
            new_thickness = thickness if thickness is not None else existing_params.get("thickness", 0.3)
            new_name = name or existing_params.get("name", roof.Name)
            polyline = existing_params.get("polyline")
            
            if not polyline:
                return {"success": False, "error": "Could not extract roof outline from existing geometry"}
            
            body_context = get_or_create_body_context(ifc_file)
            unit_scale = calculate_unit_scale(ifc_file)
            
            for representation in roof.Representation.Representations if roof.Representation else []:
                if representation.ContextOfItems.ContextIdentifier == "Body":
                    ifcopenshell.api.run("geometry.remove_representation", ifc_file, representation=representation)
            
            vertices, faces = generate_roof_geometry(polyline, new_roof_type, new_angle, new_thickness)
            
            roof_representation = ifcopenshell.api.run(
                "geometry.add_mesh_representation",
                ifc_file,
                context=body_context,
                vertices=[vertices],
                faces=[faces],
                unit_scale=unit_scale
            )
            
            ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=roof, representation=roof_representation)
            
            roof_type_ifc = ROOF_TYPES.get(new_roof_type.upper(), new_roof_type.upper())
            roof.PredefinedType = roof_type_ifc
            roof.Name = new_name
        else:
            if name is not None:
                roof.Name = name
            if roof_type is not None:
                roof_type_ifc = ROOF_TYPES.get(roof_type.upper(), roof_type.upper())
                roof.PredefinedType = roof_type_ifc
        
        save_and_load_ifc()
        
        return {
            "success": True,
            "roof_guid": roof_guid,
            "message": "Roof updated successfully"
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('delete_roof', description="Delete roofs by GUID")
def delete_roof(roof_guids: List[str]) -> Dict[str, Any]:
    """Delete roofs by their IFC GUIDs.
    
    Args:
        roof_guids: List of roof GUIDs to delete
    """
    
    try:
        ifc_file = get_ifc_file()
        deleted_count = 0
        errors = []
        
        for roof_guid in roof_guids:
            try:
                roof = _get_roof_by_guid(roof_guid, ifc_file)
                if roof:
                    ifcopenshell.api.run("root.remove_product", ifc_file, product=roof)
                    deleted_count += 1
                else:
                    errors.append(f"Roof {roof_guid} not found")
            except Exception as e:
                errors.append(f"Error deleting roof {roof_guid}: {str(e)}")
        
        save_and_load_ifc()
        
        return {
            "success": deleted_count > 0,
            "deleted_count": deleted_count,
            "errors": errors,
            "message": f"Deleted {deleted_count} roof(s)"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "deleted_count": 0
        }


def _get_roof_by_guid(roof_guid: str, ifc_file=None):
    """Get roof entity by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()
    
    try:
        roof = ifc_file.by_guid(roof_guid)
        if roof and roof.is_a("IfcRoof"):
            return roof
    except:
        pass
    
    return None


def _extract_roof_geometry_params(roof):
    """Extract geometry parameters from existing roof representation."""
    try:
        if not roof.Representation or not roof.Representation.Representations:
            return None
        
        for rep in roof.Representation.Representations:
            if rep.ContextOfItems.ContextIdentifier == "Body":
                if not rep.Items:
                    continue
                
                vertices = []
                for item in rep.Items:
                    if hasattr(item, 'Coordinates') and hasattr(item.Coordinates, 'CoordList'):
                        vertices = [(float(v[0]), float(v[1]), float(v[2])) for v in item.Coordinates.CoordList]
                        break
                    elif hasattr(item, 'Outer') and hasattr(item.Outer, 'Bound'):
                        coords = []
                        for face in item.Outer.CfsFaces:
                            for bound in face.Bounds:
                                if hasattr(bound, 'Bound') and hasattr(bound.Bound, 'Polygon'):
                                    for point in bound.Bound.Polygon:
                                        coord = (float(point.Coordinates[0]), float(point.Coordinates[1]), float(point.Coordinates[2]))
                                        if coord not in coords:
                                            coords.append(coord)
                        vertices = coords
                        break
                
                if not vertices:
                    return None
                
                min_z = min(v[2] for v in vertices)
                base_points = [v for v in vertices if abs(v[2] - min_z) < 0.01]
                
                if len(base_points) < 3:
                    return None
                
                polyline = _sort_points_to_polyline(base_points)
                roof_type = roof.PredefinedType or "FLAT_ROOF"
                max_z = max(v[2] for v in vertices)
                estimated_thickness = 0.3
                estimated_angle = 30.0
                
                if roof_type != "FLAT_ROOF":
                    estimated_angle = _estimate_roof_angle(vertices, polyline)
                
                return {
                    "polyline": polyline,
                    "roof_type": roof_type,
                    "angle": estimated_angle,
                    "thickness": estimated_thickness,
                    "name": roof.Name or "Roof"
                }
        
        return None
    except Exception:
        return None


def _sort_points_to_polyline(points):
    """Sort points to form a proper polyline using nearest neighbor algorithm."""
    if len(points) < 3:
        return points
    
    polyline = [points[0]]
    remaining = points[1:]
    
    while remaining:
        current = polyline[-1]
        nearest_idx = 0
        min_dist = float('inf')
        
        for i, point in enumerate(remaining):
            dist = ((point[0] - current[0])**2 + (point[1] - current[1])**2)**0.5
            if dist < min_dist:
                min_dist = dist
                nearest_idx = i
        
        polyline.append(remaining.pop(nearest_idx))
    
    return polyline


def _estimate_roof_angle(vertices, base_polyline):
    """Estimate roof angle from vertex geometry using rise over run calculation."""
    try:
        base_z = base_polyline[0][2]
        max_z = max(v[2] for v in vertices if v[2] > base_z + 0.01)
        
        if max_z <= base_z:
            return 0.0
        
        min_x = min(p[0] for p in base_polyline)
        max_x = max(p[0] for p in base_polyline)
        min_y = min(p[1] for p in base_polyline)
        max_y = max(p[1] for p in base_polyline)
        
        width = max_x - min_x
        length = max_y - min_y
        height_diff = max_z - base_z
        
        run = min(width, length) * 0.5
        if run > 0:
            angle_rad = math.atan(height_diff / run)
            return math.degrees(angle_rad)
        
        return 30.0
    except:
        return 30.0


def _extract_wall_outline(wall_objects, method="AUTO", overhang=0.0):
    """Extract outline points from wall objects."""
    
    if method == "AUTO":
        for method_name in ["EDGE_TRACE", "CONVEX_HULL", "BOUNDING_BOX"]:
            try:
                outline = _extract_wall_outline(wall_objects, method_name, 0.0)
                if outline and len(outline) >= 3:
                    return _apply_overhang(outline, overhang) if overhang > 0 else outline
            except:
                continue
        return None
    
    elif method == "BOUNDING_BOX":
        return _bounding_box_method(wall_objects, overhang)
    
    elif method == "CONVEX_HULL": 
        return _convex_hull_method(wall_objects, overhang)
    
    elif method == "EDGE_TRACE":
        return _edge_trace_method(wall_objects, overhang)
    
    else:
        return _bounding_box_method(wall_objects, overhang)


def _bounding_box_method(wall_objects, overhang=0.0):
    """Simple bounding box method."""
    try:
        all_points = []
        heights = []
        
        for wall in wall_objects:
            if not wall or wall.type != 'MESH':
                continue
            
            mesh = wall.data
            matrix = wall.matrix_world
            vertices = [matrix @ v.co for v in mesh.vertices]
            
            if vertices:
                all_points.extend([(v.x, v.y) for v in vertices])
                heights.append(max(v.z for v in vertices))
        
        if not all_points or not heights:
            return None
        
        min_x = min(p[0] for p in all_points)
        max_x = max(p[0] for p in all_points)
        min_y = min(p[1] for p in all_points) 
        max_y = max(p[1] for p in all_points)
        avg_z = sum(heights) / len(heights)
        
        outline = [
            [min_x, min_y, avg_z],
            [max_x, min_y, avg_z],
            [max_x, max_y, avg_z],
            [min_x, max_y, avg_z]
        ]
        
        return _apply_overhang(outline, overhang) if overhang > 0 else outline
        
    except Exception:
        return None


def _convex_hull_method(wall_objects, overhang=0.0):
    """Convex hull method."""
    try:
        all_points = []
        heights = []
        
        for wall in wall_objects:
            if not wall or wall.type != 'MESH':
                continue
                
            mesh = wall.data
            matrix = wall.matrix_world
            vertices = [matrix @ v.co for v in mesh.vertices]
            
            if vertices:
                all_points.extend([(v.x, v.y) for v in vertices])
                heights.append(max(v.z for v in vertices))
        
        if not all_points or not heights:
            return None
        
        avg_z = sum(heights) / len(heights)
        hull_2d = _compute_convex_hull_2d(list(set(all_points)))
        outline = [[p[0], p[1], avg_z] for p in hull_2d]
        
        return _apply_overhang(outline, overhang) if overhang > 0 else outline
        
    except Exception:
        return None


def _edge_trace_method(wall_objects, overhang=0.0):
    """Edge tracing method - falls back to convex hull."""
    return _convex_hull_method(wall_objects, overhang)


def _compute_convex_hull_2d(points):
    """Compute 2D convex hull using Graham scan."""
    if len(points) < 3:
        return points
    
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    
    points = sorted(set(points))
    
    lower = []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    
    upper = []
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    
    return lower[:-1] + upper[:-1]


def _apply_overhang(outline, overhang):
    """Apply overhang to outline."""
    if overhang <= 0 or len(outline) < 3:
        return outline
    
    expanded = []
    n = len(outline)
    
    for i in range(n):
        prev_pt = outline[(i - 1) % n]
        curr_pt = outline[i]
        next_pt = outline[(i + 1) % n]
        
        edge_in = [curr_pt[0] - prev_pt[0], curr_pt[1] - prev_pt[1]]
        edge_out = [next_pt[0] - curr_pt[0], next_pt[1] - curr_pt[1]]
        
        len_in = (edge_in[0]**2 + edge_in[1]**2)**0.5
        len_out = (edge_out[0]**2 + edge_out[1]**2)**0.5
        
        if len_in < 0.001 or len_out < 0.001:
            expanded.append(curr_pt)
            continue
            
        edge_in = [edge_in[0] / len_in, edge_in[1] / len_in]
        edge_out = [edge_out[0] / len_out, edge_out[1] / len_out]
        
        normal_in = [-edge_in[1], edge_in[0]]
        normal_out = [-edge_out[1], edge_out[0]]
        
        bisector = [(normal_in[0] + normal_out[0]) / 2, (normal_in[1] + normal_out[1]) / 2]
        bisector_len = (bisector[0]**2 + bisector[1]**2)**0.5
        
        if bisector_len < 0.001:
            expanded.append(curr_pt)
            continue
            
        bisector = [bisector[0] / bisector_len, bisector[1] / bisector_len]
        
        offset_pt = [
            curr_pt[0] + bisector[0] * overhang,
            curr_pt[1] + bisector[1] * overhang,
            curr_pt[2]
        ]
        expanded.append(offset_pt)
    
    return expanded
