"""
Scene-related functions for the IFC Bonsai MCP addon.
Simple Blender-only operations for scene information.

Model-friendly improvements:
- Optional inclusion of world-space AABB and transform data in listings.
- Consistent geometry block in detailed object info.
"""

import bpy
import mathutils
import traceback
from . import register_command
from typing import List, Optional, Dict, Any, Union
from bonsai import tool
import ifcopenshell
import ifcopenshell.util.element
try:
    import ifcopenshell.util.unit as ifc_unit
except Exception:
    ifc_unit = None


@register_command('get_scene_info', description="Get basic information about the current Blender scene.")
def get_scene_info(
    limit: int = -1,
    offset: int = 0,
    obj_type: Optional[str] = None,
    include_bbox: bool = False,
    include_transform: bool = False,
    round_decimals: int = 3,
    detailed: bool = False
):
    """Get list of Blender objects with basic information including IFC GUIDs.

    Args:
        limit: Max number of objects to return; -1 returns all from offset.
        offset: Start index for pagination.
        obj_type: Filter by Blender object type (e.g., 'MESH').
        include_bbox: When True, include world AABB min/max/dimensions.
        include_transform: When True, include rotation, scale, dimensions, matrix_world.
        round_decimals: Rounding for floats in compact listings.
        detailed: When True, include detailed object information.
    
    Returns:
        Each object includes 'guid' (IFC GlobalId) and 'ifc_class' fields.
    """
    try:
        all_objects = list(bpy.context.scene.objects)
        if obj_type:
            all_objects = [obj for obj in all_objects if obj.type == obj_type]
        
        selected_objects = all_objects[offset:offset + limit] if limit > 0 else all_objects[offset:]
        
        objects = []
        for obj in selected_objects:
            r = round_decimals
            obj_info: Dict[str, Any] = {
                "name": obj.name,
                "type": obj.type,
                "location": [round(float(obj.location.x), r), 
                              round(float(obj.location.y), r), 
                              round(float(obj.location.z), r)],
                "visible": obj.visible_get(),
                "selected": obj.select_get()
            }
            
            element = tool.Ifc.get_entity(obj)
            if element:
                obj_info["guid"] = getattr(element, 'GlobalId', None)
                obj_info["ifc_class"] = element.is_a()
            else:
                obj_info["guid"] = None
                obj_info["ifc_class"] = None

            if include_transform:
                obj_info["rotation"] = [round(float(obj.rotation_euler.x), r),
                                         round(float(obj.rotation_euler.y), r),
                                         round(float(obj.rotation_euler.z), r)]
                obj_info["scale"] = [round(float(obj.scale.x), r),
                                      round(float(obj.scale.y), r),
                                      round(float(obj.scale.z), r)]
                obj_info["dimensions"] = [round(float(obj.dimensions.x), r),
                                           round(float(obj.dimensions.y), r),
                                           round(float(obj.dimensions.z), r)]
                mw = obj.matrix_world
                obj_info["matrix_world"] = [round(float(v), r) for row in mw for v in row]

            if include_bbox:
                corners = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
                mins = [min(corner[i] for corner in corners) for i in range(3)]
                maxs = [max(corner[i] for corner in corners) for i in range(3)]
                obj_info["bounding_box"] = {
                    "min": [round(float(mins[0]), r), round(float(mins[1]), r), round(float(mins[2]), r)],
                    "max": [round(float(maxs[0]), r), round(float(maxs[1]), r), round(float(maxs[2]), r)],
                    "dimensions": [round(float(maxs[0]-mins[0]), r),
                                    round(float(maxs[1]-mins[1]), r),
                                    round(float(maxs[2]-mins[2]), r)],
                }
                
            if detailed:
                obj_info["detailed_info"] = get_blender_object_info(obj.name)
            
            objects.append(obj_info)
        
        return {
            "count": len(objects),
            "total": len(all_objects),
            "objects": objects
        }
    except Exception as e:
        print(f"Error in get_blender_objects: {str(e)}")
        traceback.print_exc()
        return {"error": str(e)}
    

