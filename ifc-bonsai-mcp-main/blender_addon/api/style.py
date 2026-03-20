"""Style API Functions for IFC Bonsai MCP

This module provides functions for managing visual styles of IFC geometry including colours, 
transparency, materials, textures, and rendering properties.

Test Examples:
    # Basic style creation and application
    create_surface_style(name="Red Wall", color=[1.0, 0.0, 0.0], transparency=0.0)
    create_surface_style(name="Glass", color=[0.8, 0.9, 1.0], transparency=0.7)
    
    # PBR/Rendering styles
    create_pbr_style(name="Metal", diffuse_color=[0.5, 0.5, 0.5], metallic=0.9, roughness=0.1)
    create_pbr_style(name="Wood", diffuse_color=[0.6, 0.4, 0.2], metallic=0.0, roughness=0.8)
    
    # Apply styles to objects (single and batch)
    apply_style_to_object(object_guids="1AbCdEfGhIjKlMnOp", style_name="Red Wall")
    apply_style_to_object(object_guids=["1AbCdEf", "2BcDeFg", "3CdEfGh"], style_name="Red Wall")
    
    # Predefined material styles
    create_concrete_style(name="Standard Concrete")
    create_wood_style(name="Oak Wood", wood_color=[0.6, 0.4, 0.2])
    create_metal_style(name="Steel", metallic=0.9)
    create_glass_style(name="Clear Glass", transparency=0.8)
    
    # Style management
    styles = list_styles()
    update_style(style_name="Red Wall", color=[0.8, 0.2, 0.2])
    remove_style(style_name="Old Style")
"""

import ifcopenshell
import ifcopenshell.api
from dataclasses import dataclass
from typing import Optional, List, Dict, Any, Union, Tuple
from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context,
    save_and_load_ifc
)
from . import register_command


@dataclass
class StyleProperties:
    """Style properties for IFC creation."""
    name: str = "New Style"
    style_type: str = "IfcSurfaceStyle"
    surface_color: Tuple[float, float, float] = (0.8, 0.8, 0.8)
    transparency: float = 0.0
    reflectance_method: str = "NOTDEFINED"
    
    diffuse_color: Optional[Tuple[float, float, float]] = None
    metallic_factor: float = 0.0
    roughness_factor: float = 0.5
    specular_color: Optional[Tuple[float, float, float]] = None
    emissive_color: Optional[Tuple[float, float, float]] = None


@register_command('create_surface_style', description="Create basic surface style with color and transparency")
def create_surface_style(
    name: str = "New Style",
    color: List[float] = None,
    transparency: float = 0.0,
    style_type: str = "shading",
    verbose: bool = False
) -> Dict[str, Any]:
    """Create a basic surface style with color and transparency.
    
    Args:
        name: Name of the style
        color: RGB color values [R, G, B] from 0-1
        transparency: Transparency value 0-1 (0=opaque, 1=transparent)
        style_type: Type of style - "shading" for basic color, "rendering" for advanced
        verbose: Print debug information
    
    Returns:
        Dict with success status and style information
    """
    try:
        if color is None:
            color = [0.8, 0.8, 0.8]
        
        if len(color) != 3:
            raise ValueError("Color must be a list of 3 RGB values")
        
        color = [max(0.0, min(1.0, float(c))) for c in color]
        transparency = max(0.0, min(1.0, float(transparency)))
        
        ifc_file = get_ifc_file()
        
        style = ifcopenshell.api.run(
            "style.add_style",
            ifc_file,
            name=name,
            ifc_class="IfcSurfaceStyle"
        )
        
        color_attrs = {
            "SurfaceColour": {
                "Name": None,
                "Red": color[0],
                "Green": color[1], 
                "Blue": color[2]
            },
            "Transparency": transparency
        }
        
        if style_type.lower() == "rendering":
            surface_style = ifcopenshell.api.run(
                "style.add_surface_style",
                ifc_file,
                style=style,
                ifc_class="IfcSurfaceStyleRendering",
                attributes=color_attrs
            )
        else:
            surface_style = ifcopenshell.api.run(
                "style.add_surface_style", 
                ifc_file,
                style=style,
                ifc_class="IfcSurfaceStyleShading",
                attributes=color_attrs
            )
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Created style '{name}' with color {color} and transparency {transparency}")
        
        return {
            "success": True,
            "style_guid": style.GlobalId if hasattr(style, 'GlobalId') else str(style.id()),
            "style_name": name,
            "color": color,
            "transparency": transparency,
            "message": f"Successfully created surface style '{name}'"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to create surface style: {str(e)}"
        }


