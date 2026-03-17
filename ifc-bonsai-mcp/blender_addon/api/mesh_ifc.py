"""Dynamic Mesh Generation for IFC using JSON mesh data

This module allows LLMs to provide mesh data in JSON format that is then
converted into IFC objects with any specified IFC class.
"""

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.unit
import ifcopenshell.util.schema
from typing import Dict, Any, Optional, List, Tuple, Union
import math
import traceback
import json
from dataclasses import dataclass
import numpy as np

try:
    import bpy
    import bmesh
    from mathutils import Vector, Matrix
    BLENDER_AVAILABLE = True
except ImportError:
    BLENDER_AVAILABLE = False
    bpy = None
    bmesh = None
    Vector = None
    Matrix = None

from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context,
    calculate_unit_scale, save_and_load_ifc
)
from . import register_command


@dataclass
class MeshItem:
    """A single mesh item with vertices and faces"""
    vertices: List[Tuple[float, float, float]]
    faces: List[List[int]]  # Simple face indices only - no nested arrays

@dataclass 
class MeshData:
    """Mesh data structure for IFC conversion"""
    items: List[MeshItem]
    name: Optional[str] = None
    ifc_class: str = "IfcBuildingElementProxy"
    predefined_type: Optional[str] = None
    placement: Optional[List[List[float]]] = None  # 4x4 matrix
    properties: Optional[Dict[str, Any]] = None
    force_faceted_brep: bool = False


def get_valid_ifc_classes(schema_version: str = "IFC4") -> Dict[str, str]:
    """Get valid IFC element classes for the current schema"""
    try:
        ifc_file = get_ifc_file()
        schema = ifc_file.schema if ifc_file else schema_version

        element_classes = {
            "ROOF": "IfcRoof",
            "WALL": "IfcWall",
            "SLAB": "IfcSlab",
            "BEAM": "IfcBeam",
            "COLUMN": "IfcColumn",
            "STAIR": "IfcStair",
            "RAILING": "IfcRailing",
            "WINDOW": "IfcWindow",
            "DOOR": "IfcDoor",
            "COVERING": "IfcCovering",
            "FURNITURE": "IfcFurniture",
            "ELEMENT": "IfcBuildingElementProxy",
            "SPACE": "IfcSpace",
            "CURTAINWALL": "IfcCurtainWall",
            "MEMBER": "IfcMember",
            "PLATE": "IfcPlate",
            "RAMP": "IfcRamp"
        }

        if schema != "IFC2X3":
            element_classes.update({
                "CHIMNEY": "IfcChimney",
                "SHADINGDEVICE": "IfcShadingDevice",
                "GEOGRAPHICELEMENT": "IfcGeographicElement"
            })
        
        return element_classes
    except:
        return {
            "ELEMENT": "IfcBuildingElementProxy",
            "WALL": "IfcWall",
            "SLAB": "IfcSlab",
            "ROOF": "IfcRoof"
        }

def validate_ifc_class(class_name: str) -> Tuple[bool, str]:
    """Validate and canonicalize IFC class name"""
    valid_classes = get_valid_ifc_classes()
    
    upper = class_name.upper()
    if upper in valid_classes:
        return True, valid_classes[upper]

    if class_name.startswith("Ifc"):
        for key, value in valid_classes.items():
            if value.lower() == class_name.lower():
                return True, value
    
    return False, None


