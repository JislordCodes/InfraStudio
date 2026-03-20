"""Common IFC utility functions for IFC Bonsai MCP API

This module contains shared utility functions used across all IFC entity creation APIs
to avoid code duplication and maintain consistency. Uses adapter layer for bonsai/bpy independence.
"""

import numpy as np
import math
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.unit
from typing import List, Optional, Any, Dict


def get_ifc_file():
    """Get current IFC file."""
    import bonsai.tool as tool
    ifc = tool.Ifc.get()
    if not ifc:
        raise RuntimeError("No IFC file open")
    return ifc


def get_default_container():
    """Get active spatial container."""
    import bonsai.tool as tool
    container = tool.Root.get_default_container()
    if not container:
        raise RuntimeError("No active spatial container")
    return container


def save_and_load_ifc():
    """
    Saves the current IFC project to its file, then clears the scene 
    and reloads the project from the same file. 
    """
    import bpy
    import logging
    from bonsai.bim import export_ifc
    from bonsai.bim.ifc import IfcStore
    import bonsai.tool as tool

    path = IfcStore.path

    if not path:
        print("No IFC file path found. Cannot save and reload.")
        return

    try:
        logger = logging.getLogger("BonsaiExport")
        export_settings = export_ifc.IfcExportSettings.factory(bpy.context, path, logger)
        exporter = export_ifc.IfcExporter(export_settings)
        exporter.export()
        tool.IfcGit.load_project(path)
        

    except Exception as e:
        print(f"An error occurred during the save and load process: {e}")


def get_selected_guids() -> List[str]:
    """Get currently selected IFC elements."""
    import bonsai.tool as tool
    selection = tool.Selection.get()
    return [el.GlobalId for el in selection if hasattr(el, 'GlobalId')]

def get_or_create_body_context(ifc_file):
    """Get or create body context for 3D representation."""
    body_context = next(
        (ctx for ctx in ifc_file.by_type("IfcGeometricRepresentationSubContext")
         if ctx.ContextIdentifier == "Body" and ctx.TargetView == "MODEL_VIEW"),
        None
    )
    
    if body_context is None:
        model_ctx = ifc_file.by_type("IfcGeometricRepresentationContext")[0]
        body_context = ifcopenshell.api.run(
            "context.add_context",
            ifc_file,
            context_type="Model",
            context_identifier="Body",
            target_view="MODEL_VIEW",
            parent=model_ctx
        )
    
    return body_context


def get_or_create_axis_context(ifc_file):
    """Get or create axis context for 2D representation."""
    axis_context = next(
        (ctx for ctx in ifc_file.by_type("IfcGeometricRepresentationSubContext")
         if ctx.ContextIdentifier == "Axis" and ctx.TargetView == "GRAPH_VIEW"),
        None
    )
    
    if axis_context is None:
        plan_context = next(
            (ctx for ctx in ifc_file.by_type("IfcGeometricRepresentationContext")
             if ctx.ContextType == "Plan"), 
            None
        )
        if not plan_context:
            plan_context = ifcopenshell.api.run(
                "context.add_context",
                ifc_file,
                context_type="Plan"
            )
        
        axis_context = ifcopenshell.api.run(
            "context.add_context",
            ifc_file,
            context_type="Plan",
            context_identifier="Axis",
            target_view="GRAPH_VIEW",
            parent=plan_context
        )
    
    return axis_context


def calculate_unit_scale(ifc_file):
    """Get unit scale factor."""
    try:
        return ifcopenshell.util.unit.calculate_unit_scale(ifc_file)
    except (AttributeError, ValueError, TypeError) as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(f"Could not calculate unit scale, using default 1.0: {e}")
        return 1.0
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Unexpected error calculating unit scale, using default 1.0: {e}")
        return 1.0


def degrees_to_radians(degrees: float) -> float:
    """Convert degrees to radians."""
    return np.deg2rad(degrees)