@register_command('create_pbr_style', description="Create PBR (physically based rendering) style")
def create_pbr_style(
    name: str = "PBR Style",
    diffuse_color: List[float] = None,
    metallic: float = 0.0,
    roughness: float = 0.5,
    transparency: float = 0.0,
    emissive_color: List[float] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Create a PBR (Physically Based Rendering) style.
    
    Args:
        name: Name of the PBR style
        diffuse_color: Base diffuse color [R, G, B] from 0-1
        metallic: Metallic factor 0-1 (0=dielectric, 1=metallic)
        roughness: Roughness factor 0-1 (0=mirror, 1=completely rough)
        transparency: Transparency 0-1 (0=opaque, 1=transparent)
        emissive_color: Emissive color [R, G, B] from 0-1
        verbose: Print debug information
    
    Returns:
        Dict with success status and style information
    """
    try:
        if diffuse_color is None:
            diffuse_color = [0.8, 0.8, 0.8]
        if emissive_color is None:
            emissive_color = [0.0, 0.0, 0.0]
        
        diffuse_color = [max(0.0, min(1.0, float(c))) for c in diffuse_color]
        emissive_color = [max(0.0, min(1.0, float(c))) for c in emissive_color]
        metallic = max(0.0, min(1.0, float(metallic)))
        roughness = max(0.0, min(1.0, float(roughness)))
        transparency = max(0.0, min(1.0, float(transparency)))
        
        ifc_file = get_ifc_file()
        
        style = ifcopenshell.api.run(
            "style.add_style",
            ifc_file,
            name=name,
            ifc_class="IfcSurfaceStyle"
        )
        
        rendering_attrs = {
            "SurfaceColour": {
                "Name": None,
                "Red": diffuse_color[0],
                "Green": diffuse_color[1],
                "Blue": diffuse_color[2]
            },
            "Transparency": transparency,
            "ReflectanceMethod": "NOTDEFINED",
            "DiffuseColour": {
                "Name": None,
                "Red": diffuse_color[0],
                "Green": diffuse_color[1],
                "Blue": diffuse_color[2]
            },
            "SpecularColour": metallic,
            "SpecularHighlight": {"SpecularRoughness": roughness}
        }
        
        if any(c > 0.001 for c in emissive_color):
            rendering_attrs["EmissiveColour"] = {
                "Name": None,
                "Red": emissive_color[0],
                "Green": emissive_color[1],
                "Blue": emissive_color[2]
            }
        
        surface_style = ifcopenshell.api.run(
            "style.add_surface_style",
            ifc_file,
            style=style,
            ifc_class="IfcSurfaceStyleRendering",
            attributes=rendering_attrs
        )
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Created PBR style '{name}' - Metallic: {metallic}, Roughness: {roughness}")
        
        return {
            "success": True,
            "style_guid": style.GlobalId if hasattr(style, 'GlobalId') else str(style.id()),
            "style_name": name,
            "diffuse_color": diffuse_color,
            "metallic": metallic,
            "roughness": roughness,
            "transparency": transparency,
            "emissive_color": emissive_color,
            "message": f"Successfully created PBR style '{name}'"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to create PBR style: {str(e)}"
        }


@register_command('apply_style_to_object', description="Apply style directly to one or more IFC objects")
def apply_style_to_object(
    object_guids: Union[str, List[str]],
    style_name: str,
    verbose: bool = False
) -> Dict[str, Any]:
    """Apply a style directly to one or more IFC objects' representations.
    
    Args:
        object_guids: Single GUID string or list of GUID strings of IFC objects to style
        style_name: Name of the style to apply
        verbose: Print debug information
    
    Returns:
        Dict with batch application results including success status and detailed results
    """
    try:
        ifc_file = get_ifc_file()
        
        # Convert single GUID to list for uniform processing
        if isinstance(object_guids, str):
            guid_list = [object_guids]
        else:
            guid_list = object_guids
        
        # Find the style once for all objects
        style = None
        for s in ifc_file.by_type("IfcSurfaceStyle"):
            if s.Name == style_name:
                style = s
                break
        
        if not style:
            return {
                "success": False,
                "error": "Style not found",
                "message": f"No style found with name: {style_name}",
                "total_objects": len(guid_list),
                "successful_objects": [],
                "failed_objects": [{"guid": guid, "error": "Style not found"} for guid in guid_list]
            }
        
        successful_objects = []
        failed_objects = []
        total_styled_items = 0
        
        # Process each object
        for object_guid in guid_list:
            try:
                obj = None
                try:
                    obj = ifc_file.by_guid(object_guid)
                except:
                    for element in ifc_file:
                        if hasattr(element, 'GlobalId') and element.GlobalId == object_guid:
                            obj = element
                            break
                
                if not obj:
                    failed_objects.append({
                        "guid": object_guid,
                        "error": "Object not found"
                    })
                    continue
                
                if not hasattr(obj, 'Representation') or not obj.Representation:
                    failed_objects.append({
                        "guid": object_guid,
                        "error": "No representation to style"
                    })
                    continue
                
                styled_items = []
                for representation in obj.Representation.Representations:
                    if representation.RepresentationIdentifier in ["Body", "Facetation"]:
                        styled_items_rep = ifcopenshell.api.run(
                            "style.assign_representation_styles",
                            ifc_file,
                            shape_representation=representation,
                            styles=[style]
                        )
                        styled_items.extend(styled_items_rep)
                
                successful_objects.append({
                    "guid": object_guid,
                    "object_name": getattr(obj, 'Name', 'Unnamed'),
                    "object_type": obj.is_a() if obj else 'Unknown',
                    "styled_items_count": len(styled_items)
                })
                total_styled_items += len(styled_items)
                
                if verbose:
                    print(f"Applied style '{style_name}' to object {object_guid} ({len(styled_items)} items)")
                    
            except Exception as obj_error:
                failed_objects.append({
                    "guid": object_guid,
                    "error": str(obj_error)
                })
        
        # Save once after processing all objects for better performance
        save_and_load_ifc()
        
        success = len(successful_objects) > 0
        
        if verbose:
            print(f"Batch style application complete: {len(successful_objects)}/{len(guid_list)} objects successful")
        
        return {
            "success": success,
            "style_name": style_name,
            "total_objects": len(guid_list),
            "successful_objects": successful_objects,
            "failed_objects": failed_objects,
            "total_styled_items": total_styled_items,
            "message": f"Applied style '{style_name}' to {len(successful_objects)}/{len(guid_list)} objects"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to apply style to objects: {str(e)}"
        }


# @register_command('apply_style_to_material', description="Apply style to a material")
# def apply_style_to_material(
#     material_name: str,
#     style_name: str,
#     context_name: str = "Body",
#     verbose: bool = False
# ) -> Dict[str, Any]:
#     """Apply a style to a material (recommended approach).
    
#     Args:
#         material_name: Name of the material to style
#         style_name: Name of the style to apply
#         context_name: Context name (usually "Body")
#         verbose: Print debug information
    
#     Returns:
#         Dict with success status and application information
#     """
#     try:
#         ifc_file = get_ifc_file()
        
#         material = None
#         for mat in ifc_file.by_type("IfcMaterial"):
#             if mat.Name == material_name:
#                 material = mat
#                 break
        
#         if not material:
#             return {
#                 "success": False,
#                 "error": "Material not found",
#                 "message": f"No material found with name: {material_name}"
#             }
        
#         style = None
#         for s in ifc_file.by_type("IfcSurfaceStyle"):
#             if s.Name == style_name:
#                 style = s
#                 break
        
#         if not style:
#             return {
#                 "success": False,
#                 "error": "Style not found", 
#                 "message": f"No style found with name: {style_name}"
#             }
        
#         context = get_or_create_body_context(ifc_file, context_name)
        
#         ifcopenshell.api.run(
#             "style.assign_material_style",
#             ifc_file,
#             material=material,
#             style=style,
#             context=context
#         )
        
#         save_and_load_ifc()
        
#         if verbose:
#             print(f"Applied style '{style_name}' to material '{material_name}'")
        
#         return {
#             "success": True,
#             "material_name": material_name,
#             "style_name": style_name,
#             "context": context_name,
#             "message": f"Successfully applied style '{style_name}' to material '{material_name}'"
#         }
        
#     except Exception as e:
#         return {
#             "success": False,
#             "error": str(e),
#             "message": f"Failed to apply style to material: {str(e)}"
#         }


@register_command('list_styles', description="List all available styles in the model")
def list_styles() -> Dict[str, Any]:
    """List all styles available in the current IFC model.
    
    Returns:
        Dict with list of styles and their properties
    """
    try:
        ifc_file = get_ifc_file()
        styles = []
        
        for style in ifc_file.by_type("IfcSurfaceStyle"):
            style_info = {
                "name": style.Name,
                "id": str(style.id()),
                "type": "IfcSurfaceStyle"
            }
            
            if hasattr(style, 'Styles') and style.Styles:
                for style_item in style.Styles:
                    if style_item.is_a("IfcSurfaceStyleShading"):
                        if hasattr(style_item, 'SurfaceColour') and style_item.SurfaceColour:
                            color = style_item.SurfaceColour
                            style_info["color"] = [color.Red, color.Green, color.Blue]
                        if hasattr(style_item, 'Transparency'):
                            style_info["transparency"] = style_item.Transparency
                        style_info["style_type"] = "Shading"
                    
                    elif style_item.is_a("IfcSurfaceStyleRendering"):
                        if hasattr(style_item, 'SurfaceColour') and style_item.SurfaceColour:
                            color = style_item.SurfaceColour
                            style_info["surface_color"] = [color.Red, color.Green, color.Blue]
                        if hasattr(style_item, 'DiffuseColour') and style_item.DiffuseColour:
                            if hasattr(style_item.DiffuseColour, 'Red'):
                                diffuse = style_item.DiffuseColour
                                style_info["diffuse_color"] = [diffuse.Red, diffuse.Green, diffuse.Blue]
                        if hasattr(style_item, 'Transparency'):
                            style_info["transparency"] = style_item.Transparency
                        if hasattr(style_item, 'SpecularColour'):
                            style_info["metallic"] = style_item.SpecularColour
                        if hasattr(style_item, 'SpecularHighlight') and style_item.SpecularHighlight:
                            if hasattr(style_item.SpecularHighlight, 'SpecularRoughness'):
                                style_info["roughness"] = style_item.SpecularHighlight.SpecularRoughness
                        style_info["style_type"] = "Rendering/PBR"
            
            styles.append(style_info)
        
        return {
            "success": True,
            "styles": styles,
            "count": len(styles),
            "message": f"Found {len(styles)} styles in the model"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to list styles: {str(e)}"
        }


@register_command('update_style', description="Update an existing style")
def update_style(
    style_name: str,
    color: List[float] = None,
    transparency: float = None,
    metallic: float = None,
    roughness: float = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Update properties of an existing style.
    
    Args:
        style_name: Name of the style to update
        color: New RGB color values [R, G, B] from 0-1
        transparency: New transparency value 0-1
        metallic: New metallic factor 0-1 (for PBR styles)
        roughness: New roughness factor 0-1 (for PBR styles)
        verbose: Print debug information
    
    Returns:
        Dict with success status and update information
    """
    try:
        ifc_file = get_ifc_file()
        
        style = None
        for s in ifc_file.by_type("IfcSurfaceStyle"):
            if s.Name == style_name:
                style = s
                break
        
        if not style:
            return {
                "success": False,
                "error": "Style not found",
                "message": f"No style found with name: {style_name}"
            }
        
        updated_properties = []
        
        if hasattr(style, 'Styles') and style.Styles:
            for style_item in style.Styles:
                update_attrs = {}
                
                if style_item.is_a("IfcSurfaceStyleShading"):
                    if color is not None:
                        update_attrs["SurfaceColour"] = {
                            "Name": None,
                            "Red": max(0.0, min(1.0, float(color[0]))),
                            "Green": max(0.0, min(1.0, float(color[1]))),
                            "Blue": max(0.0, min(1.0, float(color[2])))
                        }
                        updated_properties.append("color")
                    
                    if transparency is not None:
                        update_attrs["Transparency"] = max(0.0, min(1.0, float(transparency)))
                        updated_properties.append("transparency")
                
                elif style_item.is_a("IfcSurfaceStyleRendering"):
                    if color is not None:
                        color_dict = {
                            "Name": None,
                            "Red": max(0.0, min(1.0, float(color[0]))),
                            "Green": max(0.0, min(1.0, float(color[1]))),
                            "Blue": max(0.0, min(1.0, float(color[2])))
                        }
                        update_attrs["SurfaceColour"] = color_dict
                        update_attrs["DiffuseColour"] = color_dict
                        updated_properties.append("color")
                    
                    if transparency is not None:
                        update_attrs["Transparency"] = max(0.0, min(1.0, float(transparency)))
                        updated_properties.append("transparency")
                    
                    if metallic is not None:
                        update_attrs["SpecularColour"] = max(0.0, min(1.0, float(metallic)))
                        updated_properties.append("metallic")
                    
                    if roughness is not None:
                        update_attrs["SpecularHighlight"] = {"SpecularRoughness": max(0.0, min(1.0, float(roughness)))}
                        updated_properties.append("roughness")
                
                if update_attrs:
                    ifcopenshell.api.run(
                        "style.edit_surface_style",
                        ifc_file,
                        style=style_item,
                        attributes=update_attrs
                    )
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Updated style '{style_name}' - Properties: {', '.join(updated_properties)}")
        
        return {
            "success": True,
            "style_name": style_name,
            "updated_properties": updated_properties,
            "message": f"Successfully updated style '{style_name}'"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to update style: {str(e)}"
        }


@register_command('remove_style', description="Remove a style from the model")
def remove_style(
    style_name: str,
    verbose: bool = False
) -> Dict[str, Any]:
    """Remove a style from the model.
    
    Args:
        style_name: Name of the style to remove
        verbose: Print debug information
    
    Returns:
        Dict with success status and removal information
    """
    try:
        ifc_file = get_ifc_file()
        
        style = None
        for s in ifc_file.by_type("IfcSurfaceStyle"):
            if s.Name == style_name:
                style = s
                break
        
        if not style:
            return {
                "success": False,
                "error": "Style not found",
                "message": f"No style found with name: {style_name}"
            }
        
        ifcopenshell.api.run(
            "style.remove_style",
            ifc_file,
            style=style
        )
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Removed style '{style_name}'")
        
        return {
            "success": True,
            "style_name": style_name,
            "message": f"Successfully removed style '{style_name}'"
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Failed to remove style: {str(e)}"
        }

