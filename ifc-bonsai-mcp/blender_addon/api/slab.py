"""Slab API Functions for IFC Bonsai MCP

Test Examples:
    create_slab(name="Floor Slab", polyline=[(0, 0), (5, 0), (5, 3), (0, 3)], depth=0.2, location=[0.0, 0.0, 0.0])
    create_rectangular_slab(name="Simple Floor", width=5.0, depth=3.0, thickness=0.2, location=[0, 0, 0])
    create_circular_slab(name="Round Slab", radius=3.0, thickness=0.15, location=[0, 0, 0])
    create_l_shaped_slab(corner=(0, 0, 0), width1=4.0, depth1=3.0, width2=2.0, depth2=2.0)
    create_polyline_slab(name="Complex Slab", points=[(0, 0), (8, 0), (8, 5), (4, 5), (4, 2), (0, 2)], thickness=0.25)
    create_sloped_slab(name="Sloped Floor", polyline=[(0, 0), (5, 0), (5, 3), (0, 3)], thickness=0.2, x_slope_degrees=5.0)
    create_foundation_slab(corner=(0, 0, -0.5), width=10.0, depth=8.0)
    update_slab(slab_guid="1AbCdEfGhIjKlMnOp", depth=0.25, polyline=[(0, 0), (6, 0), (6, 4), (0, 4)])
    props = get_slab_properties(slab_guid="1AbCdEfGhIjKlMnOp")
"""

import numpy as np
import ifcopenshell
import ifcopenshell.api
from dataclasses import dataclass
from typing import Optional, List, Dict, Any, Union, Tuple
import math
from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    calculate_unit_scale, degrees_to_radians,
    create_rotation_matrix_x, create_rotation_matrix_y, create_rotation_matrix_z,
    create_transformation_matrix, save_and_load_ifc, 
    create_rectangular_polyline, create_circular_polyline
)
from . import register_command

@dataclass
class SlabDimensions:
    """Slab dimensional properties in meters."""
    depth: float = 0.2  # slab thickness
    width: float = 1.0  # for rectangular slabs
    length: float = 1.0  # for rectangular slabs


@dataclass
class SlabGeometry:
    """Slab geometric properties."""
    direction_sense: str = "POSITIVE"  # POSITIVE or NEGATIVE
    offset: float = 0.0  # base offset
    x_angle: float = 0.0  # slope angle in radians
    clippings: Optional[List] = None
    polyline: Optional[List[Tuple[float, float]]] = None


@register_command('create_slab', description="Create a new slab")
def create_slab(
    name: str = "New Slab",
    polyline: List[Tuple[float, float]] = None,  # 2D points defining slab boundary
    depth: float = 0.2,  # slab thickness (m)
    location: List[float] = None,  # [x, y, z]
    rotation: List[float] = None,  # [rx, ry, rz] in degrees
    geometry_properties: Dict[str, Any] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,  # optional 4x4 matrix
    material: Optional[Any] = None,  # optional material to assign
    slab_type: Optional[Any] = None,  # optional IfcSlabType
    verbose: bool = False,
):
    """Create parametric IfcSlab with specified properties."""
    
    if polyline is None:
        polyline = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]  # default 1x1m rectangle
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
    
    position_x, position_y, position_z = location[:3] if len(location) >= 3 else location + [0.0] * (3 - len(location))
    rotation_x, rotation_y, rotation_z = rotation[:3] if len(rotation) >= 3 else rotation + [0.0] * (3 - len(rotation))
    
    direction_sense = geometry_properties.get("direction_sense", "POSITIVE")
    offset = geometry_properties.get("offset", 0.0)
    x_angle = geometry_properties.get("x_angle", 0.0)
    clippings = geometry_properties.get("clippings", None)
    
    ifc_file = get_ifc_file()
    container = get_default_container()
    unit_scale = calculate_unit_scale(ifc_file)
    
    if slab_type:
        slab = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcSlab",
            name=name,
            relating_type=slab_type
        )
    else:
        slab = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcSlab",
            name=name
        )
    
    ifcopenshell.api.run(
        "spatial.assign_container",
        ifc_file,
        products=[slab],
        relating_structure=container
    )
    
    body_context = get_or_create_body_context(ifc_file)
    
    try:
        slab_rep = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            ifc_file,
            context=body_context,
            depth=depth,
            direction_sense=direction_sense,
            offset=offset,
            x_angle=x_angle,
            clippings=clippings,
            polyline=polyline
        )
        
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=slab,
            representation=slab_rep
        )
        
    except Exception as e:
        if verbose:
            print(f"Slab representation creation failed: {e}")
        raise RuntimeError(f"Failed to create slab representation: {e}")
    
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
        product=slab,
        matrix=mat.tolist()
    )
    
    if material:
        try:
            ifcopenshell.api.run(
                "material.assign_material",
                ifc_file,
                products=[slab],
                material=material
            )
        except Exception as e:
            if verbose:
                print(f"Could not assign material: {e}")
    
    save_and_load_ifc()
    
    return {
        "success": True,
        "slab_guid": slab.GlobalId,
        "name": slab.Name,
        "depth": depth,
        "polyline": polyline,
        "location": location,
        "rotation": rotation,
        "geometry_properties": geometry_properties,
        "message": f"Successfully created slab '{name}'"
    }


