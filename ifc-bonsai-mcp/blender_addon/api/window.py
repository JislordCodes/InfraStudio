"""Window API Functions for IFC Bonsai MCP

Examples:
    create_window(name="Window", dimensions={"width": 1.2, "height": 1.5}, location=[2.0, 0.0, 1.0])
    create_window(name="Wall Window", wall_guid="wall_guid", create_opening=True, dimensions={"width": 1.8, "height": 1.2})
    create_simple_window(name="Simple", width=1.2, height=1.5, x=2.0, z=1.0)
"""

import numpy as np
import ifcopenshell
import ifcopenshell.api
from dataclasses import dataclass
from typing import Optional, List, Dict, Any, Union
from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    calculate_unit_scale, create_transformation_matrix, save_and_load_ifc, create_wall_aligned_matrix
)
from . import register_command


WINDOW_PARTITION_TYPES = {
    "SINGLE_PANEL": "SINGLE_PANEL",
    "DOUBLE_PANEL_VERTICAL": "DOUBLE_PANEL_VERTICAL",
    "DOUBLE_PANEL_HORIZONTAL": "DOUBLE_PANEL_HORIZONTAL",
    "TRIPLE_PANEL_VERTICAL": "TRIPLE_PANEL_VERTICAL",
    "TRIPLE_PANEL_BOTTOM": "TRIPLE_PANEL_BOTTOM",
    "TRIPLE_PANEL_TOP": "TRIPLE_PANEL_TOP",
    "TRIPLE_PANEL_LEFT": "TRIPLE_PANEL_LEFT",
    "TRIPLE_PANEL_RIGHT": "TRIPLE_PANEL_RIGHT",
    "TRIPLE_PANEL_HORIZONTAL": "TRIPLE_PANEL_HORIZONTAL",
    "USERDEFINED": "USERDEFINED",
}


@dataclass
class WindowLiningProperties:
    """Window frame properties (meters)."""
    LiningDepth: Optional[float] = 0.05
    LiningThickness: Optional[float] = 0.05
    LiningOffset: Optional[float] = 0.05
    LiningToPanelOffsetX: Optional[float] = 0.025
    LiningToPanelOffsetY: Optional[float] = 0.025
    MullionThickness: Optional[float] = 0.05
    FirstMullionOffset: Optional[float] = 0.3
    SecondMullionOffset: Optional[float] = 0.45
    TransomThickness: Optional[float] = 0.05
    FirstTransomOffset: Optional[float] = 0.3
    SecondTransomOffset: Optional[float] = 0.6
    ShapeAspectStyle: Optional[None] = None


@dataclass
class WindowPanelProperties:
    """Glass panel properties."""
    FrameThickness: Optional[float] = 0.035
    FrameDepth: Optional[float] = 0.035
    PanelOperation: Optional[None] = None
    PanelPosition: Optional[None] = None
    ShapeAspectStyle: Optional[None] = None


def get_panel_count_for_partition_type(partition_type: str) -> int:
    """Get panel count for partition type."""
    if partition_type == "SINGLE_PANEL":
        return 1
    if partition_type in ("DOUBLE_PANEL_VERTICAL", "DOUBLE_PANEL_HORIZONTAL"):
        return 2
    if partition_type.startswith("TRIPLE_PANEL"):
        return 3
    return 1


def create_default_panel_properties(
    partition_type: str, 
    frame_thickness: float = 0.035,
    frame_depth: float = 0.035
) -> List[WindowPanelProperties]:
    """Create default panel properties."""
    panel_count = get_panel_count_for_partition_type(partition_type)
    return [WindowPanelProperties(
        FrameThickness=frame_thickness,
        FrameDepth=frame_depth
    ) for _ in range(panel_count)]


@register_command('get_window_partition_types', description="Get all supported window partition types")
def get_window_partition_types() -> Dict[str, Any]:
    """Get all window partition types with descriptions."""
    return {
        "success": True,
        "partition_types": WINDOW_PARTITION_TYPES,
        "message": f"Found {len(WINDOW_PARTITION_TYPES)} partition types"
    }


