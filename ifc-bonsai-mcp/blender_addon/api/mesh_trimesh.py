"""Trimesh-based mesh generation for IFC objects.

This module provides a bridge between Trimesh 3D mesh generation and IFC (Industry Foundation Classes)
building elements. It allows dynamic creation of complex geometries through Python code execution
and automatic conversion to IFC representations.

Key Features:
    - Execute Trimesh Python code to generate 3D meshes
    - Convert meshes to IFC building elements (walls, slabs, columns, etc.)
    - Support for boolean operations and transformations
    - Mesh validation and property extraction
    - Example code library for common building elements

Requirements:
    - trimesh: For mesh generation and manipulation
    - ifcopenshell: For IFC file creation and management
    - numpy: For numerical operations
"""
import ifcopenshell
import ifcopenshell.api
from typing import Dict, Any, Optional, List, Tuple, Union
import traceback
import tempfile
import os
import sys
import numpy as np
from dataclasses import dataclass

try:
    import trimesh
    import trimesh.primitives
    import trimesh.transformations
    import trimesh.creation
    TRIMESH_AVAILABLE = True
except ImportError:
    TRIMESH_AVAILABLE = False
    trimesh = None

from .ifc_utils import (
    get_ifc_file, get_default_container, get_or_create_body_context,
    calculate_unit_scale, save_and_load_ifc
)
from . import register_command


@dataclass
class TrimeshResult:
    """Result from Trimesh code execution"""
    success: bool
    mesh: Optional[Any] = None  # Trimesh object
    vertices: Optional[List[Tuple[float, float, float]]] = None
    faces: Optional[List[List[int]]] = None
    error: Optional[str] = None
    code_executed: Optional[str] = None
    warnings: List[str] = None


def execute_trimesh_code(code: str, 
                        parameters: Optional[Dict[str, Any]] = None,
                        timeout: int = 30) -> TrimeshResult:
    """
    Execute Trimesh code safely and extract mesh data.
    
    Args:
        code: Trimesh Python code to execute
        parameters: Optional parameters to inject into code execution namespace
        timeout: Execution timeout in seconds
    
    Returns:
        TrimeshResult with mesh and vertex/face data or error information
    """
    if not TRIMESH_AVAILABLE:
        return TrimeshResult(
            success=False,
            error="Trimesh is not available. Please install with: pip install trimesh"
        )
    
    warnings = []
    
    try:
        import io
        import contextlib

        captured_output = io.StringIO()

        namespace = {
            'trimesh': trimesh,
            'np': np,
            'numpy': np,
            '__builtins__': __builtins__,
            'math': __import__('math'),
        }

        if parameters:
            namespace.update(parameters)

        with contextlib.redirect_stdout(captured_output):
            exec(code, namespace)

        output_text = captured_output.getvalue()
        if output_text.strip():
            warnings.append(f"Code produced output: {output_text.strip()[:200]}...")

        result_mesh = None
        possible_names = ['result', 'mesh', 'shape', 'geometry', 'obj']
        
        for name in possible_names:
            if name in namespace:
                candidate = namespace[name]
                if hasattr(candidate, 'vertices') and hasattr(candidate, 'faces'):
                    result_mesh = candidate
                    break

        if result_mesh is None:
            for key, value in namespace.items():
                if hasattr(value, 'vertices') and hasattr(value, 'faces'):
                    result_mesh = value
                    warnings.append(f"Using variable '{key}' as result mesh")
                    break
        
        if result_mesh is None:
            return TrimeshResult(
                success=False,
                error="No Trimesh object found in result. Make sure to assign your mesh to a variable like 'result'.",
                code_executed=code,
                warnings=warnings
            )

        vertices, faces = extract_mesh_from_trimesh(result_mesh)
        
        return TrimeshResult(
            success=True,
            mesh=result_mesh,
            vertices=vertices,
            faces=faces,
            code_executed=code,
            warnings=warnings
        )
        
    except Exception as e:
        return TrimeshResult(
            success=False,
            error=f"Error executing Trimesh code: {str(e)}",
            code_executed=code,
            warnings=warnings
        )


