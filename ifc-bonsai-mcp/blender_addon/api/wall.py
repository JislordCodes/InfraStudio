"""Wall API Functions for IFC Bonsai MCP

Test Examples:
    create_wall(name="Exterior Wall", dimensions={"length": 5.0, "height": 3.0, "thickness": 0.3}, location=[0.0, 0.0, 0.0])
    create_wall(name="Interior Wall", dimensions={"length": 3.0, "height": 2.8, "thickness": 0.15}, location=[2.0, 3.0, 0.0], rotation=[0, 0, 90])
    create_simple_wall(name="Simple Wall", length=4.0, height=3.0, thickness=0.25, x=1.0, y=1.0, z=0.0, angle=45)
    create_two_point_wall(start_point=(0, 0, 0), end_point=(5, 0, 0), thickness=0.25, height=3.0)
    create_polyline_walls(points=[(0, 0, 0), (5, 0, 0), (5, 3, 0)], thickness=0.2, height=2.8, closed=False)
    create_polyline_walls(points=[(0, 0, 0), (5, 0, 0), (5, 3, 0), (0, 3, 0)], thickness=0.2, height=2.8, closed=True)
    create_rectangular_room(corner=(0, 0, 0), width=6.0, depth=4.0, height=3.0, thickness=0.2)
    create_l_shaped_walls(corner=(0, 0, 0), width1=3.0, depth1=2.0, width2=2.0, depth2=3.0)
    create_exterior_wall(start_point=(0, 0, 0), end_point=(5, 0, 0))
    create_interior_wall(start_point=(0, 0, 0), end_point=(3, 0, 0))
    update_wall(wall_guid="1AbCdEfGhIjKlMnOp", dimensions={"length": 6.0, "height": 3.5})
    props = get_wall_properties(wall_guid="1AbCdEfGhIjKlMnOp")
"""

import numpy as np
import ifcopenshell
import ifcopenshell.api
import math
from dataclasses import dataclass
from typing import Optional, List, Dict, Any, Union, Tuple
from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    get_or_create_axis_context, calculate_unit_scale, degrees_to_radians,
    create_rotation_matrix_x, create_rotation_matrix_y, create_rotation_matrix_z,
    create_transformation_matrix, save_and_load_ifc, calculate_two_point_parameters
)
from . import register_command

@dataclass
class WallDimensions:
    """Wall dimensional properties in meters."""
    length: float = 1.0
    height: float = 3.0
    thickness: float = 0.2


@dataclass
class WallGeometry:
    """Wall geometric properties."""
    direction_sense: str = "POSITIVE"  # POSITIVE or NEGATIVE
    offset: float = 0.0  # base offset
    x_angle: float = 0.0  # slope angle in radians
    clippings: Optional[List] = None
    booleans: Optional[List] = None