@register_command('create_window', description="Create a new window")
def create_window(
    name: str = "New Window",
    dimensions: Dict[str, float] = None,
    partition_type: str = "SINGLE_PANEL",
    location: List[float] = None,
    rotation: List[float] = None,
    frame_properties: Dict[str, float] = None,
    panel_properties: Dict[str, float] = None,
    custom_panels: Optional[List[Dict[str, Any]]] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    unit_scale: Optional[float] = None,
    part_of_product: Optional[Any] = None,
    wall_guid: Optional[str] = None,
    create_opening: bool = False,
    verbose: bool = False,
):
    """Create parametric IfcWindow with grouped parameters.
    
    Args:
        name: Window name
        dimensions: Dict with 'width' and 'height' keys (meters)
        partition_type: Window panel configuration
        location: [x, y, z] global position for window
        rotation: [rx, ry, rz] rotation angles in degrees
        frame_properties: Window frame properties
        panel_properties: Window panel properties
        custom_panels: Custom panel configurations
        transformation_matrix: Optional 4x4 transformation matrix
        unit_scale: IFC unit scale factor
        part_of_product: Part of product reference
        wall_guid: GUID of wall to place window in (for opening creation)
        create_opening: If True and wall_guid provided, creates opening automatically
        verbose: Print debug information
    """
    
    if wall_guid and create_opening:
        ifc_file = get_ifc_file()
        
        try:
            wall = ifc_file.by_guid(wall_guid)
            if not wall or not wall.is_a("IfcWall"):
                raise ValueError(f"Wall with GUID {wall_guid} not found or not a wall")
        except Exception as e:
            raise ValueError(f"Error getting wall: {str(e)}")
        
        wall_thickness = 0.2
        try:
            if hasattr(wall, 'Representation') and wall.Representation:
                for rep in wall.Representation.Representations:
                    if rep.RepresentationIdentifier == "Body":
                        for item in rep.Items:
                            if hasattr(item, 'SweptArea') and hasattr(item.SweptArea, 'XDim'):
                                wall_thickness = item.SweptArea.XDim
                                break
                            elif item.is_a("IfcBooleanResult"):
                                first_op = item.FirstOperand
                                if hasattr(first_op, 'SweptArea') and hasattr(first_op.SweptArea, 'XDim'):
                                    wall_thickness = first_op.SweptArea.XDim
                                    break
        except:
            pass
        
        window_width = dimensions.get("width", 1.2) if dimensions else 1.2
        window_height = dimensions.get("height", 1.5) if dimensions else 1.5
        window_location = location if location else [0.0, 0.0, 1.0]
        window_rotation = rotation if rotation else [0.0, 0.0, 0.0]
        
        opening_depth = wall_thickness + 0.1
        
        from .feature import create_opening_llm, fill_opening_llm
        opening_result = create_opening_llm(
            width=window_width,
            height=window_height,
            depth=opening_depth,
            location=window_location,
            rotation=window_rotation,
            element_guid=wall_guid,
            opening_type="OPENING",
            name=f"Opening for {name}",
            verbose=verbose
        )
        
        if not opening_result.get("success"):
            raise RuntimeError(f"Failed to create opening: {opening_result.get('error', 'Unknown error')}")
        
        opening_guid = opening_result["opening_guid"]
    
    if dimensions is None:
        dimensions = {"width": 1.2, "height": 1.5}
    if location is None:
        location = [0.0, 0.0, 1.0]
    if rotation is None:
        rotation = [0.0, 0.0, 0.0]
    if frame_properties is None:
        frame_properties = {
            "lining_depth": 0.05,
            "lining_thickness": 0.05,
            "lining_offset": 0.05,
            "lining_to_panel_offset_x": 0.025,
            "lining_to_panel_offset_y": 0.025,
            "mullion_thickness": 0.05,
            "first_mullion_offset": 0.3,
            "second_mullion_offset": 0.45,
            "transom_thickness": 0.05,
            "first_transom_offset": 0.3,
            "second_transom_offset": 0.6
        }
    if panel_properties is None:
        panel_properties = {
            "frame_thickness": 0.035,
            "frame_depth": 0.035
        }
    
    overall_width = dimensions.get("width", 1.2)
    overall_height = dimensions.get("height", 1.5)
    
    position_x, position_y, position_z = location[:3] if len(location) >= 3 else location + [0.0] * (3 - len(location))
    rotation_x, rotation_y, rotation_z = rotation[:3] if len(rotation) >= 3 else rotation + [0.0] * (3 - len(rotation))
    
    if partition_type not in WINDOW_PARTITION_TYPES:
        raise ValueError(f"Invalid partition_type '{partition_type}'")
    
    ifc_file = get_ifc_file()
    container = get_default_container()
    
    if unit_scale is None:
        unit_scale = calculate_unit_scale(ifc_file)
    
    window = ifcopenshell.api.run(
        "root.create_entity",
        ifc_file,
        ifc_class="IfcWindow",
        name=name,
        predefined_type="WINDOW"
    )
    
    ifcopenshell.api.run(
        "spatial.assign_container",
        ifc_file,
        products=[window],
        relating_structure=container
    )
    
    body_context = get_or_create_body_context(ifc_file)
    
    lining_props = WindowLiningProperties(
        LiningDepth=frame_properties.get("lining_depth", 0.05),
        LiningThickness=frame_properties.get("lining_thickness", 0.05), 
        LiningOffset=frame_properties.get("lining_offset", 0.05),
        LiningToPanelOffsetX=frame_properties.get("lining_to_panel_offset_x", 0.025),
        LiningToPanelOffsetY=frame_properties.get("lining_to_panel_offset_y", 0.025),
        MullionThickness=frame_properties.get("mullion_thickness", 0.05),
        FirstMullionOffset=frame_properties.get("first_mullion_offset", 0.3),
        SecondMullionOffset=frame_properties.get("second_mullion_offset", 0.45),
        TransomThickness=frame_properties.get("transom_thickness", 0.05),
        FirstTransomOffset=frame_properties.get("first_transom_offset", 0.3),
        SecondTransomOffset=frame_properties.get("second_transom_offset", 0.6)
    )
    
    if custom_panels is None:
        panel_props = create_default_panel_properties(
            partition_type, 
            panel_properties.get("frame_thickness", 0.035), 
            panel_properties.get("frame_depth", 0.035)
        )
    else:
        panel_props = []
        for props in custom_panels:
            if isinstance(props, dict):
                panel_props.append(WindowPanelProperties(**props))
            else:
                panel_props.append(props)
    
    lining_dict = {
        k: v for k, v in lining_props.__dict__.items() 
        if v is not None and k != 'ShapeAspectStyle'
    }
    
    panel_dicts = []
    for panel in panel_props:
        panel_dict = {
            k: v for k, v in panel.__dict__.items() 
            if v is not None and k not in ['PanelOperation', 'PanelPosition', 'ShapeAspectStyle']
        }
        panel_dicts.append(panel_dict)
    
    try:
        window_rep = ifcopenshell.api.run(
            "geometry.add_window_representation",
            ifc_file,
            context=body_context,
            overall_width=overall_width,
            overall_height=overall_height,
            partition_type=partition_type,
            lining_properties=lining_dict,
            panel_properties=panel_dicts,
            unit_scale=unit_scale,
            part_of_product=part_of_product
        )
    except Exception:
        window_rep = ifcopenshell.api.run(
            "geometry.add_window_representation", 
            ifc_file,
            context=body_context,
            overall_width=overall_width,
            overall_height=overall_height,
            partition_type=partition_type,
            unit_scale=unit_scale
        )
    
    ifcopenshell.api.run(
        "geometry.assign_representation",
        ifc_file,
        product=window,
        representation=window_rep
    )
    
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
        product=window,
        matrix=mat.tolist()
    )
    
    save_and_load_ifc()
    
    if wall_guid and create_opening and 'opening_guid' in locals():
        from .feature import fill_opening_llm
        filling_result = fill_opening_llm(
            opening_guid=opening_guid,
            element_guid=window.GlobalId,
            verbose=verbose
        )
        if not filling_result.get("success") and verbose:
            print(f"Warning: Failed to fill opening with window: {filling_result.get('error')}")
    
    return {
        "success": True,
        "window_guid": window.GlobalId,
        "name": window.Name,
        "dimensions": {
            "width": overall_width,
            "height": overall_height
        },
        "partition_type": partition_type,
        "location": location,
        "rotation": rotation,
        "message": f"Successfully created window '{name}'"
    }