def extract_mesh_from_trimesh(mesh_obj) -> Tuple[List[Tuple[float, float, float]], List[List[int]]]:
    """
    Extract mesh data (vertices and faces) from a Trimesh object.
    
    Args:
        mesh_obj: Trimesh object (mesh, primitive, or scene)
    
    Returns:
        Tuple of (vertices, faces) lists
    """
    try:
        if hasattr(mesh_obj, 'dump'):
            if len(mesh_obj.geometry) == 1:
                mesh = list(mesh_obj.geometry.values())[0]
            else:
                mesh = trimesh.util.concatenate(list(mesh_obj.geometry.values()))
        else:
            mesh = mesh_obj

        if not hasattr(mesh, 'vertices') or not hasattr(mesh, 'faces'):
            raise Exception("Object does not have vertices and faces attributes")

        vertices = [(float(v[0]), float(v[1]), float(v[2])) for v in mesh.vertices]
        # Convert numpy ints to Python ints for IFC serialization
        faces = [[int(idx.item()) if hasattr(idx, 'item') else int(idx) for idx in face] for face in mesh.faces]
        
        return vertices, faces
        
    except Exception as e:
        raise Exception(f"Failed to extract mesh from Trimesh object: {str(e)}")


def check_code_for_print_statements(code: str) -> List[str]:
    """Check if code contains print statements that could interfere with JSON responses."""
    warnings = []
    lines = code.split('\n')
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped and not stripped.startswith('#'):
            if 'print(' in line:
                warnings.append(f"Line {i}: Contains print() statement that will interfere with MCP JSON responses")
    return warnings


def validate_trimesh_mesh(mesh_obj) -> Tuple[bool, str]:
    """
    Validate a Trimesh object for common issues.
    
    Args:
        mesh_obj: Trimesh object to validate
    
    Returns:
        Tuple of (is_valid, message)
    """
    try:
        if not hasattr(mesh_obj, 'vertices') or not hasattr(mesh_obj, 'faces'):
            return False, "Object does not have vertices and faces attributes"
        
        if len(mesh_obj.vertices) == 0:
            return False, "Mesh has no vertices"
        
        if len(mesh_obj.faces) == 0:
            return False, "Mesh has no faces"

        if hasattr(mesh_obj, 'is_valid') and not mesh_obj.is_valid:
            return False, "Mesh contains degenerate faces"

        if hasattr(mesh_obj, 'is_watertight'):
            if not mesh_obj.is_watertight:
                return True, "Warning: Mesh is not watertight"
        
        return True, "Mesh is valid"
        
    except Exception as e:
        return False, f"Error validating mesh: {str(e)}"