@register_command('get_blender_object_info', description="Get detailed Blender information about a specific object")
def get_blender_object_info(object_name):
    """Get detailed Blender information about a specific object."""
    try:
        obj = bpy.data.objects.get(object_name)
        if not obj:
            return {"error": f"Object not found: {object_name}"}
        
        object_info: Dict[str, Any] = {
            "name": obj.name,
            "type": obj.type,
            "location": [float(obj.location.x), float(obj.location.y), float(obj.location.z)],
            "rotation": [float(obj.rotation_euler.x), float(obj.rotation_euler.y), float(obj.rotation_euler.z)],
            "scale": [float(obj.scale.x), float(obj.scale.y), float(obj.scale.z)],
            "visible": obj.visible_get(),
            "selected": obj.select_get(),
            "parent": obj.parent.name if obj.parent else None
        }

        object_info["geometry"] = {
            "location": [float(obj.location.x), float(obj.location.y), float(obj.location.z)],
            "rotation": [float(obj.rotation_euler.x), float(obj.rotation_euler.y), float(obj.rotation_euler.z)],
            "scale": [float(obj.scale.x), float(obj.scale.y), float(obj.scale.z)],
            "dimensions": [float(obj.dimensions.x), float(obj.dimensions.y), float(obj.dimensions.z)],
            "matrix_world": [float(v) for row in obj.matrix_world for v in row]
        }
        
        object_info["materials"] = []
        if obj.material_slots:
            for slot in obj.material_slots:
                if slot.material:
                    object_info["materials"].append(slot.material.name)
        
        if obj.type == 'MESH' and obj.data:
            mesh_info = {
                "vertex_count": len(obj.data.vertices),
                "edge_count": len(obj.data.edges),
                "face_count": len(obj.data.polygons),
            }
            object_info["mesh_info"] = mesh_info
        
        corners = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
        mins = [min(corner[i] for corner in corners) for i in range(3)]
        maxs = [max(corner[i] for corner in corners) for i in range(3)]
        object_info["bounding_box"] = {
            "min": [float(mins[0]), float(mins[1]), float(mins[2])],
            "max": [float(maxs[0]), float(maxs[1]), float(maxs[2])],
            "dimensions": [float(maxs[0]-mins[0]), float(maxs[1]-mins[1]), float(maxs[2]-mins[2])],
        }
        
        return object_info
    except Exception as e:
        print(f"Error in get_blender_object_info: {str(e)}")
        traceback.print_exc()
        return {"error": str(e)}
    

@register_command('get_selected_objects', description="Get list of currently selected Blender objects with GUID information")
def get_selected_objects() -> Dict[str, Any]:
    """Get list of currently selected Blender objects with their IFC GUIDs."""
    try:
        selected_objects = []
        for obj in bpy.context.selected_objects:
            obj_info = {
                "name": obj.name,
                "type": obj.type
            }
            
            element = tool.Ifc.get_entity(obj)
            if element:
                obj_info["guid"] = getattr(element, 'GlobalId', None)
                obj_info["ifc_class"] = element.is_a()
            else:
                obj_info["guid"] = None
                obj_info["ifc_class"] = None
            
            selected_objects.append(obj_info)
        
        return {
            "count": len(selected_objects),
            "selected_objects": selected_objects
        }
    except Exception as e:
        print(f"Error in get_selected_objects: {str(e)}")
        traceback.print_exc()
        return {"error": str(e)}