def sanitize_mesh_data(vertices: List[Tuple[float, float, float]], 
                       faces: List[List[int]], 
                       epsilon: float = 1e-6) -> Tuple[List[Tuple[float, float, float]], List[List[int]], List[str]]:
    """
    Sanitize and validate mesh data.
    
    Args:
        vertices: List of vertex coordinates
        faces: List of face indices (simple faces only - no nested arrays)
        epsilon: Tolerance for vertex deduplication
    
    Returns:
        Tuple of (cleaned vertices, cleaned faces, warnings)
        
    Note:
        This function only supports simple faces like [0,1,2,3].
        Nested arrays for faces with holes are NOT supported.
    """
    warnings = []

    vertex_map = {}
    clean_vertices = []
    vertex_remap = {}
    
    for i, v in enumerate(vertices):
        if len(v) == 2:
            v = (float(v[0]), float(v[1]), 0.0)
        elif len(v) == 3:
            v = (float(v[0]), float(v[1]), float(v[2]))
        else:
            warnings.append(f"Invalid vertex at index {i}: must have 2 or 3 coordinates")
            continue

        key = (round(v[0]/epsilon)*epsilon, round(v[1]/epsilon)*epsilon, round(v[2]/epsilon)*epsilon)
        if key not in vertex_map:
            vertex_map[key] = len(clean_vertices)
            clean_vertices.append(v)
        vertex_remap[i] = vertex_map[key]

    clean_faces = []
    for face_idx, face in enumerate(faces):
        if len(face) > 0 and isinstance(face[0], (list, tuple)):
            warnings.append(f"Face {face_idx} contains nested arrays (holes). This is not supported. Use simple face format like [0,1,2,3].")
            continue

        clean_face = []
        for vertex_idx in face:
            if not isinstance(vertex_idx, (int, np.integer)):
                try:
                    vertex_idx = int(vertex_idx)
                except (ValueError, TypeError):
                    warnings.append(f"Face {face_idx} contains non-integer vertex index: {vertex_idx}")
                    continue
            if vertex_idx in vertex_remap:
                remapped_idx = vertex_remap[vertex_idx]
                clean_face.append(int(remapped_idx))
            else:
                warnings.append(f"Face {face_idx} references invalid vertex index: {vertex_idx}")
        
        if len(clean_face) >= 3:
            clean_faces.append(clean_face)
        else:
            warnings.append(f"Face {face_idx} has fewer than 3 valid vertices after cleaning")
    
    return clean_vertices, clean_faces, warnings


def apply_solidify_blender(vertices: List[Tuple[float, float, float]],
                          faces: List[List[int]],
                          thickness: float = 0.1) -> Tuple[List[Tuple[float, float, float]], List[List[int]]]:
    """
    Apply solidification to mesh using Blender (only if available).
    
    Args:
        vertices: Input vertices
        faces: Input faces
        thickness: Solidification thickness
    
    Returns:
        Modified vertices and faces
    """
    if not BLENDER_AVAILABLE:
        return vertices, faces

    mesh = bpy.data.meshes.new("TempSolidify")
    bm = bmesh.new()

    bm_verts = [bm.verts.new(Vector(v)) for v in vertices]
    bm.verts.ensure_lookup_table()

    for face_indices in faces:
        try:
            if isinstance(face_indices[0], list):
                face_indices = face_indices[0]
            face_verts = [bm_verts[i] for i in face_indices if 0 <= i < len(bm_verts)]
            if len(face_verts) >= 3:
                bm.faces.new(face_verts)
        except:
            pass

    if bm.faces:
        bmesh.ops.solidify(bm, geom=bm.faces[:] + bm.edges[:] + bm.verts[:], thickness=thickness)

    result_verts = [(v.co.x, v.co.y, v.co.z) for v in bm.verts]
    result_faces = [[v.index for v in f.verts] for f in bm.faces]
    
    bm.free()
    bpy.data.meshes.remove(mesh)
    
    return result_verts, result_faces