def _get_window_by_guid(window_guid: str, ifc_file=None):
    """Resolve an IfcWindow by GUID."""
    if ifc_file is None:
        ifc_file = get_ifc_file()

    window = None
    if hasattr(ifc_file, "by_guid"):
        try:
            window = ifc_file.by_guid(window_guid)
        except Exception:
            window = None
    
    if window is None:
        for e in ifc_file.by_type("IfcWindow"):
            if getattr(e, "GlobalId", None) == window_guid:
                window = e
                break

    if window is None:
        raise ValueError(f"Window with GUID '{window_guid}' not found")
    return window


def _extract_window_properties(window, ifc_file):
    """Extract current window properties."""
    properties = {
        "width": getattr(window, "OverallWidth", 1.2),
        "height": getattr(window, "OverallHeight", 1.5),
        "partition_type": getattr(window, "PartitioningType", "SINGLE_PANEL") or "SINGLE_PANEL",
        "lining_props": {},
        "panel_props": []
    }
    
    for rel in getattr(window, "IsDefinedBy", []):
        if rel.is_a("IfcRelDefinesByProperties"):
            prop_set = rel.RelatingPropertyDefinition
            if prop_set.is_a("IfcWindowLiningProperties"):
                properties["lining_props"] = {
                    "lining_depth": getattr(prop_set, "LiningDepth", 0.05),
                    "lining_thickness": getattr(prop_set, "LiningThickness", 0.05),
                    "lining_offset": getattr(prop_set, "LiningOffset", 0.05),
                    "lining_to_panel_offset_x": getattr(prop_set, "LiningToPanelOffsetX", 0.025),
                    "lining_to_panel_offset_y": getattr(prop_set, "LiningToPanelOffsetY", 0.025),
                    "mullion_thickness": getattr(prop_set, "MullionThickness", 0.05),
                    "first_mullion_offset": getattr(prop_set, "FirstMullionOffset", 0.3),
                    "second_mullion_offset": getattr(prop_set, "SecondMullionOffset", 0.45),
                    "transom_thickness": getattr(prop_set, "TransomThickness", 0.05),
                    "first_transom_offset": getattr(prop_set, "FirstTransomOffset", 0.3),
                    "second_transom_offset": getattr(prop_set, "SecondTransomOffset", 0.6)
                }
            elif prop_set.is_a("IfcWindowPanelProperties"):
                properties["panel_props"].append({
                    "frame_thickness": getattr(prop_set, "FrameThickness", 0.035),
                    "frame_depth": getattr(prop_set, "FrameDepth", 0.035)
                })
    
    if not properties["panel_props"]:
        properties["panel_props"] = [{"frame_thickness": 0.035, "frame_depth": 0.035}]
    
    return properties