@register_command('create_trimesh_ifc', description="Create IFC element from Trimesh Python code")
def create_trimesh_ifc(
    trimesh_code: str,
    ifc_class: str = "IfcBuildingElementProxy",
    name: Optional[str] = None,
    predefined_type: Optional[str] = None,
    placement: Optional[List[List[float]]] = None,
    parameters: Optional[Dict[str, Any]] = None,
    properties: Optional[Dict[str, Any]] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """
    Create an IFC element from Trimesh Python code.
    
    This function executes Trimesh code to generate 3D geometry, extracts mesh data,
    and creates an IFC element using the mesh representation.
    
    IMPORTANT: To avoid JSON parsing errors, follow these guidelines:
    1. Avoid print() statements in your Trimesh code - they interfere with MCP responses
    2. Always assign your final mesh to a variable named 'result'
    3. Use comments instead of print statements for documentation
    4. If you need debugging output, use return values or properties instead
    
    Args:
        trimesh_code: Python code using Trimesh to create geometry (avoid print statements!)
        ifc_class: IFC element class name (e.g., "IfcWall", "IfcSlab", "IfcRoof")
        name: Optional name for the element
        predefined_type: Optional predefined type for the IFC element
        placement: 4x4 transformation matrix
        parameters: Optional parameters to inject into code execution
        properties: Additional properties to store in property set
        verbose: Include debug information in response (not printed to console)
    
    Returns:
        Dict with success status, element GUID, mesh info, and any errors/warnings
    
    Example trimesh_code (GOOD - no print statements):
        ```python
        import trimesh
        
        # Create a box
        result = trimesh.primitives.Box(extents=[10, 5, 3])
        ```
        
        ```python
        # Create a wall with window opening
        wall = trimesh.primitives.Box(extents=[5, 0.2, 3])
        window = trimesh.primitives.Box(extents=[1.5, 0.3, 1.5])
        window.apply_translation([0, 0, 1])
        result = wall.difference(window)
        ```
        
        ```python
        # Create I-beam (GOOD - uses comments instead of prints)
        import trimesh
        
        # I-Beam parameters
        beam_length = 10.0
        beam_height = 0.4
        flange_width = 0.25
        web_thickness = 0.012
        flange_thickness = 0.02
        
        # Create flanges and web
        top_flange = trimesh.primitives.Box(extents=[flange_width, beam_length, flange_thickness])
        top_flange.apply_translation([0, 0, beam_height/2 - flange_thickness/2])
        
        bottom_flange = trimesh.primitives.Box(extents=[flange_width, beam_length, flange_thickness])
        bottom_flange.apply_translation([0, 0, -beam_height/2 + flange_thickness/2])
        
        web = trimesh.primitives.Box(extents=[web_thickness, beam_length, beam_height - 2*flange_thickness])
        
        # Combine parts
        result = top_flange.union(bottom_flange).union(web)
        ```
        
    Example trimesh_code (BAD - will cause JSON errors):
        ```python
        import trimesh
        
        # DON'T DO THIS - print statements cause JSON parsing errors
        print("Creating beam...")  # This breaks MCP communication!
        result = trimesh.primitives.Box(extents=[10, 5, 3])
        print(f"Created beam with {len(result.vertices)} vertices")  # This too!
        ```
    """
    try:
        if not TRIMESH_AVAILABLE:
            return {
                "success": False,
                "error": "Trimesh is not available. Please install with: pip install trimesh",
                "warnings": []
            }

        from .mesh_ifc import validate_ifc_class
        is_valid, canonical_class = validate_ifc_class(ifc_class)
        if not is_valid:
            return {
                "success": False,
                "error": f"Invalid IFC class: {ifc_class}",
                "warnings": []
            }

        if name is None:
            name = f"{canonical_class}_Trimesh"

        print_warnings = check_code_for_print_statements(trimesh_code)
        if print_warnings:
            return {
                "success": False,
                "error": "Code contains print() statements that will cause JSON parsing errors",
                "print_warnings": print_warnings,
                "fix_suggestion": "Remove all print() statements and replace with comments (#)",
                "code_preview": trimesh_code[:200] + "..." if len(trimesh_code) > 200 else trimesh_code
            }

        debug_info = []
        if verbose:
            debug_info.append(f"Executing Trimesh code for {canonical_class}")
            debug_info.append(f"Code length: {len(trimesh_code)} characters")

        result = execute_trimesh_code(trimesh_code, parameters)
        
        if not result.success:
            return {
                "success": False,
                "error": result.error,
                "code_executed": result.code_executed,
                "warnings": result.warnings or [],
                "debug_info": debug_info if verbose else None
            }
        
        vertices = result.vertices
        faces = result.faces
        warnings = result.warnings or []
        
        if not vertices:
            return {
                "success": False,
                "error": "No mesh data generated from Trimesh code",
                "code_executed": result.code_executed,
                "warnings": warnings,
                "debug_info": debug_info if verbose else None
            }

        is_valid, validation_msg = validate_trimesh_mesh(result.mesh)
        if not is_valid:
            return {
                "success": False,
                "error": f"Generated mesh is invalid: {validation_msg}",
                "code_executed": result.code_executed,
                "warnings": warnings,
                "debug_info": debug_info if verbose else None
            }
        elif "Warning" in validation_msg:
            warnings.append(validation_msg)
        
        if verbose:
            debug_info.append(f"Generated mesh: {len(vertices)} vertices, {len(faces)} faces")
            debug_info.append(f"Validation: {validation_msg}")

        ifc_file = get_ifc_file()
        container = get_default_container()
        body_context = get_or_create_body_context(ifc_file)

        import ifcopenshell.api
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

        mesh_representation = ifcopenshell.api.run(
            "geometry.add_mesh_representation",
            ifc_file,
            context=body_context,
            vertices=[vertices],
            faces=[faces] if faces else None
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
            name="Pset_TrimeshGeneration"
        )
        
        pset_data = {
            "GenerationMethod": "TRIMESH_CODE",
            "VertexCount": len(vertices),
            "FaceCount": len(faces),
            "IsWatertight": getattr(result.mesh, 'is_watertight', False),
            "Volume": getattr(result.mesh, 'volume', 0.0)
        }

        if properties:
            pset_data.update(properties)
        
        ifcopenshell.api.run(
            "pset.edit_pset",
            ifc_file,
            pset=pset,
            properties=pset_data
        )

        save_and_load_ifc()
        
        if verbose:
            debug_info.append(f"Successfully created {canonical_class} '{name}' with GUID: {element.GlobalId}")
            if warnings:
                debug_info.append(f"Warnings: {', '.join(warnings)}")

        result_data = {
            "success": True,
            "element_guid": element.GlobalId,
            "element_name": name,
            "ifc_class": canonical_class,
            "vertex_count": len(vertices),
            "face_count": len(faces),
            "code_executed": result.code_executed,
            "warnings": warnings,
            "is_watertight": getattr(result.mesh, 'is_watertight', False),
            "volume": getattr(result.mesh, 'volume', 0.0),
            "debug_info": debug_info if verbose else None
        }
        
        return result_data
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc() if verbose else None,
            "warnings": [],
            "debug_info": debug_info if verbose else None
        }