@register_command('create_mesh_ifc', description="Create IFC element from JSON mesh data")
def create_mesh_ifc(
    items: List[Dict[str, Any]],
    ifc_class: str = "IfcBuildingElementProxy",
    name: Optional[str] = None,
    predefined_type: Optional[str] = None,
    placement: Optional[List[List[float]]] = None,
    force_faceted_brep: bool = False,
    apply_solidify: bool = False,
    solidify_thickness: float = 0.1,
    properties: Optional[Dict[str, Any]] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """
    Create an IFC element from JSON mesh data.
    
    This function creates IFC elements from mesh data provided as JSON:
    1. Validates and sanitizes mesh data
    2. Converts the mesh to IFC representation
    3. Assigns it to the specified IFC class
    
    Args:
        items: List of mesh items, each with 'vertices' and 'faces'
        ifc_class: IFC element class name (e.g., "IfcRoof", "IfcWall")
        name: Optional name for the element
        predefined_type: Optional predefined type for the IFC element
        placement: 4x4 transformation matrix
        force_faceted_brep: Use IfcFacetedBrep for closed meshes
        apply_solidify: Whether to apply solidification (Blender only)
        solidify_thickness: Thickness for solidification
        properties: Additional properties to store in property set
        verbose: Print debug information
    
    Returns:
        Dict with success status, element GUID, and any errors/warnings
    
    Example items:
        [
            {
                "vertices": [[0,0,0], [1,0,0], [1,1,0], [0,1,0]],
                "faces": [[0,1,2,3]]  # Simple quad
            }
        ]
    """
    try:
        warnings = []

        is_valid, canonical_class = validate_ifc_class(ifc_class)
        if not is_valid:
            return {
                "success": False,
                "error": f"Invalid IFC class: {ifc_class}",
                "warnings": []
            }

        if name is None:
            name = f"{canonical_class}_Generated"

        processed_items = []
        total_verts = 0
        total_faces = 0
        
        for item in items:
            vertices = item.get("vertices", [])
            faces = item.get("faces", [])
            
            if not vertices:
                warnings.append("Item with no vertices skipped")
                continue

            clean_verts, clean_faces, item_warnings = sanitize_mesh_data(vertices, faces)
            warnings.extend(item_warnings)
            
            if not clean_verts:
                warnings.append("Item with invalid vertices skipped")
                continue

            if apply_solidify and solidify_thickness > 0 and BLENDER_AVAILABLE:
                clean_verts, clean_faces = apply_solidify_blender(
                    clean_verts, clean_faces, solidify_thickness
                )
            
            processed_items.append({
                "vertices": clean_verts,
                "faces": clean_faces
            })
            total_verts += len(clean_verts)
            total_faces += len(clean_faces)
        
        if not processed_items:
            return {
                "success": False,
                "error": "No valid mesh items to process",
                "warnings": warnings
            }
        
        if verbose:
            print(f"Processing {len(processed_items)} mesh items ({total_verts} vertices, {total_faces} faces)")

        ifc_file = get_ifc_file()
        container = get_default_container()
        body_context = get_or_create_body_context(ifc_file)

        element = ifcopenshell.api.run(
            "root.create_entity",
            ifc_file,
            ifc_class=canonical_class,
            name=name,
            predefined_type=predefined_type
        )

        ifcopenshell.api.run(
            "spatial.assign_container",
            ifc_file,
            products=[element],
            relating_structure=container
        )

        vertices_lists = [item["vertices"] for item in processed_items]
        faces_lists = [item["faces"] for item in processed_items]

        mesh_representation = ifcopenshell.api.run(
            "geometry.add_mesh_representation",
            ifc_file,
            context=body_context,
            vertices=vertices_lists,
            faces=faces_lists if faces_lists else None,
            force_faceted_brep=force_faceted_brep
        )

        ifcopenshell.api.run(
            "geometry.assign_representation",
            ifc_file,
            product=element,
            representation=mesh_representation
        )

        if placement:
            ifcopenshell.api.run(
                "geometry.edit_object_placement",
                ifc_file,
                product=element,
                matrix=placement
            )

        pset = ifcopenshell.api.run(
            "pset.add_pset",
            ifc_file,
            product=element,
            name="Pset_MeshGeneration"
        )
        
        pset_data = {
            "GenerationMethod": "JSON_MESH",
            "ItemCount": len(processed_items),
            "TotalVertexCount": total_verts,
            "TotalFaceCount": total_faces,
            "Solidified": str(apply_solidify and BLENDER_AVAILABLE)
        }
        
        if apply_solidify and BLENDER_AVAILABLE:
            pset_data["SolidifyThickness"] = solidify_thickness

        if properties:
            pset_data.update(properties)
        
        ifcopenshell.api.run(
            "pset.edit_pset",
            ifc_file,
            pset=pset,
            properties=pset_data
        )

        save_and_load_ifc()
        
        result = {
            "success": True,
            "element_guid": element.GlobalId,
            "element_name": name,
            "ifc_class": canonical_class,
            "item_count": len(processed_items),
            "total_vertices": total_verts,
            "total_faces": total_faces,
            "warnings": warnings
        }
        
        if verbose:
            print(f"Successfully created {canonical_class} '{name}' with GUID: {element.GlobalId}")
            if warnings:
                print(f"Warnings: {', '.join(warnings)}")
        
        return result
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "warnings": [traceback.format_exc()] if verbose else []
        }