@register_command('update_window', description="Update an existing window")
def update_window(
    window_guid: str,
    *,
    dimensions: dict | None = None,
    partition_type: str | None = None,
    frame_properties: dict | None = None,
    panel_properties: dict | None = None,
    custom_panels: list[dict] | None = None,
    part_of_product=None,
    touch_overall_attrs: bool = True,
    verbose: bool = False,
):
    """Update an existing window using its IFC GUID."""
    ifc = get_ifc_file()
    window = _get_window_by_guid(window_guid, ifc)
    body_ctx = get_or_create_body_context(ifc)
    unit_scale = calculate_unit_scale(ifc)

    current_props = _extract_window_properties(window, ifc)
    
    new_w = dimensions.get("width", current_props["width"]) if dimensions else current_props["width"]
    new_h = dimensions.get("height", current_props["height"]) if dimensions else current_props["height"]
    
    new_partition = partition_type or current_props["partition_type"]

    lining_dict = {}
    if current_props["lining_props"]:
        lining_dict = {
            "LiningDepth": current_props["lining_props"]["lining_depth"],
            "LiningThickness": current_props["lining_props"]["lining_thickness"],
            "LiningOffset": current_props["lining_props"]["lining_offset"],
            "LiningToPanelOffsetX": current_props["lining_props"]["lining_to_panel_offset_x"],
            "LiningToPanelOffsetY": current_props["lining_props"]["lining_to_panel_offset_y"],
            "MullionThickness": current_props["lining_props"]["mullion_thickness"],
            "FirstMullionOffset": current_props["lining_props"]["first_mullion_offset"],
            "SecondMullionOffset": current_props["lining_props"]["second_mullion_offset"],
            "TransomThickness": current_props["lining_props"]["transom_thickness"],
            "FirstTransomOffset": current_props["lining_props"]["first_transom_offset"],
            "SecondTransomOffset": current_props["lining_props"]["second_transom_offset"],
        }
    
    if frame_properties:
        property_mapping = {
            "lining_depth": "LiningDepth",
            "lining_thickness": "LiningThickness",
            "lining_offset": "LiningOffset",
            "lining_to_panel_offset_x": "LiningToPanelOffsetX",
            "lining_to_panel_offset_y": "LiningToPanelOffsetY",
            "mullion_thickness": "MullionThickness",
            "first_mullion_offset": "FirstMullionOffset",
            "second_mullion_offset": "SecondMullionOffset",
            "transom_thickness": "TransomThickness",
            "first_transom_offset": "FirstTransomOffset",
            "second_transom_offset": "SecondTransomOffset"
        }
        for key, ifc_key in property_mapping.items():
            if key in frame_properties:
                lining_dict[ifc_key] = frame_properties[key]

    panel_list = []
    if custom_panels:
        for p in custom_panels:
            panel_list.append({
                "FrameThickness": p.get("frame_thickness", 0.035),
                "FrameDepth": p.get("frame_depth", 0.035)
            })
    elif panel_properties:
        num_panels = get_panel_count_for_partition_type(new_partition)
        for i in range(num_panels):
            if i < len(current_props["panel_props"]):
                existing = current_props["panel_props"][i]
                panel_list.append({
                    "FrameThickness": panel_properties.get("frame_thickness", existing["frame_thickness"]),
                    "FrameDepth": panel_properties.get("frame_depth", existing["frame_depth"])
                })
            else:
                panel_list.append({
                    "FrameThickness": panel_properties.get("frame_thickness", 0.035),
                    "FrameDepth": panel_properties.get("frame_depth", 0.035)
                })
    else:
        num_panels = get_panel_count_for_partition_type(new_partition)
        for i in range(num_panels):
            if i < len(current_props["panel_props"]):
                existing = current_props["panel_props"][i]
                panel_list.append({
                    "FrameThickness": existing["frame_thickness"],
                    "FrameDepth": existing["frame_depth"]
                })
            else:
                panel_list.append({
                    "FrameThickness": 0.035,
                    "FrameDepth": 0.035
                })

    new_rep = ifcopenshell.api.run(
        "geometry.add_window_representation",
        ifc,
        context=body_ctx,
        overall_width=new_w,
        overall_height=new_h,
        partition_type=new_partition,
        lining_properties=lining_dict or None,
        panel_properties=panel_list or None,
        unit_scale=unit_scale,
        part_of_product=part_of_product,
    )

    old_rep = None
    if window.Representation and window.Representation.Representations:
        old_rep = window.Representation.Representations[0]

    ifcopenshell.api.run("geometry.assign_representation", ifc, product=window, representation=new_rep)
    if old_rep:
        ifcopenshell.api.run("geometry.unassign_representation", ifc, product=window, representation=old_rep)
        ifcopenshell.api.run("geometry.remove_representation", ifc, representation=old_rep)

    if touch_overall_attrs:
        ifcopenshell.api.run(
            "attribute.edit_attributes",
            ifc,
            product=window,
            attributes={"OverallWidth": new_w, "OverallHeight": new_h},
        )

    save_and_load_ifc()

    if verbose:
        print(f"Updated window {window.GlobalId} -> {new_w} x {new_h}, {new_partition}")
    
    return {
        "success": True,
        "window_guid": window.GlobalId,
        "name": window.Name,
        "updated_dimensions": {
            "width": new_w,
            "height": new_h
        },
        "partition_type": new_partition,
        "message": f"Successfully updated window '{window.Name}' ({window.GlobalId})"
    }


@register_command('get_window_properties', description="Get properties of an existing window")
def get_window_properties(window_guid: str) -> Dict[str, Any]:
    """Get properties of an existing window by IFC GUID."""
    ifc_file = get_ifc_file()
    window = _get_window_by_guid(window_guid, ifc_file)
    
    properties = _extract_window_properties(window, ifc_file)
    properties.update({
        "name": window.Name,
        "guid": window.GlobalId,
        "predefined_type": getattr(window, "PredefinedType", None),
        "partition_type": getattr(window, "PartitioningType", None)
    })
    
    return properties