def check_code_for_print_statements(code: str) -> List[str]:
    """
    Check Trimesh code for problematic print statements that will cause JSON errors.
    
    Args:
        code: Python code to check
        
    Returns:
        List of warnings about print statements found
    """
    warnings = []
    lines = code.split('\n')
    
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith('print(') or 'print(' in stripped:
            warnings.append(f"Line {i}: Found print() statement - this will cause JSON parsing errors!")
    
    return warnings


@register_command('validate_trimesh_code', description="Validate Trimesh code without creating IFC")
def validate_trimesh_code(
    trimesh_code: str,
    parameters: Optional[Dict[str, Any]] = None,
    extract_mesh: bool = True
) -> Dict[str, Any]:
    """
    Validate Trimesh code and optionally extract mesh information.
    
    Args:
        trimesh_code: Python code using Trimesh to create geometry
        parameters: Optional parameters to inject into code execution
        extract_mesh: Whether to extract mesh data for validation
    
    Returns:
        Dict with validation results, mesh info, and any errors/warnings
    """
    try:
        if not TRIMESH_AVAILABLE:
            return {
                "success": False,
                "error": "Trimesh is not available. Please install with: pip install trimesh"
            }

        print_warnings = check_code_for_print_statements(trimesh_code)
        if print_warnings:
            return {
                "success": False,
                "error": "Code contains print() statements that will cause JSON parsing errors",
                "print_warnings": print_warnings,
                "fix_suggestion": "Remove all print() statements and replace with comments (#)"
            }

        result = execute_trimesh_code(trimesh_code, parameters)
        
        if not result.success:
            return {
                "success": False,
                "error": result.error,
                "code_executed": result.code_executed,
                "warnings": result.warnings or []
            }
        
        response = {
            "success": True,
            "code_executed": result.code_executed,
            "warnings": result.warnings or [],
            "mesh_found": result.mesh is not None
        }

        if extract_mesh and result.vertices:
            is_valid, validation_msg = validate_trimesh_mesh(result.mesh)
            
            response.update({
                "vertex_count": len(result.vertices),
                "face_count": len(result.faces) if result.faces else 0,
                "mesh_extracted": True,
                "mesh_valid": is_valid,
                "validation_message": validation_msg,
                "is_watertight": getattr(result.mesh, 'is_watertight', False),
                "volume": getattr(result.mesh, 'volume', 0.0),
                "surface_area": getattr(result.mesh, 'area', 0.0)
            })
        else:
            response["mesh_extracted"] = False
        
        return response
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