@register_command('get_object_info', description="Get IFC object information")
def get_object_info(
    guids: Optional[Union[str, List[str]]] = None,
    use_selection: bool = False,
    detailed: bool = False
) -> Dict[str, Any]:
    """Get IFC object information from GUIDs or selection."""
    if isinstance(guids, str):
        guids = [guids]
    
    ifc_file = tool.Ifc.get()
    if not ifc_file:
        return {"success": False, "error": "No IFC file loaded"}
    
    objects_info = []
    errors = []
    
    def extract_object_info(element: ifcopenshell.entity_instance, blender_obj: Optional[bpy.types.Object], detailed: bool) -> Dict[str, Any]:
        info = {
            "guid": getattr(element, 'GlobalId', None),
            "ifc_class": element.is_a(),
            "name": getattr(element, 'Name', None),
            "description": getattr(element, 'Description', None),
            "tag": getattr(element, 'Tag', None),
            "id": element.id(),
            "blender_name": blender_obj.name if blender_obj else None
        }
        
        try:
            info["predefined_type"] = ifcopenshell.util.element.get_predefined_type(element)
            element_type = ifcopenshell.util.element.get_type(element)
            info["type"] = {
                "name": element_type.Name,
                "guid": element_type.GlobalId,
                "class": element_type.is_a()
            } if element_type else None
            
            container = ifcopenshell.util.element.get_container(element)
            info["container"] = {
                "name": container.Name,
                "guid": container.GlobalId,
                "class": container.is_a()
            } if container else None
        except:
            info["predefined_type"] = None
            info["type"] = None
            info["container"] = None
        
        if detailed:
            # Get property sets
            try:
                info["property_sets"] = ifcopenshell.util.element.get_psets(element, qtos_only=False) or {}
            except:
                info["property_sets"] = {}
            
            # Get quantities
            try:
                info["quantities"] = ifcopenshell.util.element.get_psets(element, qtos_only=True) or {}
            except:
                info["quantities"] = {}
            
            # Get material info
            try:
                material = ifcopenshell.util.element.get_material(element)
                info["material"] = {
                    "name": getattr(material, 'Name', str(material)),
                    "class": material.is_a()
                } if material else None
            except:
                info["material"] = None
            
            # Get relationships
            relationships = {
                "decomposes": [],
                "decomposed_by": [],
                "associates": [],
                "connected_to": [],
                "connected_from": [],
                "contained_in": None,
                "fills": None
            }
            
            try:
                def make_ref(el):
                    return {
                        "name": getattr(el, 'Name', None),
                        "guid": getattr(el, 'GlobalId', None),
                        "class": el.is_a()
                    }
                
                for rel in getattr(element, 'Decomposes', []):
                    parent = getattr(rel, 'RelatingObject', None)
                    if parent:
                        relationships["decomposes"].append(make_ref(parent))
                
                for rel in getattr(element, 'IsDecomposedBy', []):
                    for child in getattr(rel, 'RelatedObjects', []):
                        relationships["decomposed_by"].append(make_ref(child))
                
                for rel in getattr(element, 'HasAssociations', []):
                    relationships["associates"].append({
                        "type": rel.is_a(),
                        "name": getattr(rel, 'Name', None)
                    })
                
                for rel in getattr(element, 'ConnectedTo', []):
                    connected = getattr(rel, 'RelatedElement', None)
                    if connected:
                        relationships["connected_to"].append(make_ref(connected))
                
                for rel in getattr(element, 'ConnectedFrom', []):
                    connecting = getattr(rel, 'RelatingElement', None)
                    if connecting:
                        relationships["connected_from"].append(make_ref(connecting))
                
                for rel in getattr(element, 'ContainedInStructure', []):
                    structure = getattr(rel, 'RelatingStructure', None)
                    if structure:
                        relationships["contained_in"] = make_ref(structure)
                        break
                
                for rel in getattr(element, 'FillsVoids', []):
                    opening = getattr(rel, 'RelatingOpeningElement', None)
                    if opening:
                        relationships["fills"] = {
                            "opening_guid": getattr(opening, 'GlobalId', None),
                            "class": opening.is_a()
                        }
                        break
            except:
                pass
            
            info["relationships"] = relationships
            
            if blender_obj:
                info["geometry"] = {
                    "location": list(blender_obj.location),
                    "rotation": list(blender_obj.rotation_euler),
                    "scale": list(blender_obj.scale),
                    "dimensions": list(blender_obj.dimensions)
                }
        
        return info
    
    if use_selection or not guids:
        selected_objs = tool.Blender.get_selected_objects()
        if not selected_objs:
            return {"success": False, "error": "No objects selected", "objects": []}
        
        for obj in selected_objs:
            element = tool.Ifc.get_entity(obj)
            if element:
                objects_info.append(extract_object_info(element, obj, detailed))
            else:
                errors.append(f"Object '{obj.name}' has no IFC entity")
    
    elif guids:
        for guid in guids:
            try:
                element = ifc_file.by_guid(guid)
                if element:
                    obj = tool.Ifc.get_object(element)
                    objects_info.append(extract_object_info(element, obj, detailed))
                else:
                    errors.append(f"GUID {guid} not found")
            except Exception as e:
                errors.append(f"Error processing GUID {guid}: {str(e)}")
    
    return {
        "success": bool(objects_info),
        "objects": objects_info,
        "errors": errors,
        "count": len(objects_info)
    }


