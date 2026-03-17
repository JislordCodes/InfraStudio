"""Feature API Functions for IFC Bonsai MCP

Examples:
    create_opening(width=1.2, height=1.5, depth=0.3, location=[2.0, 0.0, 1.0], wall_guid="wall_guid")
    fill_opening(opening_guid="opening_guid", element_guid="element_guid")
    remove_opening(opening_guid="opening_guid", remove_filling=True)
"""
from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass
import numpy as np
import ifcopenshell
import ifcopenshell.api

from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context, 
    calculate_unit_scale, create_transformation_matrix, save_and_load_ifc
)
from . import register_command


OPENING_TYPES = {
    "OPENING": "OPENING",
    "RECESS": "RECESS", 
    "NOTDEFINED": "NOTDEFINED",
    "USERDEFINED": "USERDEFINED"
}


@dataclass
class OpeningProperties:
    """Properties for creating IFC openings."""
    name: str = "New Opening"
    opening_type: str = "OPENING"
    width: float = 1.0  # meters
    height: float = 2.0  # meters 
    depth: float = 0.3  # meters
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    rotation_x: float = 0.0  # degrees
    rotation_y: float = 0.0  # degrees
    rotation_z: float = 0.0  # degrees


@register_command('get_opening_types', description="Get all supported opening types")
def get_opening_types() -> Dict[str, Any]:
    """Get all opening types with descriptions."""
    try:
        return {
            "success": True,
            "opening_types": OPENING_TYPES,
            "descriptions": {
                "OPENING": "Standard opening for doors, windows, etc.",
                "RECESS": "Recess or alcove in the element",
                "NOTDEFINED": "Opening type not defined",
                "USERDEFINED": "User-defined opening type"
            }
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('create_opening', description="Create a rectangular opening (void) in an element")
def create_opening(
    width: float = 1.0,
    height: float = 2.0,
    depth: float = 0.3,
    location: Optional[List[float]] = None,
    rotation: Optional[List[float]] = None,
    element_guid: Optional[str] = None,
    wall_guid: Optional[str] = None,  # Alias for element_guid
    slab_guid: Optional[str] = None,  # Alias for element_guid
    opening_type: str = "OPENING",
    name: Optional[str] = None,
    transformation_matrix: Optional[Union[np.ndarray, List[List[float]]]] = None,
    unit_scale: Optional[float] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Create a rectangular opening in a wall, slab, or other element.
    
    Args:
        width: Opening width in meters
        height: Opening height in meters
        depth: Opening depth in meters (should be slightly larger than element thickness)
        location: [x, y, z] position of opening center
        rotation: [rx, ry, rz] rotation angles in degrees
        element_guid: GUID of element to create opening in (wall, slab, etc.)
        wall_guid: Alias for element_guid (for walls)
        slab_guid: Alias for element_guid (for slabs)
        opening_type: Type of opening (OPENING, RECESS, etc.)
        name: Optional opening name
        transformation_matrix: Optional 4x4 transformation matrix
        unit_scale: IFC unit scale factor
        verbose: Print debug information
        
    Returns:
        Dictionary with success status, opening GUID, and relationship info
    """
    try:
        if location is None:
            location = [0.0, 0.0, 1.0]
        if rotation is None:
            rotation = [0.0, 0.0, 0.0]
        if name is None:
            name = f"Opening {width}x{height}"
            
        target_element_guid = element_guid or wall_guid or slab_guid
        if not target_element_guid:
            return {"success": False, "error": "No element GUID provided"}
            
        ifc_file = get_ifc_file()
        container = get_default_container()
        body_context = get_or_create_body_context(ifc_file)
        
        if unit_scale is None:
            unit_scale = calculate_unit_scale(ifc_file)
            
        try:
            target_element = ifc_file.by_guid(target_element_guid)
            if not target_element:
                return {"success": False, "error": f"Element with GUID {target_element_guid} not found"}
        except Exception:
            return {"success": False, "error": f"Invalid element GUID: {target_element_guid}"}
            
        if opening_type not in OPENING_TYPES:
            opening_type = "OPENING"
            
        opening = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class="IfcOpeningElement",
            name=name,
            predefined_type=opening_type
        )
        
        ifcopenshell.api.run(
            "spatial.assign_container",
            ifc_file,
            products=[opening],
            relating_structure=container
        )
        
        opening_representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            ifc_file,
            context=body_context,
            length=width,
            height=height,
            thickness=depth
        )
        
        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=opening,
            representation=opening_representation
        )
        
        if transformation_matrix is not None:
            if isinstance(transformation_matrix, list):
                mat = np.array(transformation_matrix, dtype=float)
            else:
                mat = transformation_matrix.astype(float)
                
            if mat.shape != (4, 4):
                return {"success": False, "error": "Transformation matrix must be 4x4"}
        else:
            position_x, position_y, position_z = location[:3]
            rotation_x, rotation_y, rotation_z = rotation[:3]
            
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
            product=opening,
            matrix=mat.tolist()
        )
        
        void_rel = ifcopenshell.api.run(
            "feature.add_feature",
            ifc_file,
            feature=opening,
            element=target_element
        )
        
        save_and_load_ifc()
        
        result = {
            "success": True,
            "opening_guid": opening.GlobalId,
            "element_guid": target_element.GlobalId,
            "void_relationship_guid": void_rel.GlobalId,
            "opening_name": name,
            "dimensions": {"width": width, "height": height, "depth": depth},
            "location": location,
            "rotation": rotation
        }
        
        if verbose:
            print(f"Created opening {opening.GlobalId} in {target_element.is_a()} {target_element.GlobalId}")
            
        return result
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('fill_opening', description="Fill an opening with an element (door, window, etc.)")
def fill_opening(
    opening_guid: str,
    element_guid: str,
    verbose: bool = False
) -> Dict[str, Any]:
    """Fill an opening with an element like a door or window.
    
    Args:
        opening_guid: GUID of opening to fill
        element_guid: GUID of element to fill opening with
        verbose: Print debug information
        
    Returns:
        Dictionary with success status and filling relationship info
    """
    try:
        ifc_file = get_ifc_file()
        
        try:
            opening = ifc_file.by_guid(opening_guid)
            element = ifc_file.by_guid(element_guid)
        except Exception:
            return {"success": False, "error": "Invalid GUID provided"}
            
        if not opening or not opening.is_a("IfcOpeningElement"):
            return {"success": False, "error": f"Opening with GUID {opening_guid} not found or not an opening"}
            
        if not element:
            return {"success": False, "error": f"Element with GUID {element_guid} not found"}
            
        filling_rel = ifcopenshell.api.run(
            "feature.add_filling",
            ifc_file,
            opening=opening,
            element=element
        )
        
        save_and_load_ifc()
        
        result = {
            "success": True,
            "opening_guid": opening_guid,
            "element_guid": element_guid,
            "filling_relationship_guid": filling_rel.GlobalId,
            "opening_name": opening.Name or "Unnamed Opening",
            "element_name": element.Name or "Unnamed Element",
            "element_type": element.is_a()
        }
        
        if verbose:
            print(f"Filled opening {opening_guid} with {element.is_a()} {element_guid}")
            
        return result
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('remove_opening', description="Remove opening and optionally its filling")
def remove_opening(
    opening_guid: str,
    remove_filling: bool = True,
    verbose: bool = False
) -> Dict[str, Any]:
    """Remove an opening and optionally its filling element.
    
    Args:
        opening_guid: GUID of opening to remove
        remove_filling: Whether to also remove the filling element
        verbose: Print debug information
    """
    try:
        ifc_file = get_ifc_file()
        
        try:
            opening = ifc_file.by_guid(opening_guid)
        except Exception:
            return {"success": False, "error": f"Opening with GUID {opening_guid} not found"}
            
        if not opening or not opening.is_a("IfcOpeningElement"):
            return {"success": False, "error": "Specified element is not an opening"}
            
        removed_elements = []
        
        if remove_filling:
            for rel in opening.HasFillings or []:
                if rel.is_a("IfcRelFillsElement"):
                    filling_element = rel.RelatedBuildingElement
                    if filling_element:
                        ifcopenshell.api.run("root.remove_product", ifc_file, product=filling_element)
                        removed_elements.append({
                            "type": "filling",
                            "guid": filling_element.GlobalId,
                            "name": filling_element.Name or "Unnamed"
                        })
        
        ifcopenshell.api.run("feature.remove_feature", ifc_file, feature=opening)
        
        removed_elements.append({
            "type": "opening",
            "guid": opening_guid,
            "name": opening.Name or "Unnamed Opening"
        })
        
        save_and_load_ifc()
        
        result = {
            "success": True,
            "removed_elements": removed_elements,
            "message": f"Removed opening {opening_guid} and {len(removed_elements)-1} related elements"
        }
        
        if verbose:
            print(f"Removed opening {opening_guid} and {len(removed_elements)-1} related elements")
            
        return result
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('remove_filling', description="Remove filling from opening (keep both opening and element)")
def remove_filling(
    element_guid: str,
    verbose: bool = False
) -> Dict[str, Any]:
    """Remove filling relationship between element and opening.
    
    Both opening and element remain, but element no longer fills the opening.
    
    Args:
        element_guid: GUID of element that fills an opening
        verbose: Print debug information
    """
    try:
        ifc_file = get_ifc_file()
        
        try:
            element = ifc_file.by_guid(element_guid)
        except Exception:
            return {"success": False, "error": f"Element with GUID {element_guid} not found"}
            
        ifcopenshell.api.run("feature.remove_filling", ifc_file, element=element)
        
        save_and_load_ifc()
        
        result = {
            "success": True,
            "element_guid": element_guid,
            "message": f"Removed filling relationship for element {element_guid}"
        }
        
        if verbose:
            print(f"Removed filling relationship for element {element_guid}")
            
        return result
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('get_element_openings', description="Get all openings in an element")
def get_element_openings(
    element_guid: str,
    include_fillings: bool = True
) -> Dict[str, Any]:
    """Get all openings (voids) in a specified element.
    
    Args:
        element_guid: GUID of element to check for openings
        include_fillings: Whether to include information about filling elements
        
    Returns:
        List of openings with their properties and optional filling info
    """
    try:
        ifc_file = get_ifc_file()
        
        try:
            element = ifc_file.by_guid(element_guid)
        except Exception:
            return {"success": False, "error": f"Element with GUID {element_guid} not found"}
            
        openings = []
        
        for rel in getattr(element, 'HasOpenings', []) or []:
            if rel.is_a("IfcRelVoidsElement"):
                opening = rel.RelatedOpeningElement
                if opening and opening.is_a("IfcOpeningElement"):
                    opening_info = {
                        "opening_guid": opening.GlobalId,
                        "name": opening.Name or "Unnamed Opening",
                        "predefined_type": getattr(opening, 'PredefinedType', 'NOTDEFINED'),
                        "has_representation": bool(getattr(opening, 'Representation', None))
                    }
                    
                    if include_fillings:
                        fillings = []
                        for filling_rel in getattr(opening, 'HasFillings', []) or []:
                            if filling_rel.is_a("IfcRelFillsElement"):
                                filling_element = filling_rel.RelatedBuildingElement
                                if filling_element:
                                    fillings.append({
                                        "element_guid": filling_element.GlobalId,
                                        "element_name": filling_element.Name or "Unnamed",
                                        "element_type": filling_element.is_a()
                                    })
                        opening_info["fillings"] = fillings
                        
                    openings.append(opening_info)
        
        return {
            "success": True,
            "element_guid": element_guid,
            "element_name": element.Name or "Unnamed",
            "element_type": element.is_a(),
            "opening_count": len(openings),
            "openings": openings
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}


@register_command('get_opening_info', description="Get detailed information about an opening")
def get_opening_info(opening_guid: str) -> Dict[str, Any]:
    """Get detailed information about a specific opening.
    
    Args:
        opening_guid: GUID of opening to get information about
    """
    try:
        ifc_file = get_ifc_file()
        
        try:
            opening = ifc_file.by_guid(opening_guid)
        except Exception:
            return {"success": False, "error": f"Opening with GUID {opening_guid} not found"}
            
        if not opening or not opening.is_a("IfcOpeningElement"):
            return {"success": False, "error": "Specified element is not an opening"}
            
        opening_info = {
            "opening_guid": opening.GlobalId,
            "name": opening.Name or "Unnamed Opening",
            "predefined_type": getattr(opening, 'PredefinedType', 'NOTDEFINED'),
            "has_representation": bool(getattr(opening, 'Representation', None))
        }
        
        voided_element = None
        for rel in getattr(opening, 'VoidsElements', []) or []:
            if rel.is_a("IfcRelVoidsElement"):
                voided_element = rel.RelatingBuildingElement
                break
                
        if voided_element:
            opening_info["voids_element"] = {
                "element_guid": voided_element.GlobalId,
                "element_name": voided_element.Name or "Unnamed",
                "element_type": voided_element.is_a()
            }
        
        fillings = []
        for filling_rel in getattr(opening, 'HasFillings', []) or []:
            if filling_rel.is_a("IfcRelFillsElement"):
                filling_element = filling_rel.RelatedBuildingElement
                if filling_element:
                    fillings.append({
                        "element_guid": filling_element.GlobalId,
                        "element_name": filling_element.Name or "Unnamed",
                        "element_type": filling_element.is_a(),
                        "relationship_guid": filling_rel.GlobalId
                    })
        opening_info["fillings"] = fillings
        
        return {
            "success": True,
            **opening_info
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}