@register_command('list_ifc_entities', description="List valid IFC entity classes for the current schema")
def list_ifc_entities(schema_version: Optional[str] = None) -> Dict[str, Any]:
    """
    List valid IFC entity classes for mesh generation.
    
    Args:
        schema_version: Optional schema version (IFC2X3, IFC4, etc.)
    
    Returns:
        Dict with schema info and entity list
    """
    try:
        ifc_file = get_ifc_file()
        schema = schema_version or (ifc_file.schema if ifc_file else "IFC4")
        entities = get_valid_ifc_classes(schema)
        
        return {
            "success": True,
            "schema": schema,
            "entities": list(entities.values()),
            "short_names": list(entities.keys())
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

@register_command('generate_parametric_mesh', description="Generate parametric mesh data for common shapes")
def generate_parametric_mesh(
    shape: str = "box",
    width: float = 1.0,
    length: float = 1.0,
    height: float = 1.0,
    segments: int = 10,
    parameters: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Generate parametric mesh data for common shapes.
    
    Args:
        shape: Shape type (box, cylinder, dome, vault, etc.)
        width: Width of the shape
        length: Length of the shape
        height: Height of the shape
        segments: Number of segments for curved surfaces
        parameters: Additional shape-specific parameters
    
    Returns:
        Mesh data ready for create_mesh_ifc
    """
    try:
        vertices = []
        faces = []
        
        if shape.lower() == "box":
            vertices = [
                (0, 0, 0), (width, 0, 0), (width, length, 0), (0, length, 0),
                (0, 0, height), (width, 0, height), (width, length, height), (0, length, height)
            ]
            faces = [
                [0, 1, 2, 3],
                [4, 7, 6, 5],
                [0, 4, 5, 1],
                [2, 6, 7, 3],
                [0, 3, 7, 4],
                [1, 5, 6, 2]
            ]
        
        elif shape.lower() == "cylinder":
            radius = min(width, length) / 2
            for i in range(segments):
                angle = 2 * math.pi * i / segments
                x = radius * math.cos(angle) + width/2
                y = radius * math.sin(angle) + length/2
                vertices.append((x, y, 0))
                vertices.append((x, y, height))

            for i in range(segments):
                next_i = (i + 1) % segments
                faces.append([i*2, next_i*2, next_i*2+1, i*2+1])

            bottom_verts = list(range(0, segments*2, 2))
            top_verts = list(range(1, segments*2, 2))
            faces.append(bottom_verts)
            faces.append(top_verts[::-1])
        
        elif shape.lower() == "dome":
            radius = min(width, length) / 2
            segments_u = segments * 2
            segments_v = segments
            
            for v in range(segments_v + 1):
                phi = math.pi * v / segments_v / 2
                for u in range(segments_u):
                    theta = 2 * math.pi * u / segments_u
                    x = radius * math.sin(phi) * math.cos(theta) + width/2
                    y = radius * math.sin(phi) * math.sin(theta) + length/2
                    z = height * math.cos(phi)
                    vertices.append((x, y, z))

            for v in range(segments_v):
                for u in range(segments_u):
                    v1 = v * segments_u + u
                    v2 = v * segments_u + (u + 1) % segments_u
                    v3 = (v + 1) * segments_u + (u + 1) % segments_u
                    v4 = (v + 1) * segments_u + u
                    if v < segments_v - 1:
                        faces.append([v1, v2, v3, v4])
                    else:
                        faces.append([v1, v2, v3])
        
        elif shape.lower() == "vault":
            segments_width = segments
            segments_length = segments * 2
            
            for i in range(segments_length + 1):
                x = length * i / segments_length
                for j in range(segments_width + 1):
                    angle = math.pi * j / segments_width
                    y = width * j / segments_width
                    z = height * math.sin(angle)
                    vertices.append((x, y, z))

            for i in range(segments_length):
                for j in range(segments_width):
                    v1 = i * (segments_width + 1) + j
                    v2 = v1 + 1
                    v3 = (i + 1) * (segments_width + 1) + j + 1
                    v4 = v3 - 1
                    faces.append([v1, v2, v3, v4])
        
        else:
            return generate_parametric_mesh("box", width, length, height, segments, parameters)
        
        return {
            "success": True,
            "items": [{
                "vertices": vertices,
                "faces": faces
            }],
            "shape": shape,
            "parameters": {
                "width": width,
                "length": length,
                "height": height,
                "segments": segments
            }
        }
    
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


def get_mesh_examples() -> Dict[str, Any]:
    """
    Get example mesh data in JSON format for various object types.
    
    Returns:
        Dictionary with example JSON mesh data
    """
    
    examples = {
        "simple_box": {
            "description": "Simple box with 6 faces",
            "data": {
                "items": [{
                    "vertices": [
                        [0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0],
                        [0, 0, 1], [2, 0, 1], [2, 3, 1], [0, 3, 1]
                    ],
                    "faces": [
                        [0, 1, 2, 3],
                        [4, 7, 6, 5],
                        [0, 4, 5, 1],
                        [2, 6, 7, 3],
                        [0, 3, 7, 4],
                        [1, 5, 6, 2]
                    ]
                }],
                "ifc_class": "IfcWall",
                "name": "SimpleBox"
            }
        },
        
        "triangle": {
            "description": "Simple triangle face",
            "data": {
                "items": [{
                    "vertices": [[0, 0, 0], [2, 0, 0], [1, 0, 2]],
                    "faces": [[0, 1, 2]]
                }],
                "ifc_class": "IfcRoof",
                "name": "Triangle"
            }
        },
        
        "quad_face": {
            "description": "Simple quad face",
            "data": {
                "items": [{
                    "vertices": [[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]],
                    "faces": [[0, 1, 2, 3]]
                }],
                "ifc_class": "IfcWall",
                "name": "WallSection"
            }
        },
        
        "multi_item_roof": {
            "description": "Roof with multiple separate parts",
            "data": {
                "items": [
                    {
                        "vertices": [[0,0,2], [5,0,3], [5,5,3], [0,5,2]],
                        "faces": [[0,1,2,3]]
                    },
                    {
                        "vertices": [[5,0,3], [10,0,2], [10,5,2], [5,5,3]],
                        "faces": [[0,1,2,3]]
                    }
                ],
                "ifc_class": "IfcRoof",
                "name": "GableRoof"
            }
        }
    }
    
    return {
        "success": True,
        "examples": examples,
        "usage": "Use these JSON structures with create_mesh_ifc function",
        "face_format_info": {
            "supported": "Simple face format: [0,1,2,3] where numbers are vertex indices",
            "not_supported": "Nested arrays for holes: [[0,1,2,3], [4,5,6,7]] - This will cause errors",
            "alternatives_for_openings": [
                "Create separate geometry pieces (frame and opening)",
                "Use boolean operations after creation", 
                "Model opening as separate negative geometry"
            ]
        },
        "tips": [
            "Each face needs at least 3 vertices",
            "Vertices are indexed starting from 0",
            "Face vertex order determines surface normal direction",
            "Use right-hand rule for consistent normals"
        ]
    }