@register_command('create_circular_slab', description="Create a circular slab")
def create_circular_slab(
    name: str = "Circular Slab",
    radius: float = 1.0,  # slab radius (m)
    thickness: float = 0.2,  # slab thickness (m)
    location: List[float] = None,  # [x, y, z]
    segments: int = 32,  # number of circular segments
    **kwargs
):
    """Create circular slab with specified radius."""
    if location is None:
        location = [0.0, 0.0, 0.0]
    
    polyline = create_circular_polyline(radius, segments)
    
    result = create_slab(
        name=name,
        polyline=polyline,
        depth=thickness,
        location=location,
        **kwargs
    )
    
    if isinstance(result, dict):
        result["message"] = f"Successfully created circular slab '{name}' with radius {radius}m"
    
    return result


@register_command('create_polyline_slab', description="Create a slab from polyline points")
def create_polyline_slab(
    points: List[Tuple[float, float]],  # 2D points defining slab boundary
    name: str = "Polyline Slab",
    thickness: float = 0.2,  # slab thickness (m)
    location: List[float] = None,  # [x, y, z]
    **kwargs
):
    """Create slab from custom polyline points."""
    if location is None:
        location = [0.0, 0.0, 0.0]
    
    if len(points) < 3:
        raise ValueError("Need at least 3 points for slab creation")
    
    result = create_slab(
        name=name,
        polyline=points,
        depth=thickness,
        location=location,
        **kwargs
    )
    
    if isinstance(result, dict):
        result["message"] = f"Successfully created polyline slab '{name}' with {len(points)} points"
    
    return result