@register_command('get_trimesh_examples', description="Get example Trimesh code for various shapes")
def get_trimesh_examples() -> Dict[str, Any]:
    """
    Get example Trimesh code for various architectural and building elements.
    
    Returns:
        Dict with example code snippets for different shape types
    """
    
    examples = {
        "simple_box": {
            "description": "Simple rectangular box/beam",
            "code": '''import trimesh

result = trimesh.primitives.Box(extents=[10, 5, 3])''',
            "ifc_class": "IfcBeam"
        },
        
        "wall_with_opening": {
            "description": "Wall with window opening using boolean difference",
            "code": '''import trimesh

wall = trimesh.primitives.Box(extents=[5, 0.2, 3])
window = trimesh.primitives.Box(extents=[1.5, 0.3, 1.5])
window.apply_translation([0, 0, 1])
result = wall.difference(window)''',
            "ifc_class": "IfcWall"
        },
        
        "l_shaped_extrusion": {
            "description": "L-shaped wall using polygon extrusion",
            "code": '''import trimesh
import numpy as np

points = np.array([
    [0, 0], [5, 0], [5, 2], [2, 2], [2, 5], [0, 5]
])
result = trimesh.creation.extrude_polygon(points, height=3)''',
            "ifc_class": "IfcWall"
        },
        
        "cylinder_column": {
            "description": "Cylindrical column",
            "code": '''import trimesh

result = trimesh.primitives.Cylinder(radius=0.3, height=8)''',
            "ifc_class": "IfcColumn"
        },
        
        "column_with_capital": {
            "description": "Column with wider capital on top",
            "code": '''import trimesh

shaft = trimesh.primitives.Cylinder(radius=0.3, height=8)
capital = trimesh.primitives.Cylinder(radius=0.5, height=0.5)
capital.apply_translation([0, 0, 4.25])
result = shaft.union(capital)''',
            "ifc_class": "IfcColumn"
        },
        
        "stepped_foundation": {
            "description": "Stepped foundation slab",
            "code": '''import trimesh

base = trimesh.primitives.Box(extents=[10, 10, 0.5])
step1 = trimesh.primitives.Box(extents=[8, 8, 0.3])
step1.apply_translation([0, 0, 0.4])
step2 = trimesh.primitives.Box(extents=[6, 6, 0.3])
step2.apply_translation([0, 0, 0.7])
result = base.union(step1).union(step2)''',
            "ifc_class": "IfcSlab"
        },
        
        "sphere": {
            "description": "Spherical element",
            "code": '''import trimesh

result = trimesh.primitives.Sphere(radius=2.0)''',
            "ifc_class": "IfcBuildingElementProxy"
        },
        
        "capsule": {
            "description": "Capsule-shaped element",
            "code": '''import trimesh

result = trimesh.primitives.Capsule(radius=1.0, height=5.0)''',
            "ifc_class": "IfcBuildingElementProxy"
        },
        
        "custom_mesh": {
            "description": "Custom mesh from vertices and faces",
            "code": '''import trimesh
import numpy as np

vertices = np.array([
    [0, 0, 0],
    [2, 0, 0],
    [1, 2, 0],
    [0, 0, 3],
    [2, 0, 3],
    [1, 2, 3]
])

faces = np.array([
    [0, 1, 2],
    [3, 5, 4],
    [0, 3, 4],
    [0, 4, 1],
    [1, 4, 5],
    [1, 5, 2],
    [2, 5, 3],
    [2, 3, 0]
])

result = trimesh.Trimesh(vertices=vertices, faces=faces)''',
            "ifc_class": "IfcBeam"
        },
        
        "boolean_operations": {
            "description": "Complex shape using multiple boolean operations",
            "code": '''import trimesh

base = trimesh.primitives.Box(extents=[6, 4, 2])
hole1 = trimesh.primitives.Cylinder(radius=0.5, height=3)
hole1.apply_translation([-1.5, 0, 0])
hole2 = trimesh.primitives.Cylinder(radius=0.5, height=3)
hole2.apply_translation([1.5, 0, 0])
result = base.difference(hole1).difference(hole2)''',
            "ifc_class": "IfcBeam"
        },
        
        "i_beam_correct": {
            "description": "I-beam without print statements (CORRECT approach)",
            "code": '''import trimesh

beam_length = 10.0
beam_height = 0.4
flange_width = 0.25
web_thickness = 0.012
flange_thickness = 0.02

top_flange = trimesh.primitives.Box(extents=[flange_width, beam_length, flange_thickness])
top_flange.apply_translation([0, 0, beam_height/2 - flange_thickness/2])

bottom_flange = trimesh.primitives.Box(extents=[flange_width, beam_length, flange_thickness])
bottom_flange.apply_translation([0, 0, -beam_height/2 + flange_thickness/2])

web = trimesh.primitives.Box(extents=[web_thickness, beam_length, beam_height - 2*flange_thickness])

result = top_flange.union(bottom_flange).union(web)

end_plate_thickness = web_thickness * 2
end_plate_1 = trimesh.primitives.Box(extents=[flange_width, end_plate_thickness, beam_height])
end_plate_1.apply_translation([0, beam_length/2 - end_plate_thickness/2, 0])

end_plate_2 = trimesh.primitives.Box(extents=[flange_width, end_plate_thickness, beam_height])
end_plate_2.apply_translation([0, -beam_length/2 + end_plate_thickness/2, 0])

result = result.union(end_plate_1).union(end_plate_2)''',
            "ifc_class": "IfcBeam"
        },
        
        "rotated_element": {
            "description": "Rotated and translated element",
            "code": '''import trimesh
import numpy as np

box = trimesh.primitives.Box(extents=[4, 2, 1])
rotation_matrix = trimesh.transformations.rotation_matrix(
    np.radians(45), [0, 0, 1]
)
box.apply_transform(rotation_matrix)
box.apply_translation([2, 2, 1])
result = box''',
            "ifc_class": "IfcBeam"
        },
        
        "mesh_from_points": {
            "description": "Create mesh from point cloud (convex hull)",
            "code": '''import trimesh
import numpy as np

np.random.seed(42)
points = np.random.rand(20, 3) * 5
result = trimesh.convex.convex_hull(points)''',
            "ifc_class": "IfcBuildingElementProxy"
        }
    }
    
    return {
        "success": True,
        "examples": examples,
        "trimesh_info": {
            "installation": "pip install trimesh",
            "documentation": "https://trimesh.org/",
            "key_concepts": [
                "Primitives: Built-in shapes (Box, Cylinder, Sphere, etc.)",
                "Boolean operations: union(), difference(), intersection()",
                "Transformations: apply_translation(), apply_transform()",
                "Mesh creation: From vertices/faces or procedural generation",
                "Validation: Built-in mesh validation and repair"
            ]
        },
        "common_patterns": {
            "basic_box": "trimesh.primitives.Box(extents=[width, depth, height])",
            "cylinder": "trimesh.primitives.Cylinder(radius=r, height=h)",
            "sphere": "trimesh.primitives.Sphere(radius=r)",
            "extrusion": "trimesh.creation.extrude_polygon(points, height=h)",
            "boolean_union": "mesh1.union(mesh2)",
            "boolean_difference": "mesh1.difference(mesh2)",
            "translate": "mesh.apply_translation([x, y, z])",
            "rotate": "mesh.apply_transform(rotation_matrix)"
        },
        "tips": [
            "CRITICAL: NEVER use print() statements - they break MCP communication!",
            "Always assign your final mesh to a variable named 'result'",
            "Use comments (#) instead of print() for documentation",
            "Use trimesh.primitives for basic shapes",
            "Boolean operations work on watertight meshes",
            "Check mesh.is_watertight for valid geometry",
            "Use mesh.volume and mesh.area for properties",
            "Transformations are applied in-place with apply_* methods",
            "Coordinate system: X=width, Y=depth, Z=height",
            "Use verbose=True parameter to get debug info in response"
        ],
        "common_errors": {
            "json_parsing_error": {
                "symptoms": "Unexpected token errors, 'is not valid JSON'",
                "cause": "print() statements in Trimesh code",
                "solution": "Remove ALL print() statements, use comments instead"
            },
            "no_result_variable": {
                "symptoms": "No Trimesh object found in result",
                "cause": "Final mesh not assigned to 'result' variable",
                "solution": "Always end with: result = your_mesh"
            },
            "invalid_mesh": {
                "symptoms": "Generated mesh is invalid",
                "cause": "Degenerate faces or empty geometry",
                "solution": "Check mesh.is_valid and use simpler primitives"
            }
        }
    }


