"""Door API Functions for IFC Bonsai MCP

Test Examples:
    create_door(name="Main Entrance Door", dimensions={"width": 0.9, "height": 2.0}, location=[0.0, 0.0, 0.0])
    create_door(name="Double Door", operation_type="DOUBLE_DOOR_SINGLE_SWING", dimensions={"width": 1.8, "height": 2.1}, location=[2.0, 0.0, 0.0])
    create_door(name="Custom Door", dimensions={"width": 1.0, "height": 2.0}, frame_properties={"lining_depth": 0.06, "lining_thickness": 0.06}, panel_properties={"frame_thickness": 0.04}, location=[4.0, 0.0, 0.0], rotation=[0, 0, 45])
    create_simple_door(name="Simple Door", width=0.8, height=2.0, x=1.0, y=1.0, z=0.0, angle=90)
    create_left_swing_door(name="Left Swing", width=0.9, height=2.0, x=0, y=0, z=0)
    create_right_swing_door(name="Right Swing", width=0.9, height=2.0, x=2, y=0, z=0)
    create_double_swing_door(name="Double Swing", width=1.2, height=2.0, x=4, y=0, z=0)
    create_sliding_door(name="Sliding Door", width=1.5, height=2.0, direction="LEFT", x=6, y=0, z=0)
    create_wall_aligned_door(name="Wall Door", width=0.9, height=2.0, position_x=0, position_y=0, position_z=0, wall_angle=45)
    update_door(door_guid="1AbCdEfGhIjKlMnOp", dimensions={"width": 1.0, "height": 2.1})
    props = get_door_properties(door_guid="1AbCdEfGhIjKlMnOp")
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
    create_transformation_matrix, save_and_load_ifc, create_wall_aligned_matrix
)
from . import register_command


DOOR_OPERATION_TYPES = {
    "SINGLE_SWING_LEFT": "SINGLE_SWING_LEFT",
    "SINGLE_SWING_RIGHT": "SINGLE_SWING_RIGHT", 
    "DOUBLE_SWING_LEFT": "DOUBLE_SWING_LEFT",
    "DOUBLE_SWING_RIGHT": "DOUBLE_SWING_RIGHT",
    "DOUBLE_DOOR_SINGLE_SWING": "DOUBLE_DOOR_SINGLE_SWING",
    "DOUBLE_DOOR_DOUBLE_SWING": "DOUBLE_DOOR_DOUBLE_SWING",
    "SLIDING_TO_LEFT": "SLIDING_TO_LEFT",
    "SLIDING_TO_RIGHT": "SLIDING_TO_RIGHT",
    "DOUBLE_DOOR_SLIDING": "DOUBLE_DOOR_SLIDING",
}


@dataclass
class DoorLiningProperties:
    """Door frame/lining properties (meters)."""
    LiningDepth: Optional[float] = 0.05
    LiningThickness: Optional[float] = 0.05
    LiningOffset: Optional[float] = 0.0
    LiningToPanelOffsetX: Optional[float] = 0.025
    LiningToPanelOffsetY: Optional[float] = 0.025
    TransomThickness: Optional[float] = 0.0
    TransomOffset: Optional[float] = 1.525
    CasingDepth: Optional[float] = 0.005
    CasingThickness: Optional[float] = 0.075
    ThresholdDepth: Optional[float] = 0.1
    ThresholdThickness: Optional[float] = 0.025
    ThresholdOffset: Optional[float] = 0.0
    ShapeAspectStyle: Optional[Any] = None


@dataclass
class DoorPanelProperties:
    """Door panel properties (meters)."""
    PanelDepth: Optional[float] = 0.035
    PanelWidth: Optional[float] = 1.0
    FrameDepth: Optional[float] = 0.035
    FrameThickness: Optional[float] = 0.035
    PanelOperation: Optional[str] = None
    PanelPosition: Optional[str] = None
    ShapeAspectStyle: Optional[Any] = None


def create_default_lining_properties(**overrides) -> Dict[str, Any]:
    """Create default door lining properties."""
    defaults = {
        "lining_depth": 0.05,
        "lining_thickness": 0.05,
        "lining_offset": 0.0,
        "lining_to_panel_offset_x": 0.025,
        "lining_to_panel_offset_y": 0.025,
        "transom_thickness": 0.0,
        "transom_offset": 1.525,
        "casing_depth": 0.005,
        "casing_thickness": 0.075,
        "threshold_depth": 0.1,
        "threshold_thickness": 0.025,
        "threshold_offset": 0.0
    }
    defaults.update(overrides)
    return defaults


def create_default_panel_properties(**overrides) -> Dict[str, Any]:
    """Create default door panel properties."""
    defaults = {
        "panel_depth": 0.035,
        "panel_width": 1.0,
        "frame_depth": 0.035,
        "frame_thickness": 0.035
    }
    defaults.update(overrides)
    return defaults



@register_command('get_door_operation_types', description="Get all supported door operation types")
def get_door_operation_types() -> Dict[str, Any]:
    """Get all door operation types with descriptions."""
    return {
        "success": True,
        "operation_types": DOOR_OPERATION_TYPES,
        "message": f"Found {len(DOOR_OPERATION_TYPES)} operation types"
    }


@register_command('create_door', description="Create a new door")
def create_door(
    name: str = "New Door",
    dimensions: Optional[Dict[str, float]] = None,
    operation_type: str = "SINGLE_SWING_LEFT",
    location: Optional[List[float]] = None,
    rotation: Optional[List[float]] = None,
    frame_properties: Optional[Dict[str, float]] = None,
    panel_properties: Optional[Dict[str, float]] = None,
    custom_lining: Optional[Dict[str, Any]] = None,
    custom_panels: Optional[Dict[str, Any]] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    unit_scale: Optional[float] = None,
    part_of_product: Optional[Any] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Create parametric IfcDoor with specified properties."""
    
    if dimensions is None:
        dimensions = {"width": 0.9, "height": 2.0}
    if location is None:
        location = [0.0, 0.0, 0.0]
    if rotation is None:
        rotation = [0.0, 0.0, 0.0]
    if frame_properties is None:
        frame_properties = {}
    if panel_properties is None:
        panel_properties = {}
    
    overall_width = float(dimensions.get("width", 0.9))
    overall_height = float(dimensions.get("height", 2.0))

    if overall_width <= 0 or overall_height <= 0:
        raise ValueError("Door dimensions must be positive values")
    
    position_x, position_y, position_z = location[:3] if len(location) >= 3 else location + [0.0] * (3 - len(location))
    rotation_x, rotation_y, rotation_z = rotation[:3] if len(rotation) >= 3 else rotation + [0.0] * (3 - len(rotation))
    
    if operation_type not in DOOR_OPERATION_TYPES:
        raise ValueError(f"Invalid operation_type: {operation_type}. Must be one of {list(DOOR_OPERATION_TYPES.keys())}")
    
    ifc_file = get_ifc_file()
    container = get_default_container()
    
    if unit_scale is None:
        unit_scale = calculate_unit_scale(ifc_file)
    
    door = ifcopenshell.api.run(
        "root.create_entity",
        ifc_file,
        ifc_class="IfcDoor",
        name=name,
        predefined_type="DOOR"
    )
    
    ifcopenshell.api.run(
        "spatial.assign_container",
        ifc_file,
        products=[door],
        relating_structure=container
    )
    
    body_context = get_or_create_body_context(ifc_file)
    
    lining_props = create_default_lining_properties()
    lining_props.update(frame_properties)
    
    if custom_lining:
        lining_dict = custom_lining
    else:
        lining_dict = {
            "LiningDepth": lining_props.get("lining_depth", 0.05),
            "LiningThickness": lining_props.get("lining_thickness", 0.05), 
            "LiningOffset": lining_props.get("lining_offset", 0.0),
            "LiningToPanelOffsetX": lining_props.get("lining_to_panel_offset_x", 0.025),
            "LiningToPanelOffsetY": lining_props.get("lining_to_panel_offset_y", 0.025),
            "TransomThickness": lining_props.get("transom_thickness", 0.0),
            "TransomOffset": lining_props.get("transom_offset", 1.525),
            "CasingDepth": lining_props.get("casing_depth", 0.005),
            "CasingThickness": lining_props.get("casing_thickness", 0.075),
            "ThresholdDepth": lining_props.get("threshold_depth", 0.1),
            "ThresholdThickness": lining_props.get("threshold_thickness", 0.025),
            "ThresholdOffset": lining_props.get("threshold_offset", 0.0)
        }
    
    panel_props = create_default_panel_properties()
    panel_props.update(panel_properties)
    
    if custom_panels:
        panel_dict = custom_panels
    else:
        panel_dict = {
            "PanelDepth": panel_props.get("panel_depth", 0.035),
            "PanelWidth": panel_props.get("panel_width", 1.0),
            "FrameDepth": panel_props.get("frame_depth", 0.035),
            "FrameThickness": panel_props.get("frame_thickness", 0.035)
        }
    
    try:
        door_rep = ifcopenshell.api.run(
            "geometry.add_door_representation",
            ifc_file,
            context=body_context,
            overall_width=overall_width,
            overall_height=overall_height,
            operation_type=operation_type,
            lining_properties=lining_dict,
            panel_properties=panel_dict,
            unit_scale=unit_scale,
            part_of_product=part_of_product
        )
    except Exception as e:
        if verbose:
            print(f"Warning: Could not create door representation: {e}")
        door_rep = None
    
    if door_rep:
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=door,
            representation=door_rep
        )
    
    if transformation_matrix is not None:
        if isinstance(transformation_matrix, list):
            mat = np.array(transformation_matrix)
        else:
            mat = transformation_matrix
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
        product=door,
        matrix=mat.tolist()
    )
    
    save_and_load_ifc()
    
    if verbose:
        print(f"Created door '{name}' with dimensions {overall_width}x{overall_height}m at {location}")
    
    return {
        "success": True,
        "door_guid": door.GlobalId,
        "name": door.Name,
        "dimensions": {
            "width": overall_width,
            "height": overall_height
        },
        "operation_type": operation_type,
        "location": location,
        "rotation": rotation,
        "message": f"Successfully created door '{name}'"
    }