def create_rotation_matrix_x(angle_degrees: float) -> np.ndarray:
    """Create rotation matrix for X-axis rotation in degrees."""
    angle = degrees_to_radians(angle_degrees)
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    return np.array([
        [1, 0, 0, 0],
        [0, cos_a, -sin_a, 0],
        [0, sin_a, cos_a, 0],
        [0, 0, 0, 1]
    ])


def create_rotation_matrix_y(angle_degrees: float) -> np.ndarray:
    """Create rotation matrix for Y-axis rotation in degrees."""
    angle = degrees_to_radians(angle_degrees)
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    return np.array([
        [cos_a, 0, sin_a, 0],
        [0, 1, 0, 0],
        [-sin_a, 0, cos_a, 0],
        [0, 0, 0, 1]
    ])


def create_rotation_matrix_z(angle_degrees: float) -> np.ndarray:
    """Create rotation matrix for Z-axis rotation in degrees."""
    angle = degrees_to_radians(angle_degrees)
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    return np.array([
        [cos_a, -sin_a, 0, 0],
        [sin_a, cos_a, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ])


def create_transformation_matrix(
    position_x: float = 0.0,
    position_y: float = 0.0,
    position_z: float = 0.0,
    rotation_x: float = 0.0,  # degrees
    rotation_y: float = 0.0,  # degrees
    rotation_z: float = 0.0,  # degrees
) -> np.ndarray:
    """Create 4x4 transformation matrix from position and rotation."""
    matrix = np.eye(4)
    
    if rotation_x != 0.0:
        matrix = matrix @ create_rotation_matrix_x(rotation_x)
    if rotation_y != 0.0:
        matrix = matrix @ create_rotation_matrix_y(rotation_y)
    if rotation_z != 0.0:
        matrix = matrix @ create_rotation_matrix_z(rotation_z)
    
    matrix[0:3, 3] = [position_x, position_y, position_z]
    return matrix



def ensure_counter_clockwise(face_indices, vertices):
    """Ensure face vertices are counter-clockwise for outward normals."""
    if len(face_indices) < 3:
        return face_indices
    
    v0 = vertices[face_indices[0]]
    v1 = vertices[face_indices[1]]
    v2 = vertices[face_indices[2]]
    
    edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
    edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]
    
    cross = [
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2], 
        edge1[0] * edge2[1] - edge1[1] * edge2[0]
    ]
    
    if cross[2] < 0:
        return list(reversed(face_indices))
    
    return face_indices


def create_wall_aligned_matrix(
    position_x: float,
    position_y: float, 
    position_z: float,
    wall_angle: float = 0.0,
    offset: float = 0.0
) -> np.ndarray:
    """Create transformation matrix for wall-aligned elements."""
    wall_rad = degrees_to_radians(wall_angle)
    offset_x = offset * np.sin(wall_rad)
    offset_y = offset * np.cos(wall_rad)
    
    return create_transformation_matrix(
        position_x + offset_x,
        position_y + offset_y,
        position_z,
        rotation_z=wall_angle
    )


def create_rectangular_polyline(width: float, length: float) -> List[tuple]:
    """Create rectangular polyline for element creation."""
    return [(0.0, 0.0), (width, 0.0), (width, length), (0.0, length)]


def create_circular_polyline(radius: float, segments: int = 32) -> List[tuple]:
    """Create circular polyline for round element creation."""
    points = []
    for i in range(segments):
        angle = 2 * math.pi * i / segments
        x = radius * math.cos(angle)
        y = radius * math.sin(angle)
        points.append((x, y))
    return points


def calculate_two_point_parameters(start_point: tuple, end_point: tuple) -> dict:
    """Calculate parameters from two points (length, angle, etc.)."""
    dx = end_point[0] - start_point[0]
    dy = end_point[1] - start_point[1]
    dz = end_point[2] - start_point[2] if len(start_point) >= 3 and len(end_point) >= 3 else 0
    
    length = math.sqrt(dx**2 + dy**2)
    angle_degrees = math.degrees(math.atan2(dy, dx))
    
    return {
        "length": length,
        "angle": angle_degrees,
        "height_difference": dz,
        "start": start_point,
        "end": end_point
    }