def _get_slab_by_guid(slab_guid: str, ifc_file=None):
    """Resolve an IfcSlab by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()

    slab = None
    if hasattr(ifc_file, "by_guid"):
        try:
            slab = ifc_file.by_guid(slab_guid)
        except Exception:
            slab = None
    
    if slab is None:
        for e in ifc_file.by_type("IfcSlab"):
            if getattr(e, "GlobalId", None) == slab_guid:
                slab = e
                break

    if slab is None:
        raise ValueError(f"Slab with GUID '{slab_guid}' not found")
    return slab


def _extract_slab_properties(slab, ifc_file):
    """Extract current slab properties from IFC entity."""
    properties = {
        "depth": 0.2,
        "direction_sense": "POSITIVE",
        "offset": 0.0,
        "x_angle": 0.0,
        "polyline": None  
    }
    
    if hasattr(slab, "Representation") and slab.Representation:
        for rep in slab.Representation.Representations:
            if rep.RepresentationIdentifier == "Body":
                for item in rep.Items:
                    if item.is_a("IfcExtrudedAreaSolid"):
                        if hasattr(item, "Depth"):
                            properties["depth"] = item.Depth
                        
                        if hasattr(item, "ExtrudedDirection") and item.ExtrudedDirection:
                            direction = item.ExtrudedDirection
                            if hasattr(direction, "DirectionRatios"):
                                z_dir = direction.DirectionRatios[2] if len(direction.DirectionRatios) > 2 else 1.0
                                properties["direction_sense"] = "POSITIVE" if z_dir > 0 else "NEGATIVE"
                        
                        # Extract polyline from SweptArea
                        if hasattr(item, "SweptArea"):
                            swept_area = item.SweptArea
                            polyline_points = []
                            
                            if swept_area.is_a("IfcArbitraryClosedProfileDef"):
                                if hasattr(swept_area, "OuterCurve"):
                                    curve = swept_area.OuterCurve
                                    if curve.is_a("IfcPolyline") and hasattr(curve, "Points"):
                                        for point in curve.Points:
                                            if hasattr(point, "Coordinates") and len(point.Coordinates) >= 2:
                                                polyline_points.append((point.Coordinates[0], point.Coordinates[1]))
                            
                            elif swept_area.is_a("IfcRectangleProfileDef"):
                                if hasattr(swept_area, "XDim") and hasattr(swept_area, "YDim"):
                                    x_dim = swept_area.XDim
                                    y_dim = swept_area.YDim
                                    polyline_points = [
                                        (-x_dim/2, -y_dim/2),
                                        (x_dim/2, -y_dim/2),
                                        (x_dim/2, y_dim/2),
                                        (-x_dim/2, y_dim/2)
                                    ]
                            
                            elif hasattr(swept_area, "OuterBoundary"):
                                boundary = swept_area.OuterBoundary
                                if boundary.is_a("IfcCompositeCurve") and hasattr(boundary, "Segments"):
                                    for segment in boundary.Segments:
                                        if hasattr(segment, "ParentCurve"):
                                            parent_curve = segment.ParentCurve
                                            if parent_curve.is_a("IfcPolyline") and hasattr(parent_curve, "Points"):
                                                for point in parent_curve.Points:
                                                    if hasattr(point, "Coordinates") and len(point.Coordinates) >= 2:
                                                        polyline_points.append((point.Coordinates[0], point.Coordinates[1]))
                            
                            if polyline_points:
                                properties["polyline"] = polyline_points
                        
                        if hasattr(item, "Position"):
                            position = item.Position
                            if hasattr(position, "Location") and hasattr(position.Location, "Coordinates"):
                                coords = position.Location.Coordinates
                                if len(coords) > 2:
                                    properties["offset"] = coords[2]  # Z-coordinate as offset
    
    return properties


def _try_update_existing_representation_depth(slab, new_depth, ifc_file, verbose=False):
    """
    Attempt to update the depth of an existing slab representation without recreating it.
    Returns True if successful, False otherwise.
    """
    try:
        if not (hasattr(slab, "Representation") and slab.Representation):
            return False
            
        for rep in slab.Representation.Representations:
            if rep.RepresentationIdentifier == "Body":
                for item in rep.Items:
                    if item.is_a("IfcExtrudedAreaSolid") and hasattr(item, "Depth"):
                        old_depth = item.Depth
                        item.Depth = new_depth
                        
                        if verbose:
                            print(f"Updated depth directly from {old_depth} to {new_depth}")
                        return True
        return False
        
    except Exception as e:
        if verbose:
            print(f"Failed to update existing representation depth: {e}")
        return False


@register_command('update_slab', description="Update an existing slab")
def update_slab(
    slab_guid: str,  # IFC GlobalId of slab to update
    *,
    depth: float = None,  # new thickness
    polyline: List[Tuple[float, float]] = None,  # new polyline points
    geometry_properties: Dict[str, Any] = None,  # geometric properties to update
    verbose: bool = False,
):
    """Update an existing slab using its IFC GUID."""
    ifc_file = get_ifc_file()
    slab = _get_slab_by_guid(slab_guid, ifc_file)
    body_context = get_or_create_body_context(ifc_file)
    
    current_props = _extract_slab_properties(slab, ifc_file)
    
    new_depth = depth if depth is not None else current_props["depth"]
    
    if polyline is not None:
        new_polyline = polyline
    elif current_props["polyline"] is not None and len(current_props["polyline"]) > 0:
        new_polyline = current_props["polyline"]
    else:
        if verbose:
            print(f"Warning: Could not extract original polyline from slab {slab_guid}. "
                  "Attempting to preserve geometry by modifying existing representation.")
        
        if _try_update_existing_representation_depth(slab, new_depth, ifc_file, verbose):
            save_and_load_ifc()
            return {
                "success": True,
                "slab_guid": slab.GlobalId,
                "name": slab.Name,
                "updated_properties": {
                    "depth": new_depth,
                    "polyline": "preserved (modified existing representation)",
                    "direction_sense": current_props["direction_sense"],
                    "offset": current_props["offset"],
                    "x_angle": current_props["x_angle"]
                },
                "message": f"Successfully updated slab depth for '{slab.Name}' ({slab.GlobalId})"
            }
        else:
            if verbose:
                print("Could not modify existing representation. Using default polyline.")
            new_polyline = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]  # default 1x1m rectangle
    
    new_direction_sense = geometry_properties.get("direction_sense", current_props["direction_sense"]) if geometry_properties else current_props["direction_sense"]
    new_offset = geometry_properties.get("offset", current_props["offset"]) if geometry_properties else current_props["offset"]
    new_x_angle = geometry_properties.get("x_angle", current_props["x_angle"]) if geometry_properties else current_props["x_angle"]
    new_clippings = geometry_properties.get("clippings", None) if geometry_properties else None
    
    new_rep = ifcopenshell.api.run(
        "geometry.add_slab_representation",
        ifc_file,
        context=body_context,
        depth=new_depth,
        direction_sense=new_direction_sense,
        offset=new_offset,
        x_angle=new_x_angle,
        clippings=new_clippings,
        polyline=new_polyline
    )
    
    old_rep = None
    if slab.Representation and slab.Representation.Representations:
        for rep in slab.Representation.Representations:
            if rep.RepresentationIdentifier == "Body":
                old_rep = rep
                break
    
    ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=slab, representation=new_rep)
    if old_rep:
        ifcopenshell.api.run("geometry.unassign_representation", ifc_file, product=slab, representation=old_rep)
        ifcopenshell.api.run("geometry.remove_representation", ifc_file, representation=old_rep)
    
    save_and_load_ifc()
    
    if verbose:
        polyline_count = len(new_polyline) if isinstance(new_polyline, list) else "preserved"
        print(f"Updated slab {slab.GlobalId} -> depth: {new_depth}, polyline points: {polyline_count}")
    
    return {
        "success": True,
        "slab_guid": slab.GlobalId,
        "name": slab.Name,
        "updated_properties": {
            "depth": new_depth,
            "polyline": new_polyline if isinstance(new_polyline, list) else "preserved",
            "direction_sense": new_direction_sense,
            "offset": new_offset,
            "x_angle": new_x_angle
        },
        "message": f"Successfully updated slab '{slab.Name}' ({slab.GlobalId})"
    }


@register_command('get_slab_properties', description="Get properties of an existing slab")
def get_slab_properties(slab_guid: str) -> Dict[str, Any]:
    """Get properties of an existing slab by IFC GUID."""
    ifc_file = get_ifc_file()
    slab = _get_slab_by_guid(slab_guid, ifc_file)
    
    properties = _extract_slab_properties(slab, ifc_file)
    properties.update({
        "name": slab.Name,
        "guid": slab.GlobalId,
        "predefined_type": getattr(slab, "PredefinedType", None)
    })
    
    if properties["polyline"] is None:
        properties["polyline"] = "Could not extract polyline from representation"
    
    return properties