@register_command('get_ifc_scene_overview', description='Get comprehensive IFC scene overview')
def get_ifc_scene_overview(include_selection_summary: bool = False) -> Dict[str, Any]:
    """Return consolidated overview of the loaded IFC scene."""
    ifc_file = tool.Ifc.get()
    if not ifc_file:
        return {"success": False, "error": "No IFC file loaded"}

    overview = {"success": True}

    result = {"success": True, "units": {}, "project": {}}
    try:
        project = next(iter(ifc_file.by_type('IfcProject')), None)
        if project:
            result["project"] = {
                "name": getattr(project, 'Name', None),
                "global_id": getattr(project, 'GlobalId', None),
                "schema": getattr(ifc_file, 'schema', None),
            }
    except:
        pass

    if ifc_unit:
        try:
            result["units"] = {
                "length": ifc_unit.calculate_length_unit(ifc_file),
                "area": ifc_unit.calculate_area_unit(ifc_file),
                "volume": ifc_unit.calculate_volume_unit(ifc_file),
                "angle": ifc_unit.calculate_plane_angle_unit(ifc_file),
            }
        except:
            pass
    
    if not result["units"]:
        try:
            project = next(iter(ifc_file.by_type('IfcProject')), None)
            uctx = getattr(project, 'UnitsInContext', None)
            if uctx and getattr(uctx, 'Units', None):
                units = {}
                for u in uctx.Units:
                    try:
                        unit_type = getattr(u, 'UnitType', None)
                        name = getattr(u, 'Name', None) or getattr(u, 'Prefix', None)
                        if unit_type:
                            units[str(unit_type)] = str(name)
                    except:
                        continue
                if units:
                    result["units"] = units
        except:
            pass
    
    if result.get("success"):
        overview.update(result)
    else:
        overview.update({"project": {}, "units": {}})

    counts = {}
    for el in ifc_file.by_type('IfcElement'):
        cls = el.is_a()
        counts[cls] = counts.get(cls, 0) + 1
    
    overview["class_counts"] = counts
    overview["class_total"] = sum(counts.values())

    def build_tree(element):
        node = {
            "guid": getattr(element, 'GlobalId', None),
            "ifc_class": element.is_a(),
            "name": getattr(element, 'Name', None),
            "contained_elements": 0,
            "children": []
        }
        
        for rel in getattr(element, 'ContainsElements', []):
            node["contained_elements"] += len(getattr(rel, 'RelatedElements', []))
        
        for rel in getattr(element, 'IsDecomposedBy', []):
            for child in getattr(rel, 'RelatedObjects', []):
                node["children"].append(build_tree(child))
        
        return node

    projects = [build_tree(p) for p in ifc_file.by_type('IfcProject')]
    overview["spatial"] = projects
    
    counts = {"projects": 0, "sites": 0, "buildings": 0, "storeys": 0, "spaces": 0}
    
    def walk(tree):
        yield tree
        for child in tree.get("children", []):
            yield from walk(child)

    for project in projects:
        for node in walk(project):
            cls = node.get("ifc_class", "").lower()
            if cls == "ifcproject":
                counts["projects"] += 1
            elif cls == "ifcsite":
                counts["sites"] += 1
            elif cls == "ifcbuilding":
                counts["buildings"] += 1
            elif cls == "ifcbuildingstorey":
                counts["storeys"] += 1
            elif cls == "ifcspace":
                counts["spaces"] += 1
    
    overview["summary"] = counts

    if include_selection_summary:
        try:
            selected_objs = tool.Blender.get_selected_objects()
            if not selected_objs:
                overview["selection_summary"] = {"success": False, "error": "No objects selected", "count": 0}
            else:
                summary = {
                    "success": True,
                    "total_count": len(selected_objs),
                    "ifc_objects": 0,
                    "non_ifc_objects": 0,
                    "by_class": {},
                    "objects": []
                }
                
                for obj in selected_objs:
                    element = tool.Ifc.get_entity(obj)
                    if element:
                        summary["ifc_objects"] += 1
                        ifc_class = element.is_a()
                        summary["by_class"][ifc_class] = summary["by_class"].get(ifc_class, 0) + 1
                        summary["objects"].append({
                            "name": obj.name,
                            "guid": getattr(element, 'GlobalId', None),
                            "class": ifc_class
                        })
                    else:
                        summary["non_ifc_objects"] += 1
                        summary["objects"].append({
                            "name": obj.name,
                            "guid": None,
                            "class": "Non-IFC"
                        })
                
                overview["selection_summary"] = summary
        except:
            overview["selection_summary"] = {"success": False, "error": "Failed to get selection"}

    return overview