@register_command('create_wall', description="Create a new wall")
def create_wall(
    name: str = "New Wall",
    dimensions: Optional[Dict[str, float]] = None,
    location: Optional[List[float]] = None,
    rotation: Optional[List[float]] = None,
    geometry_properties: Optional[Dict[str, Any]] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    material: Optional[Any] = None,
    wall_type: Optional[Any] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create parametric IfcWall with specified properties."""
    
    if dimensions is None:
        dimensions = {"length": 1.0, "height": 3.0, "thickness": 0.2}
    if location is None:
        location = [0.0, 0.0, 0.0]
    if rotation is None:
        rotation = [0.0, 0.0, 0.0]
    if geometry_properties is None:
        geometry_properties = {
            "direction_sense": "POSITIVE",
            "offset": 0.0,
            "x_angle": 0.0
        }

    length = float(dimensions.get("length", 1.0))
    height = float(dimensions.get("height", 3.0))
    thickness = float(dimensions.get("thickness", 0.2))

    if length <= 0 or height <= 0 or thickness <= 0:
        raise ValueError("Wall dimensions must be positive values")
    
    position_x, position_y, position_z = location[:3] if len(location) >= 3 else location + [0.0] * (3 - len(location))
    rotation_x, rotation_y, rotation_z = rotation[:3] if len(rotation) >= 3 else rotation + [0.0] * (3 - len(rotation))
    
    direction_sense = geometry_properties.get("direction_sense", "POSITIVE")
    offset = geometry_properties.get("offset", 0.0)
    x_angle = geometry_properties.get("x_angle", 0.0)
    clippings = geometry_properties.get("clippings", None)
    booleans = geometry_properties.get("booleans", None)
    
    ifc_file = get_ifc_file()
    container = get_default_container()
    unit_scale = calculate_unit_scale(ifc_file)
    
    if wall_type:
        wall = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcWall",
            name=name,
            relating_type=wall_type
        )
    else:
        wall = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcWall",
            name=name
        )
    
    ifcopenshell.api.run(
        "spatial.assign_container",
        ifc_file,
        products=[wall],
        relating_structure=container
    )
    
    body_context = get_or_create_body_context(ifc_file)
    axis_context = get_or_create_axis_context(ifc_file)
    try:
        wall_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            ifc_file,
            context=body_context,
            length=length,
            height=height,
            direction_sense=direction_sense,
            offset=offset,
            thickness=thickness,
            x_angle=x_angle,
            clippings=clippings,
            booleans=booleans
        )
        
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=wall,
            representation=wall_rep
        )
        
    except Exception as e:
        if verbose:
            print(f"Wall representation creation failed: {e}")
        raise RuntimeError(f"Failed to create wall representation: {e}")
    
    try:
        axis_rep = ifcopenshell.api.run(
            "geometry.add_axis_representation",
            ifc_file,
            context=axis_context,
            axis=[(0.0, 0.0), (length, 0.0)]
        )
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=wall,
            representation=axis_rep
        )
    except Exception as e:
        if verbose:
            print(f"Could not add axis representation: {e}")
    
    if transformation_matrix is not None:
        if isinstance(transformation_matrix, list):
            mat = np.array(transformation_matrix, dtype=float)
        else:
            mat = transformation_matrix.astype(float)
        
        if mat.shape != (4, 4):
            raise ValueError("Transformation matrix must be 4x4")
    else:
        mat = create_transformation_matrix(
            position_x=position_x,
            position_y=position_y,
            position_z=position_z,
            rotation_x=rotation_x,
            rotation_y=rotation_y,
            rotation_z=rotation_z
        )
    
    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        ifc_file,
        product=wall,
        matrix=mat.tolist()
    )
    
    if material:
        try:
            ifcopenshell.api.run(
                "material.assign_material",
                ifc_file,
                products=[wall],
                material=material
            )
        except Exception as e:
            if verbose:
                print(f"Could not assign material: {e}")
    
    save_and_load_ifc()
    
    return {
        "success": True,
        "wall_guid": wall.GlobalId,
        "name": wall.Name,
        "dimensions": {
            "length": length,
            "height": height,
            "thickness": thickness
        },
        "location": location,
        "rotation": rotation,
        "geometry_properties": geometry_properties,
        "message": f"Successfully created wall '{name}'"
    }


@register_command('create_two_point_wall', description="Create a wall between two points")
def create_two_point_wall(
    start_point: Tuple[float, float, float],  # (x, y, z) start
    end_point: Tuple[float, float, float],  # (x, y, z) end
    name: str = "Two Point Wall",
    thickness: float = 0.2,  # wall thickness (m)
    height: float = 3.0,  # wall height (m)
    **kwargs
):
    """Create wall between two 3D points."""
    params = calculate_two_point_parameters(start_point, end_point)
    
    wall = create_wall(
        name=name,
        dimensions={
            "length": params["length"],
            "height": height,
            "thickness": thickness
        },
        location=list(start_point),
        rotation=[0, 0, params["angle"]],
        **kwargs
    )
    
    return {
        "success": True,
        "wall_guid": wall["wall_guid"],
        "name": wall["name"],
        "dimensions": {
            "length": params["length"],
            "height": height,
            "thickness": thickness
        },
        "location": list(start_point),
        "rotation": [0, 0, params["angle"]],
        "message": f"Successfully created wall '{name}' from {start_point} to {end_point}"
    }


@register_command('create_polyline_walls', description="Create connected walls along a polyline path")
def create_polyline_walls(
    points: List[Tuple[float, float, float]],  # list of (x, y, z) coordinates
    name_prefix: str = "Wall",
    thickness: float = 0.2,  # wall thickness (m)
    height: float = 3.0,  # wall height (m)
    closed: bool = False,  # close the loop
    **kwargs
) -> Dict[str, Any]:
    """Create connected walls along a polyline path."""
    if len(points) < 2:
        raise ValueError("Need at least 2 points for wall creation")
    
    walls_created = []
    
    if closed and points[0] != points[-1]:
        points = list(points) + [points[0]]
    
    for i in range(len(points) - 1):
        wall_name = f"{name_prefix}_{i+1:03d}"
        
        wall_result = create_two_point_wall(
            start_point=points[i],
            end_point=points[i + 1],
            name=wall_name,
            thickness=thickness,
            height=height,
            **kwargs
        )
        walls_created.append(wall_result)
    
    return {
        "success": True,
        "walls_created": len(walls_created),
        "walls": walls_created,
        "message": f"Successfully created {len(walls_created)} walls from polyline"
    }


def _get_wall_by_guid(wall_guid: str, ifc_file=None):
    """Resolve an IfcWall by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()

    wall = None
    if hasattr(ifc_file, "by_guid"):
        try:
            wall = ifc_file.by_guid(wall_guid)
        except Exception:
            wall = None
    
    if wall is None:
        for e in ifc_file.by_type("IfcWall"):
            if getattr(e, "GlobalId", None) == wall_guid:
                wall = e
                break

    if wall is None:
        raise ValueError(f"Wall with GUID '{wall_guid}' not found")
    return wall


def _extract_wall_properties(wall, ifc_file):
    """Extract current wall properties from IFC entity."""
    properties = {
        "length": 1.0,
        "height": 3.0,
        "thickness": 0.2,
        "direction_sense": "POSITIVE",
        "offset": 0.0,
        "x_angle": 0.0
    }
    
    if hasattr(wall, "Representation") and wall.Representation:
        for rep in wall.Representation.Representations:
            if rep.RepresentationIdentifier == "Body":
                for item in rep.Items:
                    if hasattr(item, "SweptArea"):
                        if hasattr(item.SweptArea, "XDim"):
                            properties["thickness"] = item.SweptArea.XDim
                        if hasattr(item.SweptArea, "YDim"):
                            properties["height"] = item.SweptArea.YDim
            elif rep.RepresentationIdentifier == "Axis":
                for item in rep.Items:
                    if item.is_a("IfcPolyline") and len(item.Points) >= 2:
                        p1 = item.Points[0].Coordinates
                        p2 = item.Points[-1].Coordinates
                        properties["length"] = math.sqrt(
                            (p2[0] - p1[0])**2 + (p2[1] - p1[1])**2
                        )
    
    return properties


@register_command('update_wall', description="Update an existing wall")
def update_wall(
    wall_guid: str,  # IFC GlobalId of wall to update
    *,
    dimensions: Dict[str, float] = None,  # length, height, thickness to update
    geometry_properties: Dict[str, Any] = None,  # geometric properties to update
    verbose: bool = False,
):
    """Update an existing wall using its IFC GUID."""
    ifc_file = get_ifc_file()
    wall = _get_wall_by_guid(wall_guid, ifc_file)
    body_context = get_or_create_body_context(ifc_file)
    
    current_props = _extract_wall_properties(wall, ifc_file)
    
    if dimensions:
        new_length = dimensions.get("length", current_props["length"])
        new_height = dimensions.get("height", current_props["height"])
        new_thickness = dimensions.get("thickness", current_props["thickness"])
    else:
        new_length = current_props["length"]
        new_height = current_props["height"]
        new_thickness = current_props["thickness"]

    if geometry_properties:
        new_direction_sense = geometry_properties.get("direction_sense", current_props["direction_sense"])
        new_offset = geometry_properties.get("offset", current_props["offset"])
        new_x_angle = geometry_properties.get("x_angle", current_props["x_angle"])
        new_clippings = geometry_properties.get("clippings", None)
        new_booleans = geometry_properties.get("booleans", None)
    else:
        new_direction_sense = current_props["direction_sense"]
        new_offset = current_props["offset"]
        new_x_angle = current_props["x_angle"]
        new_clippings = None
        new_booleans = None
    
    new_rep = ifcopenshell.api.run(
        "geometry.add_wall_representation",
        ifc_file,
        context=body_context,
        length=new_length,
        height=new_height,
        direction_sense=new_direction_sense,
        offset=new_offset,
        thickness=new_thickness,
        x_angle=new_x_angle,
        clippings=new_clippings,
        booleans=new_booleans
    )
    
    old_rep = None
    if wall.Representation and wall.Representation.Representations:
        for rep in wall.Representation.Representations:
            if rep.RepresentationIdentifier == "Body":
                old_rep = rep
                break
    
    ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=wall, representation=new_rep)
    if old_rep:
        ifcopenshell.api.run("geometry.unassign_representation", ifc_file, product=wall, representation=old_rep)
        ifcopenshell.api.run("geometry.remove_representation", ifc_file, representation=old_rep)
    
    save_and_load_ifc()
    
    if verbose:
        print(f"Updated wall {wall.GlobalId} -> {new_length} x {new_height} x {new_thickness}")
    
    return {
        "success": True,
        "wall_guid": wall.GlobalId,
        "name": wall.Name,
        "updated_dimensions": {
            "length": new_length,
            "height": new_height,
            "thickness": new_thickness
        },
        "geometry_properties": {
            "direction_sense": new_direction_sense,
            "offset": new_offset,
            "x_angle": new_x_angle
        },
        "message": f"Successfully updated wall '{wall.Name}' ({wall.GlobalId})"
    }


@register_command('get_wall_properties', description="Get properties of an existing wall")
def get_wall_properties(wall_guid: str) -> Dict[str, Any]:
    """Get properties of an existing wall by IFC GUID."""
    ifc_file = get_ifc_file()
    wall = _get_wall_by_guid(wall_guid, ifc_file)
    
    properties = _extract_wall_properties(wall, ifc_file)
    properties.update({
        "name": wall.Name,
        "guid": wall.GlobalId,
        "predefined_type": getattr(wall, "PredefinedType", None)
    })
    
    return properties