def get_trimesh_help() -> str:
    """Get help text for Trimesh usage in IFC context."""
    
    return """
Trimesh for IFC Generation - Quick Reference

Trimesh is a pure Python library for loading and using triangular meshes,
perfect for creating building geometry with direct mesh control.

## CRITICAL: Avoid JSON Parsing Errors
NEVER use print() statements in your Trimesh code - they cause MCP communication failures!
Use comments (#) for documentation instead of print() statements
Always assign your final mesh to a variable named 'result'

## Basic Structure (CORRECT)
```python
import trimesh

result = trimesh.primitives.Box(extents=[10, 5, 3])
```

## Common Error (INCORRECT - Will Break)
```python
import trimesh

print("Creating box...")
result = trimesh.primitives.Box(extents=[10, 5, 3])
print(f"Created {len(result.vertices)} vertices")
```

## Common Building Elements

### Walls
```python
result = trimesh.primitives.Box(extents=[5, 0.2, 3])

wall = trimesh.primitives.Box(extents=[5, 0.2, 3])
opening = trimesh.primitives.Box(extents=[1.5, 0.25, 1.5])
opening.apply_translation([0, 0, 1])
result = wall.difference(opening)
```

### Slabs/Floors
```python
result = trimesh.primitives.Box(extents=[10, 8, 0.3])

slab = trimesh.primitives.Box(extents=[10, 8, 0.3])
opening = trimesh.primitives.Box(extents=[2, 2, 0.4])
opening.apply_translation([2, 2, 0])
result = slab.difference(opening)
```

### Roofs
```python
import numpy as np
points = np.array([[0, 0], [10, 0], [5, 3]])
result = trimesh.creation.extrude_polygon(points, height=12)

vertices = np.array([...])
faces = np.array([...])
result = trimesh.Trimesh(vertices=vertices, faces=faces)
```

### Beams/Columns
```python
result = trimesh.primitives.Box(extents=[6, 0.3, 0.5])

result = trimesh.primitives.Cylinder(radius=0.25, height=8)
```

## Key Primitives

- `trimesh.primitives.Box(extents=[w, d, h])` - Rectangular box
- `trimesh.primitives.Cylinder(radius=r, height=h)` - Cylinder
- `trimesh.primitives.Sphere(radius=r)` - Sphere
- `trimesh.primitives.Capsule(radius=r, height=h)` - Rounded cylinder
- `trimesh.creation.extrude_polygon(points, height)` - Extrude 2D polygon

## Key Operations

- `.union(other)` - Boolean addition
- `.difference(other)` - Boolean subtraction  
- `.intersection(other)` - Boolean intersection
- `.apply_translation([x, y, z])` - Move mesh
- `.apply_transform(matrix)` - Apply 4x4 transformation matrix
- `.apply_scale(factor)` - Scale mesh uniformly

## Transformations
```python
import numpy as np

mesh.apply_translation([2, 0, 1])

rotation = trimesh.transformations.rotation_matrix(
    np.radians(45), [0, 0, 1]
)
mesh.apply_transform(rotation)

mesh.apply_scale(1.5)
```

## Custom Meshes
```python
import numpy as np

vertices = np.array([[0, 0, 0], [1, 0, 0], [0.5, 1, 0]])
faces = np.array([[0, 1, 2]])
result = trimesh.Trimesh(vertices=vertices, faces=faces)
```

## Mesh Properties

- `mesh.volume` - Volume of the mesh
- `mesh.area` - Surface area
- `mesh.is_watertight` - Check if mesh is closed
- `mesh.is_valid` - Check mesh validity
- `mesh.bounds` - Bounding box coordinates
- `mesh.centroid` - Geometric center

## Important Notes

1. Always assign final result to variable named 'result'
2. Boolean operations require watertight meshes
3. Use mesh.is_watertight to validate geometry
4. Coordinate system: X=width, Y=depth, Z=height
5. Units are in your chosen units (typically meters)
6. Trimesh automatically validates and repairs meshes

## Error Prevention

- **NEVER use print() statements** - they break MCP JSON communication
- Use comments (#) instead of print() for documentation
- Check mesh.is_watertight before boolean operations
- Use mesh.is_valid to ensure mesh integrity
- Start with simple primitives and combine them
- Validate intermediate results in complex operations
- Always assign final result to variable named 'result'

## Troubleshooting JSON Errors

If you see "Unexpected token" or "is not valid JSON" errors:
1. Remove ALL print() statements from your Trimesh code
2. Replace print() with comments (#) for documentation
3. Use the verbose=True parameter to get debug info in the response instead
4. Check that your code assigns the final mesh to 'result'

## Example: Fixing Common Errors

WRONG (causes JSON errors):
```python
print("Creating I-beam...")
result = trimesh.primitives.Box(extents=[10, 5, 3])
print("Done!")
```

CORRECT:
```python
result = trimesh.primitives.Box(extents=[10, 5, 3])
```

## Advanced Features

- Convex hulls: `trimesh.convex.convex_hull(points)`
- Mesh repair: Built-in validation and repair
- Ray casting: `mesh.ray.intersects_location(ray_origins, ray_directions)`
- Cross sections: `mesh.section(plane_origin, plane_normal)`

This geometry will be automatically converted to IFC mesh representation.
"""


@register_command('get_trimesh_help', description="Get comprehensive help for using Trimesh")
def get_trimesh_help_command() -> Dict[str, Any]:
    """
    Get comprehensive help for using Trimesh in IFC generation.
    
    Returns:
        Dict with help text and additional information
    """
    return {
        "success": True,
        "help_text": get_trimesh_help(),
        "examples_available": True,
        "validation_available": True,
        "supported_formats": ["IFC mesh representation"],
        "key_advantages": [
            "Direct mesh control and manipulation",
            "Excellent boolean operation support",
            "Built-in mesh validation and repair",
            "Rich geometric analysis capabilities",
            "Pure Python implementation",
            "Extensive primitive library"
        ],
        "critical_warnings": [
            "NEVER use print() statements in Trimesh code - they break MCP communication!",
            "Always use comments (#) instead of print() for documentation",
            "JSON parsing errors are almost always caused by print() statements",
            "Use verbose=True parameter to get debug information in response"
        ]
    }