def _get_door_by_guid(door_guid: str, ifc_file=None):
    """Resolve an IfcDoor by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()

    door = None
    if hasattr(ifc_file, "by_guid"):
        try:
            door = ifc_file.by_guid(door_guid)
        except:
            pass
    
    if door is None:
        # Fallback search
        for entity in ifc_file.by_type("IfcDoor"):
            if entity.GlobalId == door_guid:
                door = entity
                break

    if door is None:
        raise ValueError(f"Door with GUID {door_guid} not found")
    return door


def _extract_door_properties(door, ifc_file):
    """Extract current door properties from IFC entity."""
    properties = {
        "width": getattr(door, "OverallWidth", 0.9),
        "height": getattr(door, "OverallHeight", 2.0),
        "operation_type": "SINGLE_SWING_LEFT",
        "lining_props": {},
        "panel_props": {}
    }
    
    if hasattr(door, "OperationType"):
        properties["operation_type"] = door.OperationType or "SINGLE_SWING_LEFT"
    
    for rel in getattr(door, "IsDefinedBy", []):
        if hasattr(rel, "RelatingPropertyDefinition"):
            pset = rel.RelatingPropertyDefinition
            if hasattr(pset, "HasProperties"):
                for prop in pset.HasProperties:
                    if hasattr(prop, "Name") and hasattr(prop, "NominalValue"):
                        prop_name = prop.Name
                        prop_value = prop.NominalValue.wrappedValue if prop.NominalValue else None
                        
                        if "Lining" in prop_name or "Frame" in prop_name:
                            properties["lining_props"][prop_name] = prop_value
                        elif "Panel" in prop_name:
                            properties["panel_props"][prop_name] = prop_value
    
    return properties


@register_command('update_door', description="Update an existing door")
def update_door(
    door_guid: str,  # IFC GlobalId of door to update
    *,
    dimensions: Dict[str, float] = None,  # {"width": m, "height": m}
    operation_type: str = None,  # new door operation type
    frame_properties: Dict[str, float] = None,  # frame properties to update
    panel_properties: Dict[str, float] = None,  # panel properties to update
    custom_lining: Dict[str, Any] = None,  # custom lining properties dict
    custom_panels: Dict[str, Any] = None,  # custom panel properties dict
    part_of_product: Any = None,  # parent product
    verbose: bool = False,  # print debug info
):
    """Update an existing door using its IFC GUID."""
    ifc_file = get_ifc_file()
    door = _get_door_by_guid(door_guid, ifc_file)
    body_context = get_or_create_body_context(ifc_file)
    unit_scale = calculate_unit_scale(ifc_file)

    current_props = _extract_door_properties(door, ifc_file)
    
    new_width = dimensions.get("width", current_props["width"]) if dimensions else current_props["width"]
    new_height = dimensions.get("height", current_props["height"]) if dimensions else current_props["height"]
    
    new_operation = operation_type or current_props["operation_type"]

    lining_dict = current_props["lining_props"].copy()
    if frame_properties:
        lining_props = create_default_lining_properties()
        lining_props.update(frame_properties)
        
        lining_dict.update({
            "LiningDepth": lining_props.get("lining_depth", lining_dict.get("LiningDepth", 0.05)),
            "LiningThickness": lining_props.get("lining_thickness", lining_dict.get("LiningThickness", 0.05)),
            "LiningOffset": lining_props.get("lining_offset", lining_dict.get("LiningOffset", 0.0)),
            "LiningToPanelOffsetX": lining_props.get("lining_to_panel_offset_x", lining_dict.get("LiningToPanelOffsetX", 0.025)),
            "LiningToPanelOffsetY": lining_props.get("lining_to_panel_offset_y", lining_dict.get("LiningToPanelOffsetY", 0.025)),
        })
    
    if custom_lining:
        lining_dict.update(custom_lining)

    panel_dict = current_props["panel_props"].copy()
    if panel_properties:
        panel_props = create_default_panel_properties()
        panel_props.update(panel_properties)
        
        panel_dict.update({
            "PanelDepth": panel_props.get("panel_depth", panel_dict.get("PanelDepth", 0.035)),
            "PanelWidth": panel_props.get("panel_width", panel_dict.get("PanelWidth", 1.0)),
            "FrameDepth": panel_props.get("frame_depth", panel_dict.get("FrameDepth", 0.035)),
            "FrameThickness": panel_props.get("frame_thickness", panel_dict.get("FrameThickness", 0.035)),
        })
    
    if custom_panels:
        panel_dict.update(custom_panels)

    try:
        new_rep = ifcopenshell.api.run(
            "geometry.add_door_representation",
            ifc_file,
            context=body_context,
            overall_width=new_width,
            overall_height=new_height,
            operation_type=new_operation,
            lining_properties=lining_dict or None,
            panel_properties=panel_dict or None,
            unit_scale=unit_scale,
            part_of_product=part_of_product,
        )
    except Exception as e:
        if verbose:
            print(f"Warning: Could not create updated door representation: {e}")
        new_rep = None

    if new_rep:
        old_rep = None
        if door.Representation and door.Representation.Representations:
            old_rep = door.Representation.Representations[0]

        ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=door, representation=new_rep)
        
        if old_rep:
            ifcopenshell.api.run("geometry.remove_representation", ifc_file, representation=old_rep)

    if hasattr(door, 'OverallHeight'):
        door.OverallHeight = new_height
    if hasattr(door, 'OverallWidth'):
        door.OverallWidth = new_width
    if hasattr(door, 'OperationType'):
        door.OperationType = new_operation

    save_and_load_ifc()

    if verbose:
        print(f"Updated door '{door.Name}' (GUID: {door_guid})")
        print(f"  New dimensions: {new_width}x{new_height}m")
        print(f"  Operation type: {new_operation}")
    
    return {
        "success": True,
        "door_guid": door.GlobalId,
        "name": door.Name,
        "updated_dimensions": {
            "width": new_width,
            "height": new_height
        },
        "operation_type": new_operation,
        "message": f"Successfully updated door '{door.Name}' ({door.GlobalId})"
    }


@register_command('get_door_properties', description="Get properties of an existing door")
def get_door_properties(door_guid: str) -> Dict[str, Any]:
    """Get properties of an existing door by IFC GUID."""
    ifc_file = get_ifc_file()
    door = _get_door_by_guid(door_guid, ifc_file)
    
    properties = _extract_door_properties(door, ifc_file)
    properties.update({
        "name": door.Name,
        "guid": door.GlobalId,
        "predefined_type": getattr(door, "PredefinedType", None),
        "operation_type": getattr(door, "OperationType", None)
    })
    
    return properties
