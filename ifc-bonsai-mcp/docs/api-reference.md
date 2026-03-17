---
layout: default
title: MCP Tools API Reference
---

# MCP Tools API Reference

> **Note: This file is auto-generated. Do not edit manually.**

*Last updated: 2025-10-24 11:15:00*

Total tools found: 52 across 3 modules.

## Table of Contents

- **[Analysis Tools](#analysis-tools)**
  - [capture_blender_window_screenshot](#capture-blender-window-screenshot)
  - [capture_blender_3dviewport_screenshot](#capture-blender-3dviewport-screenshot)
- **[Api Tools](#api-tools)**
  - [execute_blender_code](#execute-blender-code)
  - [list_blender_commands](#list-blender-commands)
  - [execute_ifc_code_tool](#execute-ifc-code-tool)
  - [get_scene_info](#get-scene-info)
  - [get_blender_object_info](#get-blender-object-info)
  - [get_selected_objects](#get-selected-objects)
  - [get_object_info](#get-object-info)
  - [get_ifc_scene_overview](#get-ifc-scene-overview)
  - [create_wall](#create-wall)
  - [create_two_point_wall](#create-two-point-wall)
  - [create_polyline_walls](#create-polyline-walls)
  - [update_wall](#update-wall)
  - [get_wall_properties](#get-wall-properties)
  - [get_roof_types](#get-roof-types)
  - [create_roof](#create-roof)
  - [update_roof](#update-roof)
  - [delete_roof](#delete-roof)
  - [create_slab](#create-slab)
  - [update_slab](#update-slab)
  - [get_slab_properties](#get-slab-properties)
  - [get_door_operation_types](#get-door-operation-types)
  - [create_door](#create-door)
  - [update_door](#update-door)
  - [get_door_properties](#get-door-properties)
  - [get_window_partition_types](#get-window-partition-types)
  - [create_window](#create-window)
  - [update_window](#update-window)
  - [create_trimesh_ifc](#create-trimesh-ifc)
  - [get_window_properties](#get-window-properties)
  - [get_stairs_types](#get-stairs-types)
  - [create_stairs](#create-stairs)
  - [update_stairs](#update-stairs)
  - [delete_stairs](#delete-stairs)
  - [create_surface_style](#create-surface-style)
  - [create_pbr_style](#create-pbr-style)
  - [apply_style_to_object](#apply-style-to-object)
  - [list_styles](#list-styles)
  - [update_style](#update-style)
  - [remove_style](#remove-style)
  - [create_mesh_ifc](#create-mesh-ifc)
  - [list_ifc_entities](#list-ifc-entities)
  - [get_trimesh_examples](#get-trimesh-examples)
- **[Rag Tools](#rag-tools)**
  - [ensure_ifc_knowledge_ready](#ensure-ifc-knowledge-ready)
  - [search_ifc_knowledge](#search-ifc-knowledge)
  - [get_ifc_knowledge_status](#get-ifc-knowledge-status)
  - [find_ifc_function](#find-ifc-function)
  - [get_ifc_module_info](#get-ifc-module-info)
  - [get_ifc_function_details](#get-ifc-function-details)
  - [clear_ifc_knowledge_cache](#clear-ifc-knowledge-cache)
  - [get_cache_statistics](#get-cache-statistics)

## Analysis Tools
*File: `analysis_tools.py`*

This module contains 2 tool(s):

### `capture_blender_window_screenshot`

```python
capture_blender_window_screenshot(max_size: int = None, format: str = "PNG", quality: int = 95, return_image_data: bool = True, include_data_uri: bool = False, keep_file: bool = False) -> Image
```

Capture a screenshot of the current Blender application window with high quality options.

**Parameters:**

- max_size: Maximum size in pixels for the largest dimension (None = full resolution, recommended for text analysis)
- format: Image format - "PNG" (lossless, default), "JPEG" (smaller files), or "WEBP"
- quality: JPEG/WEBP quality 1-100 (only used for JPEG/WEBP format, default: 95)
- return_image_data: Include base64-encoded image data
- include_data_uri: Include data URI string
- keep_file: Preserve temporary files on disk
  Returns the screenshot as an Image.
- **Usage examples:**
- capture_blender_window_screenshot() -> Full resolution PNG (best quality)
- capture_blender_window_screenshot(max_size=4000) -> 4K max PNG
- capture_blender_window_screenshot(max_size=2000, format="JPEG", quality=90) -> 2K JPEG

---

### `capture_blender_3dviewport_screenshot`

```python
capture_blender_3dviewport_screenshot(max_size: int = None, format: str = "PNG", quality: int = 95, return_image_data: bool = True, include_data_uri: bool = False, keep_file: bool = False, area_index: int = None, shading_type: str = None, show_overlays: bool = None, show_gizmo: bool = None, deterministic: bool = False) -> Image
```

Capture a screenshot of only the Blender 3D viewport (excluding UI panels).

**Parameters:**

- max_size: Maximum size in pixels for the largest dimension (None = full resolution)
- format: Image format - "PNG" (lossless, default), "JPEG" (smaller files), or "WEBP"
- quality: JPEG/WEBP quality 1-100 (only used for JPEG/WEBP format, default: 95)
- return_image_data: Include base64-encoded image data
- include_data_uri: Include data URI string
- keep_file: Preserve temporary files on disk
- area_index: Specific viewport index, or None for largest
- shading_type: Override viewport shading mode
- show_overlays: Override overlay visibility
- show_gizmo: Override gizmo visibility
- deterministic: Use consistent viewport settings for reproducible results
  Returns the viewport screenshot as an Image with additional viewport metadata.
- **Usage examples:**
- capture_blender_3dviewport_screenshot() -> Full resolution PNG of 3D viewport
- capture_blender_3dviewport_screenshot(max_size=1920, format="JPEG", quality=85) -> HD JPEG
  This captures only the 3D scene content without Blender's UI, perfect for analyzing
  the actual 3D model, geometry, and spatial relationships.

---

## Api Tools
*File: `api_tools.py`*

This module contains 42 tool(s):

### `execute_blender_code`

```python
execute_blender_code(code: str) -> str
```

Execute arbitrary Python code in the Blender context.
This function allows you to run Python code directly in Blender's environment.

**Parameters:**

- **code (str): The Python code to execute. It should be a valid Python script.**
- **Returns:**
- **str: Result of the code execution or an error message if it fails.**
- **Note:**
- Be cautious with the code you execute, as it will run in Blender's context.

---

### `list_blender_commands`

```python
list_blender_commands() -> str
```

List all available Blender addon commands with descriptions.

Returns:
    JSON containing: count, commands[{name, description}]

---

### `execute_ifc_code_tool`

```python
execute_ifc_code_tool(code: str) -> str
```

```python
Execute IFC OpenShell Python code with comprehensive security and IFC toolkit access.

This tool allows you to generate and execute IFC OpenShell API code directly,
providing access to the complete IFC OpenShell toolkit for BIM operations.

WHAT YOU CAN DO:
- Create, modify, and delete IFC building elements (walls, slabs, doors, windows, etc.)
- Manage IFC properties, materials, and relationships
- Work with IFC geometry and spatial structures
- Handle IFC classification, documentation, and project data
- Perform batch operations on IFC models

SUPPORTED IFC MODULES:
• root: Create/copy/remove elements (create_entity, copy_class, remove_product)
• aggregate: Manage spatial hierarchies (assign_object, unassign_object)
• attribute: Edit properties (edit_attributes, get_attributes)
• geometry: Handle geometric representations (add_wall_representation, etc.)
• material: Assign materials (assign_material, unassign_material)
• type: Manage element types (assign_type, unassign_type)
• spatial: Create spatial structures (create_space, assign_container)
• pset: Property sets (add_pset, edit_pset)
• classification: Classification systems (add_classification, etc.)
• And 30+ more IFC modules for complete BIM operations

SECURITY & RESTRICTIONS:
✓ Only IFC OpenShell APIs allowed (ifcopenshell, ifcopenshell.api.*)
✓ Standard Python libraries (math, json, datetime, etc.) permitted
✗ No Blender APIs (bpy, bmesh) - use IFC APIs instead
✗ No file system access, network, or system operations
✗ No dangerous functions (eval, exec, import, etc.)

TYPICAL WORKFLOW:
# =============================================================================
# IFC Environment Prelude for IFC Bonsai MCP
# =============================================================================
# This prelude provides essential utility functions for IFC operations.
# These functions handle the connection to Blender's IFC environment and
# provide consistent access to IFC contexts and file management.

# -----------------------------------------------------------------------------
# ESSENTIAL IMPORTS - Always include these for IFC operations
# -----------------------------------------------------------------------------
import ifcopenshell
import ifcopenshell.api
from blender_addon.api.ifc_utils import (
    get_ifc_file,                    # Get current IFC file object
    get_default_container,           # Get active spatial container (building/storey)
    get_or_create_body_context,      # Get/create 3D geometry context
    get_or_create_axis_context,      # Get/create 2D axis/plan context
    calculate_unit_scale,            # Get unit conversion factor
    save_and_load_ifc                # Save changes and reload in Blender
)

# -----------------------------------------------------------------------------
# CORE IFC CONTEXT SETUP - Always run this first in your IFC code
# -----------------------------------------------------------------------------
# These variables provide access to the current IFC environment
ifc_file = get_ifc_file()           # The current IFC model/file
container = get_default_container() # Active building storey/space
unit_scale = calculate_unit_scale(ifc_file)  # Unit conversion (usually 1.0)

# -----------------------------------------------------------------------------
# PRACTICAL EXAMPLE: Creating a Simple Wall
# -----------------------------------------------------------------------------
# This example shows how to use the utility functions for basic IFC operations
# NOTE: This is just to demonstrate the utility functions - for actual wall
# creation, use the higher-level API functions from blender_addon.api.wall

# Step 1: Define your wall parameters (replace with your actual values)
wall_name = "Example Wall"
wall_length = 5.0    # meters
wall_height = 3.0    # meters
wall_thickness = 0.2 # meters

# Step 2: Create the wall entity using ifcopenshell.api
wall = ifcopenshell.api.run(
    "root.create_entity",
    ifc_file,
    ifc_class="IfcWall",
    name=wall_name
)

# Step 3: Assign to spatial container (building storey)
ifcopenshell.api.run(
    "spatial.assign_container",
    ifc_file,
    products=[wall],
    relating_structure=container
)

# Step 4: Create geometric contexts (3D body and 2D axis)
body_context = get_or_create_body_context(ifc_file)  # For 3D geometry
axis_context = get_or_create_axis_context(ifc_file)  # For 2D plan representation

# Step 5: Add 3D body representation (the actual wall geometry)
wall_body_rep = ifcopenshell.api.run(
    "geometry.add_wall_representation",
    ifc_file,
    context=body_context,
    length=wall_length,
    height=wall_height,
    thickness=wall_thickness,
    direction_sense="POSITIVE"  # Wall direction
)

# Step 6: Add 2D axis representation (for plan views)
wall_axis_rep = ifcopenshell.api.run(
    "geometry.add_axis_representation",
    ifc_file,
    context=axis_context,
    axis=[(0.0, 0.0), (wall_length, 0.0)]  # Start and end points
)

# Step 7: Assign representations to the wall
ifcopenshell.api.run("geometry.assign_representation", ifc_file,
                product=wall, representation=wall_body_rep)
ifcopenshell.api.run("geometry.assign_representation", ifc_file,
                product=wall, representation=wall_axis_rep)

# Step 8: Save changes back to Blender
save_and_load_ifc()

print(f"Created wall: {wall.GlobalId}")

# -----------------------------------------------------------------------------
# FUNCTION REFERENCE
# -----------------------------------------------------------------------------
# get_ifc_file():
#   - Returns the current IFC file object
#   - Raises RuntimeError if no IFC file is open
#   - Use this to access the current model for all IFC operations
#
# get_default_container():
#   - Returns the active spatial container (usually a building storey)
#   - Raises RuntimeError if no container is set
#   - Required for assigning elements to the correct spatial structure
#
# get_or_create_body_context(ifc_file):
#   - Gets existing or creates new 3D geometric representation context
#   - Used for 3D model geometry (walls, slabs, etc.)
#   - Automatically handles context setup
#
# get_or_create_axis_context(ifc_file):
#   - Gets existing or creates new 2D geometric representation context
#   - Used for plan/elevation representations
#   - Required for proper 2D visualization
#
# calculate_unit_scale(ifc_file):
#   - Returns the unit conversion factor for the IFC file
#   - Usually 1.0 for meters, but may vary
#   - Use when working with measurements
#
# save_and_load_ifc():
#   - Saves all changes to the IFC file
#   - Reloads the file in Blender to update the 3D view
#   - Call this after making changes to see them in Blender
#
# -----------------------------------------------------------------------------
# BEST PRACTICES
# -----------------------------------------------------------------------------
# 1. Always call the context setup (get_ifc_file, get_default_container, etc.)
#    at the beginning of your IFC code
#
# 2. Use try/except blocks for error handling:
#    try:
#        ifc_file = get_ifc_file()
#        # ... your IFC operations ...
#        save_and_load_ifc()
#    except Exception as e:
#        print(f"IFC operation failed: {e}")
#
# 3. For complex operations, use the higher-level API functions instead:
#    from blender_addon.api.wall import create_wall
#    from blender_addon.api.door import create_door
#    # These handle all the low-level details for you
#
# 4. Remember to call save_and_load_ifc() after making changes
#
# -----------------------------------------------------------------------------
# IMPORTANT NOTES
# -----------------------------------------------------------------------------
# - This prelude is ONLY for the utility functions that connect to Blender's IFC
# - For actual IFC element creation, use the API functions in blender_addon.api.*
# - For property setting or other functions which are not available in the main tools, use ifcopenshell.api directly
# - Different IFC operations may require different patterns and additional imports
# - Always check if an IFC file is open before running IFC operations
#
# -----------------------------------------------------------------------------
# ALTERNATIVE PATTERNS FOR OTHER OPERATIONS
# -----------------------------------------------------------------------------
# For material assignment (different from wall creation):
# material = ifcopenshell.api.run("material.add_material", ifc_file, name="Concrete")
# ifcopenshell.api.run("material.assign_material", ifc_file,
#                     product=wall, material=material.to_dict())
#
# For property assignment:
# pset = ifcopenshell.api.run("pset.add_pset", ifc_file,
#                           product=wall, name="Custom_Properties")
# ifcopenshell.api.run("pset.edit_pset", ifc_file,
#                     pset=pset, properties={"FireRating": "1hr"})
#
# The utility functions (get_ifc_file, save_and_load_ifc, etc.) are still needed,
# but the specific IFC operations vary by use case.
# -----------------------------------------------------------------------------
```

---

### `get_scene_info`

```python
get_scene_info(limit: int = "...", offset: int = 0, obj_type: Optional[str] = None, include_bbox: bool = False, include_transform: bool = False, round_decimals: int = 3, detailed: bool = False) -> str
```

Get basic information about the current Blender scene.

This function returns a list of Blender objects with basic information including IFC GUIDs.
It supports pagination, filtering, and optional detailed information about objects.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **limit (int): Max number of objects to return; -1 returns all from offset (default: -1).**
- **offset (int): Start index for pagination (default: 0).**
- **obj_type (str, optional): Filter by Blender object type (e.g., 'MESH').**
- **include_bbox (bool): When True, include world AABB min/max/dimensions (default: False).**
- **include_transform (bool): When True, include rotation, scale, dimensions, matrix_world (default: False).**
- **round_decimals (int): Rounding for floats in compact listings (default: 3).**
- **detailed (bool): When True, include detailed object information (default: False).**
- **Returns:**
- **str: JSON containing scene information with objects including 'guid' (IFC GlobalId) and 'ifc_class' fields.**
- **Examples:**
  # Get all objects in scene
  get_scene_info()
  # Get first 10 mesh objects with bounding boxes
  get_scene_info(limit=10, obj_type="MESH", include_bbox=True)

---

### `get_blender_object_info`

```python
get_blender_object_info(object_name: str) -> str
```

Get detailed Blender information about a specific object.

This function retrieves comprehensive information about a specific Blender object,
including its geometry, materials, mesh data, and bounding box information.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **object_name (str): Name of the Blender object to query.**
- **Returns:**
- **str: JSON containing detailed object information including:**
- Basic properties (name, type, location, rotation, scale)
- Geometry data (dimensions, matrix_world)
- Material information
- Mesh data (vertex/edge/face counts for mesh objects)
- Bounding box with world coordinates
- **Examples:**
  # Get detailed info for a specific object
  get_blender_object_info(object_name="Cube.001")

---

### `get_selected_objects`

```python
get_selected_objects() -> str
```

Get list of currently selected Blender objects with GUID information.

This function returns information about all currently selected objects in the
Blender scene, including their IFC GUIDs and classes if they are IFC objects.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **Returns:**
- **str: JSON containing:**
- "count" (int): Number of selected objects
- "selected_objects" (list): List of objects with name, type, guid, and ifc_class
- **Examples:**
  # Get currently selected objects
  get_selected_objects()

---

### `get_object_info`

```python
get_object_info(guids: Optional[Union[str, List[str]]] = None, use_selection: bool = False, detailed: bool = False) -> str
```

Get IFC object information from GUIDs or selection.

This function retrieves detailed IFC information for objects specified by their
GUIDs or from the current selection. It provides comprehensive IFC data including
properties, relationships, materials, and geometry.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **guids (Union[str, List[str]], optional): Single GUID string or list of GUID strings.**
- **use_selection (bool): Whether to use currently selected objects (default: False).**
- **detailed (bool): Whether to include detailed information like properties and relationships (default: False).**
- **Returns:**
- **str: JSON containing:**
- "success" (bool): Whether the operation was successful
- "objects" (list): List of object information
- "errors" (list): Any errors encountered
- "count" (int): Number of objects processed
- **Examples:**
  # Get info for specific GUID
  get_object_info(guids="1AbCdEfGhIjKlMnOp")
  # Get detailed info for multiple GUIDs
  get_object_info(guids=["1AbC...", "2BcD..."], detailed=True)
  # Get info for currently selected objects
  get_object_info(use_selection=True, detailed=True)

---

### `get_ifc_scene_overview`

```python
get_ifc_scene_overview(include_selection_summary: bool = False) -> str
```

Get comprehensive IFC scene overview.

This function returns a consolidated overview of the loaded IFC scene, including
project information, units, spatial hierarchy, element counts, and optionally
a summary of currently selected objects.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **include_selection_summary (bool): Whether to include summary of selected objects (default: False).**
- **Returns:**
- **str: JSON containing:**
- "success" (bool): Whether the operation was successful
- "project" (dict): Project information (name, global_id, schema)
- "units" (dict): Unit information (length, area, volume, angle)
- "class_counts" (dict): Count of each IFC element class
- "class_total" (int): Total number of IFC elements
- "spatial" (list): Spatial hierarchy tree
- "summary" (dict): Counts of spatial elements (projects, sites, buildings, storeys, spaces)
- "selection_summary" (dict, optional): Summary of selected objects if requested
- **Examples:**
  # Get basic scene overview
  get_ifc_scene_overview()
  # Get overview including selection summary
  get_ifc_scene_overview(include_selection_summary=True)

---

### `create_wall`

```python
create_wall(name: str = "New Wall", dimensions: Optional[Dict[str, float]] = None, location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, geometry_properties: Optional[Dict[str, Any]] = None, transformation_matrix: Optional[List[List[float]]] = None, material: Optional[str] = None, wall_type_guid: Optional[str] = None, verbose: bool = False) -> str
```

Create a parametric IFC wall with specified properties.

This is the main wall creation function that provides full control over wall geometry,
positioning, and material properties. It creates walls using IFC standards and can
integrate with existing wall types and materials.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **name (str): Name for the wall (default: "New Wall").**
- **dimensions (Dict[str, float], optional): Wall dimensions with keys:**
- "length" (float): Wall length in meters (default: 1.0)
- "height" (float): Wall height in meters (default: 3.0)
- "thickness" (float): Wall thickness in meters (default: 0.2)
- **location (List[float], optional): 3D position [x, y, z] in meters (default: [0,0,0]).**
- **rotation (List[float], optional): Rotation angles [rx, ry, rz] in degrees (default: [0,0,0]).**
- **geometry_properties (Dict[str, Any], optional): Advanced geometry properties:**
- "direction_sense" (str): "POSITIVE" or "NEGATIVE" for layer direction
- "offset" (float): Base offset from reference line in meters
- "x_angle" (float): Slope angle in radians for slanted walls
- **transformation_matrix (List[List[float]], optional): Optional 4x4 transformation matrix**
  for precise positioning, overrides location and rotation if provided.
- **material (str, optional): Material name to assign to the wall.**
- **wall_type_guid (str, optional): GUID of existing IfcWallType to use as template.**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing creation results with wall GUID and properties.**
- **Examples:**
  # Simple wall
- **create_wall(name="Simple Wall", dimensions={"length": 5.0, "height": 3.0, "thickness": 0.2})**
  # Positioned wall with rotation
  create_wall(
  name="Exterior Wall",
- **dimensions={"length": 6.0, "height": 3.5, "thickness": 0.3},**
  location=[10.0, 5.0, 0.0],
  rotation=[0, 0, 45]
  )

---

### `create_two_point_wall`

```python
create_two_point_wall(start_point: List[float], end_point: List[float], name: str = "Two Point Wall", thickness: float = 0.2, height: float = 3.0) -> str
```

Create a wall between two 3D points.

This function automatically calculates the wall length and orientation based on
start and end coordinates. It's perfect for creating walls that follow specific
architectural layouts or connect predefined points in a building design.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **start_point (List[float]): Starting coordinates [x, y, z] in meters.**
- **end_point (List[float]): Ending coordinates [x, y, z] in meters.**
- **name (str): Name for the wall (default: "Two Point Wall").**
- **thickness (float): Wall thickness in meters (default: 0.2).**
- **height (float): Wall height in meters (default: 3.0).**
- **Returns:**
- **str: JSON containing creation results with wall GUID and properties.**
- **Examples:**
  # Wall from origin to point
  create_two_point_wall(
  start_point=[0, 0, 0],
  end_point=[5, 0, 0],
  thickness=0.25
  )
  # Diagonal wall between floors
  create_two_point_wall(
  start_point=[2, 3, 0],
  end_point=[8, 7, 0],
  name="Diagonal Wall",
  height=2.8
  )

---

### `create_polyline_walls`

```python
create_polyline_walls(points: List[List[float]], name_prefix: str = "Wall", thickness: float = 0.2, height: float = 3.0, closed: bool = False) -> str
```

Create connected walls along a polyline path.

This function creates a series of connected walls following a polyline defined
by multiple 3D points. Each wall segment connects consecutive points, making it
ideal for creating complex building perimeters, room layouts, or curved wall
approximations using straight segments.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **points (List[List[float]]): List of 3D coordinates [[x1,y1,z1], [x2,y2,z2], ...].**
- **name_prefix (str): Prefix for wall names, numbered automatically (default: "Wall").**
- **thickness (float): Wall thickness in meters for all segments (default: 0.2).**
- **height (float): Wall height in meters for all segments (default: 3.0).**
- **closed (bool): Whether to close the loop by connecting last point to first (default: False).**
- **Returns:**
- **str: JSON containing creation results with all wall GUIDs and properties.**
- **Examples:**
  # Open polyline walls (L-shape)
  create_polyline_walls(
  points=[[0,0,0], [5,0,0], [5,3,0]],
  thickness=0.25,
  height=2.8,
  closed=False
  )
  # Closed rectangular room
  create_polyline_walls(
  points=[[0,0,0], [6,0,0], [6,4,0], [0,4,0]],
  name_prefix="RoomWall",
  closed=True
  )

---

### `update_wall`

```python
update_wall(wall_guid: str, dimensions: Optional[Dict[str, float]] = None, geometry_properties: Optional[Dict[str, Any]] = None, verbose: bool = False) -> str
```

Update an existing wall using its IFC GUID.

This function modifies the properties of an existing wall, allowing changes to
dimensions, geometric properties, and other characteristics. It preserves the
wall's position and other unchanged properties while updating only the specified
parameters.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **wall_guid (str): IFC GlobalId of the wall to update.**
- **dimensions (Dict[str, float], optional): Dimensions to update:**
- "length" (float): New wall length in meters
- "height" (float): New wall height in meters
- "thickness" (float): New wall thickness in meters
- **geometry_properties (Dict[str, Any], optional): Geometric properties to update:**
- "direction_sense" (str): "POSITIVE" or "NEGATIVE"
- "offset" (float): Base offset in meters
- "x_angle" (float): Slope angle in radians
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing update results with modified properties.**
- **Examples:**
  # Update wall dimensions
  update_wall(
  wall_guid="1AbCdEfGhIjKlMnOp",
- **dimensions={"length": 6.0, "height": 3.5, "thickness": 0.25}**
  )
  # Update only height
  update_wall(
  wall_guid="2BcDeFgHiJkLmNoP",
- **dimensions={"height": 4.0}**
  )

---

### `get_wall_properties`

```python
get_wall_properties(wall_guid: str) -> str
```

Get properties of an existing wall by IFC GUID.

This function retrieves comprehensive information about a wall, including its
dimensions, geometric properties, material assignments, and metadata. It's useful
for inspecting wall characteristics before making modifications or for reporting
purposes.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **wall_guid (str): IFC GlobalId of the wall to query.**
- **Returns:**
- **str: JSON containing wall properties:**
- "name" (str): Wall name
- "guid" (str): Wall GUID
- "length" (float): Wall length in meters
- "height" (float): Wall height in meters
- "thickness" (float): Wall thickness in meters
- "direction_sense" (str): Layer direction
- "offset" (float): Base offset
- "x_angle" (float): Slope angle
- "predefined_type" (str): Wall type classification
- **Examples:**
  # Get wall information
  props = get_wall_properties(wall_guid="1AbCdEfGhIjKlMnOp")

---

### `get_roof_types`

```python
get_roof_types() -> str
```

Get all supported roof types and their descriptions.

This function returns a comprehensive list of all available roof types that can be used
in roof creation functions. Each roof type follows IFC standards and provides specific
geometric characteristics for different architectural requirements.

Available Roof Types:
- FLAT: Flat roof with minimal slope for drainage
- SHED: Single-slope roof, higher on one side
- GABLE_ROOF: Traditional triangular roof with two slopes meeting at ridge
- HIP_ROOF: Roof with slopes on all four sides meeting at edges and ridges
- HIPPED_GABLE: Combination of hip and gable roof features
- GAMBREL: Barn-style roof with two different slopes on each side
- MANSARD: Four-sided gambrel roof with steep lower slopes
- BARREL: Curved roof resembling half of a cylinder
- RAINBOW: Arched roof with rainbow-like curve
- BUTTERFLY: V-shaped roof with valleys instead of ridges
- PAVILION: Pyramid-shaped roof with equal slopes on all sides
- DOME: Rounded vault forming the roof
- FREEFORM: Custom-designed roof with irregular geometry
- NOTDEFINED: Roof type not specified or classified
- USERDEFINED: Custom user-defined roof type

Returns:
    str: JSON containing all supported roof types:
        - "success" (bool): Whether the operation was successful
        - "roof_types" (dict): Dictionary mapping roof type keys to IFC values
        - "message" (str): Summary of available roof types

---

### `create_roof`

```python
create_roof(polyline: List[List[float]], roof_type: str = "FLAT", angle: float = 30.0, thickness: float = 0.3, name: Optional[str] = None, rotation: Optional[List[float]] = None, transformation_matrix: Optional[List[List[float]]] = None, unit_scale: Optional[float] = None, verbose: bool = False) -> str
```

Create a parametric IFC roof from polyline outline using advanced mesh representation.

This powerful function creates IFC-compliant roofs with full control over geometry,
positioning, rotation, and architectural style. It supports various roof types from
simple flat roofs to complex hip and gable configurations, with automatic geometry
generation based on the roof type and parameters.

Key Features:
- Multiple roof types with automatic geometry generation
- Custom polyline boundary definition with 3D coordinates
- Precise angle and thickness control for architectural accuracy
- Full 3D positioning and rotation capabilities
- Optional transformation matrix for complex positioning
- Automatic IFC spatial containment and representation
- Unit scale support for different measurement systems

**Parameters:**

- **polyline (List[List[float]]): List of [x, y, z] coordinates defining roof outline.**
  Must have at least 3 points to form a valid polygon.
  Points should be ordered to form a closed boundary.
- **roof_type (str): Type of roof to create (default: "FLAT"). Options:**
- "FLAT": Flat roof with uniform thickness
- "SHED": Single-slope roof
- "GABLE_ROOF": Traditional peaked roof
- "HIP_ROOF": Roof with slopes on all sides
- Other types: see get_roof_types() for complete list
- **angle (float): Roof slope angle in degrees (default: 30.0).**
  Higher values create steeper roofs.
- **thickness (float): Roof structural thickness in meters (default: 0.3).**
- **name (str, optional): Custom name for the roof. If None, generates name from roof type.**
- **rotation (List[float], optional): Rotation angles [rx, ry, rz] in degrees.**
  If None, no rotation applied.
- **transformation_matrix (List[List[float]], optional): 4x4 transformation matrix**
  for precise positioning.
  Overrides rotation if provided.
- **unit_scale (float, optional): IFC unit scale factor. If None, auto-calculated.**
- **verbose (bool): Enable detailed operation logging (default: False).**
- **Roof Type Details:**
- FLAT: Creates uniform thickness roof with drainage considerations
- SHED: Single slope from high to low side, angle determines slope
- GABLE_ROOF: Traditional triangular profile with ridge line
- HIP_ROOF: Pyramid-like roof with slopes meeting at edges
- **Usage Examples:**
  # Simple flat roof over rectangular area
  create_roof(
  polyline=[[0, 0, 3], [10, 0, 3], [10, 8, 3], [0, 8, 3]],
  roof_type="FLAT",
  thickness=0.25
  )
  # Gable roof with steep slope
  create_roof(
  polyline=[[0, 0, 3], [12, 0, 3], [12, 10, 3], [0, 10, 3]],
  roof_type="GABLE_ROOF",
  angle=45,
  thickness=0.35,
  name="Main House Roof"
  )
  # Hip roof with rotation
  create_roof(
  polyline=[[0, 0, 3], [8, 0, 3], [8, 8, 3], [0, 8, 3]],
  roof_type="HIP_ROOF",
  angle=35,
  rotation=[0, 0, 30]
  )
- **Returns:**
- **str: JSON result containing:**
- success (bool): Whether roof creation was successful
- roof_guid (str): GUID of created roof if successful
- name (str): Name of the created roof
- roof_type (str): IFC roof type used
- angle (float): Applied slope angle
- thickness (float): Applied thickness
- vertices_count (int): Number of vertices in roof geometry
- faces_count (int): Number of faces in roof geometry
- message (str): Success/error description

---

### `update_roof`

```python
update_roof(roof_guid: str, roof_type: Optional[str] = None, angle: Optional[float] = None, thickness: Optional[float] = None, name: Optional[str] = None, verbose: bool = False) -> str
```

```python
Update an existing IFC roof's properties and regenerate geometry as needed.

This function provides comprehensive updating capabilities for existing roofs,
allowing modification of roof type, slope angle, thickness, and naming. When
geometry-related parameters are changed, it automatically regenerates the roof's
3D representation while preserving positioning and material assignments.

Key Features:
- Selective property updating (only specified properties are changed)
- Automatic geometry regeneration for structural changes
- Preservation of position, rotation, and material assignments
- Support for roof type conversion (e.g., flat to gabled)
- Intelligent parameter validation and error handling
- Maintains IFC compliance throughout update process

Parameters:
    roof_guid (str): The IFC GlobalId of the roof to update. Must be valid existing roof.
    roof_type (str, optional): New roof type to apply. If None, keeps current type.
                              Options: FLAT, SHED, GABLE_ROOF, HIP_ROOF, etc.
    angle (float, optional): New slope angle in degrees. If None, keeps current angle.
                            Range typically 0-90 degrees depending on roof type.
    thickness (float, optional): New structural thickness in meters. 
                                If None, keeps current thickness.
    name (str, optional): New name for the roof. If None, keeps current name.
    verbose (bool): Enable detailed operation logging (default: False).

Update Behavior:
    - Geometry Updates: When roof_type, angle, or thickness change, completely 
      regenerates 3D geometry while preserving outline shape
    - Metadata Updates: When only name changes, updates properties without 
      geometric regeneration for better performance
    - Preservation: Position, rotation, materials, and spatial relationships 
      are maintained through all updates
    - Validation: Validates all parameters before applying changes

Usage Examples:
    # Change roof type from flat to gabled
    update_roof(
        roof_guid="roof-123-guid",
        roof_type="GABLE_ROOF",
        angle=40
    )
    
    # Adjust only the slope angle
    update_roof(
        roof_guid="roof-456-guid",
        angle=25
    )
    
    # Update thickness and name
    update_roof(
        roof_guid="roof-789-guid",
        thickness=0.4,
        name="Updated Main Roof",
        verbose=True
    )
    
    # Convert hip roof to shed roof
    update_roof(
        roof_guid="roof-101-guid",
        roof_type="SHED_ROOF",
        angle=20,
        thickness=0.25
    )

Returns:
    str: JSON result containing:
        - success (bool): Whether the update was successful
        - roof_guid (str): GUID of the updated roof
        - message (str): Detailed operation result
        - updated_properties (dict): Summary of properties that were changed:
            - "roof_type" (str): New roof type if changed
            - "angle" (float): New angle if changed
            - "thickness" (float): New thickness if changed
            - "name" (str): New name if changed
        - geometry_updated (bool): Whether 3D geometry was regenerated
```

---

### `delete_roof`

```python
delete_roof(roof_guids: List[str]) -> str
```

Delete one or more IFC roofs by their GlobalIds with comprehensive cleanup.

This function removes specified roofs from the IFC model, ensuring proper cleanup
of all related geometry, relationships, and references. It supports batch deletion
for efficiency and provides detailed feedback on the deletion process.

Key Features:
- Batch deletion of multiple roofs in single operation
- Complete cleanup of IFC relationships and references
- Proper removal of geometric representations
- Detailed error reporting for problematic deletions
- Automatic model synchronization after deletion
- Preservation of other model elements and relationships

**Parameters:**

- **roof_guids (List[str]): List of IFC GlobalIds of roofs to delete.**
  Each GUID must correspond to an existing roof element.
- **Deletion Process:**
  1. Validates each GUID corresponds to existing roof
  2. Removes all geometric representations
  3. Cleans up spatial relationships and containment
  4. Removes material assignments and property sets
  5. Deletes the roof entity from IFC model
  6. Synchronizes model and updates Blender representation
- **Usage Examples:**
  # Delete single roof
  delete_roof(roof_guids=["roof-123-guid"])
  # Delete multiple roofs
  delete_roof(roof_guids=[
  "roof-main-guid",
  "roof-garage-guid",
  "roof-shed-guid"
  ])
  # Delete all roofs from a list
  all_roof_guids = ["roof-1", "roof-2", "roof-3", "roof-4"]
  delete_roof(roof_guids=all_roof_guids)
- **Returns:**
- **str: JSON result containing:**
- success (bool): Whether the overall operation was successful
- deleted_count (int): Number of roofs successfully deleted
- total_requested (int): Total number of roofs requested for deletion
- errors (list): List of error messages for failed deletions
- deleted_guids (list): List of GUIDs that were successfully deleted
- failed_guids (list): List of GUIDs that could not be deleted
- message (str): Summary of deletion operation

---

### `create_slab`

```python
create_slab(name: str = "New Slab", polyline: Optional[List[List[float]]] = None, depth: float = 0.2, location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, geometry_properties: Optional[Dict[str, Any]] = None, transformation_matrix: Optional[List[List[float]]] = None, material: Optional[str] = None, slab_type_guid: Optional[str] = None, verbose: bool = False) -> str
```

```python
Create a parametric IfcSlab with comprehensive geometric and material properties.

This powerful function creates IFC-compliant slabs with full control over geometry,
positioning, rotation, and material assignment. It supports custom polyline definitions,
transformation matrices, and automatic IFC model integration.

Key Features:
- Custom polyline boundary definition with 2D points
- Full 3D positioning and rotation control
- Optional transformation matrix for complex positioning
- Automatic IFC spatial containment and representation
- Material assignment support
- Slab type template support
- Geometric properties control (direction, offset, slope)

Parameters:
    name (str): Name for the slab entity (default: "New Slab")
    polyline (List[List[float]], optional): List of [x, y] points defining the slab boundary.
                                           If None, creates a default 1x1m rectangle.
                                           Points should form a closed polygon.
    depth (float): Slab thickness in meters (default: 0.2m)
    location (List[float], optional): 3D position [x, y, z] in meters. If None, places at origin.
    rotation (List[float], optional): Rotation angles [rx, ry, rz] in degrees. If None, no rotation.
    geometry_properties (Dict[str, Any], optional): Advanced geometric properties:
        - "direction_sense" (str): "POSITIVE" or "NEGATIVE" for layer direction
        - "offset" (float): Base offset from reference plane in meters
        - "x_angle" (float): Slope angle around X-axis in radians for sloped slabs
        - "clippings" (List): Optional clipping geometry for complex shapes
    transformation_matrix (List[List[float]], optional): 4x4 transformation matrix for precise positioning.
                                                        Overrides location and rotation if provided.
    material (str, optional): Material name or GUID to assign to the slab
    slab_type_guid (str, optional): GUID of an existing IfcSlabType to use as template
    verbose (bool): Enable detailed logging and error reporting (default: False)

Geometry Properties Details:
    - direction_sense: Controls which side of the slab the thickness extends
    - offset: Moves the slab vertically from its reference position
    - x_angle: Creates sloped slabs by rotating around the X-axis
    - clippings: Advanced feature for subtracting geometry from the slab

Usage Examples:
    # Simple rectangular slab
    create_slab("Floor Slab", depth=0.25, location=[0, 0, 0])
    
    # Custom L-shaped slab
    l_shape = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]
    create_slab("L-Shape Slab", polyline=l_shape, depth=0.2)
    
    # Sloped slab with 5-degree slope
    props = {"x_angle": 0.087}  # 5 degrees in radians
    create_slab("Sloped Slab", geometry_properties=props, depth=0.3)
    
    # Slab with rotation
    create_slab("Rotated Slab", rotation=[0, 0, 45], location=[5, 5, 3])

Returns:
    str: JSON result containing:
        - success (bool): Whether the slab was created successfully
        - slab_guid (str): GUID of the created slab if successful
        - message (str): Success/error message
        - properties (dict): Created slab properties if successful
```

---

### `update_slab`

```python
update_slab(slab_guid: str, depth: Optional[float] = None, polyline: Optional[List[List[float]]] = None, geometry_properties: Optional[Dict[str, Any]] = None, verbose: bool = False) -> str
```

```python
Update an existing IFC slab's geometric properties using its GUID.

This function provides comprehensive updating capabilities for existing slabs,
allowing modification of thickness, boundary shape, and advanced geometric
properties. It preserves the slab's position and other unchanged properties.

Key Features:
- Selective property updating (only specified properties are changed)
- Boundary shape modification with new polyline
- Thickness adjustment with automatic representation update
- Advanced geometric property control
- Automatic IFC model synchronization
- Comprehensive error handling and validation

Parameters:
    slab_guid (str): The IFC GlobalId of the slab to update. Must be an existing slab entity.
    depth (float, optional): New thickness for the slab in meters. If None, keeps current thickness.
    polyline (List[List[float]], optional): New boundary points as [x, y] coordinates.
                                           If None, keeps current boundary shape.
    geometry_properties (Dict[str, Any], optional): Geometric properties to update:
        - "direction_sense" (str): "POSITIVE" or "NEGATIVE" for thickness direction
        - "offset" (float): Vertical offset from reference plane in meters
        - "x_angle" (float): Slope angle in radians for sloped slabs
        - "clippings" (List): Advanced clipping geometry
    verbose (bool): Enable detailed operation logging (default: False)

Update Behavior:
    - Only specified properties are modified
    - Unspecified properties retain their current values
    - The slab's position and material assignments are preserved
    - IFC representation is completely regenerated for geometric changes
    - Original representation is properly cleaned up

Usage Examples:
    # Update only thickness
    update_slab("slab-guid-123", depth=0.3)
    
    # Change boundary shape to rectangular
    new_shape = [[0, 0], [10, 0], [10, 6], [0, 6]]
    update_slab("slab-guid-456", polyline=new_shape)
    
    # Update thickness and add slope
    slope_props = {"x_angle": 0.087}  # 5 degrees
    update_slab("slab-guid-789", depth=0.25, geometry_properties=slope_props)
    
    # Complete geometry update
    complex_shape = [[0, 0], [8, 0], [8, 4], [4, 4], [4, 6], [0, 6]]
    geo_props = {"direction_sense": "NEGATIVE", "offset": 0.1}
    update_slab("slab-guid-101", depth=0.35, polyline=complex_shape, 
                   geometry_properties=geo_props, verbose=True)

Returns:
    str: JSON result containing:
        - success (bool): Whether the update was successful
        - slab_guid (str): GUID of the updated slab
        - message (str): Detailed operation result
        - updated_properties (dict): Summary of what was changed
        - warnings (list): Any non-critical issues encountered
```

---

### `get_slab_properties`

```python
get_slab_properties(slab_guid: str) -> str
```

```python
Retrieve comprehensive properties and metadata for an existing IFC slab.

This function provides detailed information about a slab entity, including
its geometric properties, boundary definition, materials, and IFC metadata.
It's essential for understanding slab characteristics before modifications
or for analysis and reporting purposes.

Key Features:
- Complete geometric property extraction
- Boundary polyline coordinates retrieval
- Material assignment information
- IFC entity metadata and classification
- Spatial containment information
- Comprehensive error handling for invalid GUIDs

Parameters:
    slab_guid (str): The IFC GlobalId of the slab to analyze. Must be a valid existing slab.

Retrieved Properties:
    - Basic Properties: name, GUID, predefined type, entity class
    - Geometric Properties: depth/thickness, direction sense, offset, slope angle
    - Boundary Definition: polyline points defining the slab perimeter
    - Spatial Information: containing space, building story, building
    - Material Information: assigned materials and their properties
    - Representation Details: geometry representation method and context
    - Relationships: connected elements, openings, and dependencies

Usage Examples:
    # Get basic slab information
    props = get_slab_properties("slab-guid-123")
    
    # Analyze slab before modification
    current_props = get_slab_properties("floor-slab-456")
    # Use properties to determine update parameters
    
    # Extract geometry for duplication
    reference_slab = get_slab_properties("reference-guid-789")
    # Extract polyline and depth for creating similar slabs

Returns:
    str: JSON result containing:
        - success (bool): Whether the slab was found and analyzed
        - slab_guid (str): Confirmed GUID of the analyzed slab
        - properties (dict): Comprehensive slab properties:
            - "name" (str): Slab entity name
            - "guid" (str): IFC GlobalId
            - "predefined_type" (str): IFC predefined type (FLOOR, ROOF, etc.)
            - "depth" (float): Slab thickness in meters
            - "direction_sense" (str): Thickness direction
            - "offset" (float): Vertical offset from reference
            - "x_angle" (float): Slope angle in radians
            - "polyline" (list): Boundary points as [x, y] coordinates
            - "materials" (list): Assigned material information
            - "spatial_container" (str): Containing space or story
        - message (str): Success confirmation or error details
```

---

### `get_door_operation_types`

```python
get_door_operation_types() -> str
```

Get all supported door operation types and their descriptions.

This function returns a comprehensive list of all available door operation types
that can be used in door creation functions. Each operation type defines how the
door opens and functions within the architectural space.

Available Door Operation Types:
- SINGLE_SWING_LEFT: Single door panel that swings to the left when opening
- SINGLE_SWING_RIGHT: Single door panel that swings to the right when opening
- DOUBLE_SWING_LEFT: Double-swing door with hinges on the left side
- DOUBLE_SWING_RIGHT: Double-swing door with hinges on the right side
- DOUBLE_DOOR_SINGLE_SWING: Two-panel door where both panels swing in same direction
- DOUBLE_DOOR_DOUBLE_SWING: Two-panel door with panels swinging in opposite directions
- SLIDING_TO_LEFT: Door that slides horizontally to the left
- SLIDING_TO_RIGHT: Door that slides horizontally to the right
- DOUBLE_DOOR_SLIDING: Two-panel sliding door system

Returns:
    str: JSON containing all supported door operation types:
        - "success" (bool): Whether the operation was successful
        - "door_operation_types" (dict): Dictionary mapping operation type keys to IFC values
        - "message" (str): Summary of available operation types

---

### `create_door`

```python
create_door(name: str = "New Door", dimensions: Optional[Dict[str, float]] = None, operation_type: str = "SINGLE_SWING_LEFT", location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, frame_properties: Optional[Dict[str, float]] = None, panel_properties: Optional[Dict[str, float]] = None, custom_lining: Optional[Dict[str, Any]] = None, custom_panels: Optional[Dict[str, Any]] = None, transformation_matrix: Optional[List[List[float]]] = None, unit_scale: Optional[float] = None, part_of_product: Optional[Any] = None, verbose: bool = False) -> str
```

Create a parametric IFC door with specified properties.

This is the main door creation function that provides full control over door geometry,
operation type, positioning, and detailed properties. It creates doors using IFC standards
with customizable frame and panel characteristics.

Key Features:
- Full parametric control over door dimensions and properties
- Support for all standard door operation types (swing, sliding, double doors)
- Customizable frame/lining properties (depth, thickness, offsets)
- Configurable panel properties (depth, width, frame characteristics)
- Flexible positioning with location, rotation, or transformation matrix
- Integration with IFC standards for building information modeling
- Optional verbose logging for debugging and monitoring

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **name (str): Name for the door (default: "New Door").**
- **dimensions (Dict[str, float], optional): Door dimensions with keys:**
- "width" (float): Door opening width in meters (default: 0.9)
- "height" (float): Door opening height in meters (default: 2.0)
- **operation_type (str): Door operation type (default: "SINGLE_SWING_LEFT").**
  Use get_door_operation_types() to see all available types.
- **location (List[float], optional): 3D position [x, y, z] in meters (default: [0,0,0]).**
- **rotation (List[float], optional): Rotation angles [rx, ry, rz] in degrees (default: [0,0,0]).**
- **frame_properties (Dict[str, float], optional): Frame/lining properties:**
- "lining_depth" (float): Frame depth in meters (default: 0.05)
- "lining_thickness" (float): Frame thickness in meters (default: 0.05)
- "lining_offset" (float): Frame offset in meters (default: 0.0)
- "lining_to_panel_offset_x" (float): X offset from frame to panel (default: 0.025)
- "lining_to_panel_offset_y" (float): Y offset from frame to panel (default: 0.025)
- "transom_thickness" (float): Transom thickness in meters (default: 0.0)
- "transom_offset" (float): Transom offset in meters (default: 1.525)
- "casing_depth" (float): Casing depth in meters (default: 0.005)
- "casing_thickness" (float): Casing thickness in meters (default: 0.075)
- "threshold_depth" (float): Threshold depth in meters (default: 0.1)
- "threshold_thickness" (float): Threshold thickness in meters (default: 0.025)
- "threshold_offset" (float): Threshold offset in meters (default: 0.0)
- **panel_properties (Dict[str, float], optional): Panel properties:**
- "panel_depth" (float): Door panel depth in meters (default: 0.035)
- "panel_width" (float): Panel width factor (default: 1.0)
- "frame_depth" (float): Panel frame depth in meters (default: 0.035)
- "frame_thickness" (float): Panel frame thickness in meters (default: 0.035)
- **custom_lining (Dict[str, Any], optional): Custom lining properties dictionary.**
- **custom_panels (Dict[str, Any], optional): Custom panel properties dictionary.**
- **transformation_matrix (List[List[float]], optional): 4x4 transformation matrix**
  for precise positioning, overrides location and rotation if provided.
- **unit_scale (float, optional): IFC unit scale factor.**
- **part_of_product (Any, optional): Parent product for door assembly.**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing creation results with door GUID and properties.**
- **Examples:**
  # Simple door
- **create_door(name="Main Entrance", dimensions={"width": 0.9, "height": 2.0})**
  # Double door with custom properties
  create_door(
  name="Conference Room Door",
  operation_type="DOUBLE_DOOR_SINGLE_SWING",
- **dimensions={"width": 1.8, "height": 2.1},**
  location=[5.0, 0.0, 0.0],
- **frame_properties={"lining_depth": 0.06, "lining_thickness": 0.06}**
  )
  # Sliding door
  create_door(
  name="Patio Slider",
  operation_type="SLIDING_TO_RIGHT",
- **dimensions={"width": 1.5, "height": 2.0},**
  location=[0.0, 10.0, 0.0],
- **panel_properties={"panel_depth": 0.04}**
  )

---

### `update_door`

```python
update_door(door_guid: str, dimensions: Optional[Dict[str, float]] = None, operation_type: Optional[str] = None, frame_properties: Optional[Dict[str, float]] = None, panel_properties: Optional[Dict[str, float]] = None, custom_lining: Optional[Dict[str, Any]] = None, custom_panels: Optional[Dict[str, Any]] = None, part_of_product: Optional[Any] = None, verbose: bool = False) -> str
```

Update an existing door using its IFC GUID.

This function modifies the properties of an existing door, allowing changes to
dimensions, operation type, frame properties, panel properties, and other
characteristics. It preserves the door's position and other unchanged properties
while updating only the specified parameters.

Key Features:
- Selective property updates (only specified properties are changed)
- Maintains door positioning and unchanged characteristics
- Support for all door operation type changes
- Frame and panel property modifications
- Custom lining and panel dictionary updates
- Preserves IFC relationships and spatial containment
- Comprehensive error handling for invalid GUIDs

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **door_guid (str): IFC GlobalId of the door to update.**
- **dimensions (Dict[str, float], optional): Dimensions to update:**
- "width" (float): New door width in meters
- "height" (float): New door height in meters
- **operation_type (str, optional): New door operation type.**
  Use get_door_operation_types() to see all available types.
- **frame_properties (Dict[str, float], optional): Frame properties to update.**
  Same keys as in create_door().
- **panel_properties (Dict[str, float], optional): Panel properties to update.**
  Same keys as in create_door().
- **custom_lining (Dict[str, Any], optional): Custom lining properties dictionary.**
- **custom_panels (Dict[str, Any], optional): Custom panel properties dictionary.**
- **part_of_product (Any, optional): Parent product for door assembly.**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing update results with modified properties.**
- **Examples:**
  # Update door dimensions
  update_door(
  door_guid="1AbCdEfGhIjKlMnOp",
- **dimensions={"width": 1.0, "height": 2.1}**
  )
  # Change operation type
  update_door(
  door_guid="2BcDeFgHiJkLmNoP",
  operation_type="DOUBLE_DOOR_SINGLE_SWING"
  )
  # Update frame properties
  update_door(
  door_guid="3CdEfGhIjKlMnOpQ",
- **frame_properties={"lining_depth": 0.08, "lining_thickness": 0.07}**
  )

---

### `get_door_properties`

```python
get_door_properties(door_guid: str) -> str
```

```python
Get properties of an existing door by IFC GUID.

This function retrieves comprehensive information about a door, including its
dimensions, operation type, frame and panel properties, material assignments,
and metadata. It's useful for inspecting door characteristics before making
modifications or for reporting purposes.

Key Features:
- Complete door property extraction and analysis
- Geometric properties (width, height, operation type)
- Frame/lining property details and measurements
- Panel property specifications and characteristics
- Material assignment information
- IFC entity metadata and classification
- Spatial containment and relationship information
- Comprehensive error handling for invalid GUIDs

Retrieved Properties:
    - Basic Properties: name, GUID, predefined type, entity class
    - Geometric Properties: width, height, operation type
    - Frame Properties: lining depth, thickness, offsets, casing details
    - Panel Properties: panel depth, width, frame characteristics
    - Spatial Information: containing space, building story, building
    - Material Information: assigned materials and their properties
    - Representation Details: geometry representation method and context
    - Relationships: connected walls, openings, and dependencies

Args:
    ctx (Context): The MCP context (not used directly).
    door_guid (str): IFC GlobalId of the door to query.
    
Returns:
    str: JSON containing door properties:
        - "success" (bool): Whether the door was found and analyzed
        - "door_guid" (str): Confirmed GUID of the analyzed door
        - "properties" (dict): Comprehensive door properties:
            - "name" (str): Door entity name
            - "guid" (str): IFC GlobalId
            - "predefined_type" (str): Door type classification
            - "operation_type" (str): Door operation type
            - "width" (float): Door width in meters
            - "height" (float): Door height in meters
            - "lining_props" (dict): Frame/lining properties
            - "panel_props" (dict): Panel properties
            - "materials" (list): Assigned material information
            - "spatial_container" (str): Containing space or story
        - "message" (str): Success confirmation or error details
    
Examples:
    # Get door information for inspection
    props = get_door_properties(door_guid="1AbCdEfGhIjKlMnOp")
    
    # Analyze door before modification
    current_props = get_door_properties(door_guid="entrance-door-123")
    # Use properties to determine update parameters
    
    # Extract properties for duplication
    reference_door = get_door_properties(door_guid="template-door-456")
    # Use properties to create similar doors
```

---

### `get_window_partition_types`

```python
get_window_partition_types() -> str
```

Get all supported window partition types and their descriptions.

This function retrieves all available window partition types that can be used
when creating windows. These types define how the window is divided into panels.

Returns:
    str: JSON containing available partition types:
        - SINGLE_PANEL: Single undivided window panel
        - DOUBLE_PANEL_VERTICAL: Two panels divided vertically
        - DOUBLE_PANEL_HORIZONTAL: Two panels divided horizontally  
        - TRIPLE_PANEL_VERTICAL: Three panels divided vertically
        - TRIPLE_PANEL_BOTTOM: Three panels with one at bottom
        - TRIPLE_PANEL_TOP: Three panels with one at top
        - TRIPLE_PANEL_LEFT: Three panels with one at left
        - TRIPLE_PANEL_RIGHT: Three panels with one at right
        - TRIPLE_PANEL_HORIZONTAL: Three panels divided horizontally
        - USERDEFINED: Custom user-defined partition

---

### `create_window`

```python
create_window(name: str = "New Window", dimensions: Optional[Dict[str, float]] = None, partition_type: str = "SINGLE_PANEL", location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, frame_properties: Optional[Dict[str, float]] = None, panel_properties: Optional[Dict[str, float]] = None, custom_panels: Optional[List[Dict[str, Any]]] = None, transformation_matrix: Optional[List[List[float]]] = None, unit_scale: Optional[float] = None, part_of_product: Optional[Any] = None, wall_guid: Optional[str] = None, create_opening: bool = False, verbose: bool = False) -> str
```

```python
Create a parametric IFC window with comprehensive customization options.

This function creates highly detailed and configurable windows with support for
various partition types, frame properties, panel configurations, and automatic
opening creation in walls. It provides full control over window geometry,
appearance, and placement within the BIM model.

Key Features:
- Multiple partition types (single, double, triple panels)
- Customizable frame and panel properties
- Automatic wall opening creation and filling
- Support for transformation matrices
- Configurable lining and mullion properties
- Integration with existing walls

Parameters:
    name (str): Window name/identifier (default: "New Window")
    dimensions (Dict[str, float], optional): Window dimensions in meters:
        - "width": Window width (default: 1.2)
        - "height": Window height (default: 1.5)
    partition_type (str): Window panel configuration (default: "SINGLE_PANEL"):
        - "SINGLE_PANEL": Single undivided panel
        - "DOUBLE_PANEL_VERTICAL": Two vertical panels
        - "DOUBLE_PANEL_HORIZONTAL": Two horizontal panels
        - "TRIPLE_PANEL_VERTICAL": Three vertical panels
        - "TRIPLE_PANEL_BOTTOM/TOP/LEFT/RIGHT": Three panels with specific arrangement
        - "TRIPLE_PANEL_HORIZONTAL": Three horizontal panels
        - "USERDEFINED": Custom partition
    location (List[float], optional): [x, y, z] global position (default: [0.0, 0.0, 1.0])
    rotation (List[float], optional): [rx, ry, rz] rotation angles in degrees (default: [0.0, 0.0, 0.0])
    frame_properties (Dict[str, float], optional): Frame configuration:
        - "lining_depth": Frame depth (default: 0.05)
        - "lining_thickness": Frame thickness (default: 0.05)
        - "lining_offset": Frame offset from wall (default: 0.05)
        - "lining_to_panel_offset_x": X-axis panel offset (default: 0.025)
        - "lining_to_panel_offset_y": Y-axis panel offset (default: 0.025)
        - "mullion_thickness": Vertical divider thickness (default: 0.05)
        - "first_mullion_offset": First mullion position (default: 0.3)
        - "second_mullion_offset": Second mullion position (default: 0.45)
        - "transom_thickness": Horizontal divider thickness (default: 0.05)
        - "first_transom_offset": First transom position (default: 0.3)
        - "second_transom_offset": Second transom position (default: 0.6)
    panel_properties (Dict[str, float], optional): Glass panel properties:
        - "frame_thickness": Panel frame thickness (default: 0.035)
        - "frame_depth": Panel frame depth (default: 0.035)
    custom_panels (List[Dict[str, Any]], optional): Custom panel configurations
    transformation_matrix (List[List[float]], optional): 4x4 transformation matrix
    unit_scale (float, optional): IFC unit scale factor
    part_of_product (Any, optional): Part of product reference
    wall_guid (str, optional): GUID of wall to place window in
    create_opening (bool): Automatically create opening in wall (default: False)
    verbose (bool): Enable detailed logging (default: False)

Usage Examples:
    # Create basic window
    create_window(name="Basic Window")
    
    # Create window with custom dimensions and partition
    create_window(
        name="Office Window",
        dimensions={"width": 1.8, "height": 1.4},
        partition_type="DOUBLE_PANEL_VERTICAL"
    )
    
    # Create window in wall with automatic opening
    create_window(
        name="Wall Window",
        wall_guid="wall-guid-123",
        create_opening=True,
        dimensions={"width": 1.5, "height": 1.3},
        location=[2.0, 0.0, 1.2]
    )
    
    # Create window with custom frame properties
    create_window(
        name="Custom Frame Window",
        dimensions={"width": 2.0, "height": 1.6},
        frame_properties={
            "lining_depth": 0.08,
            "lining_thickness": 0.06,
            "mullion_thickness": 0.08
        }
    )

Returns:
    str: JSON result containing:
        - success (bool): Whether window creation was successful
        - window_guid (str): GUID of created window if successful
        - name (str): Name of the created window
        - dimensions (dict): Applied window dimensions
        - partition_type (str): Applied partition type
        - location (list): Window position coordinates
        - opening_created (bool): Whether wall opening was created
        - message (str): Success/error description
```

---

### `update_window`

```python
update_window(window_guid: str, dimensions: Optional[Dict[str, float]] = None, partition_type: Optional[str] = None, frame_properties: Optional[Dict[str, float]] = None, panel_properties: Optional[Dict[str, float]] = None, custom_panels: Optional[List[Dict[str, Any]]] = None, part_of_product: Optional[Any] = None, touch_overall_attrs: bool = True, verbose: bool = False) -> str
```

Update an existing window using its IFC GUID with new properties.

This function modifies the properties of an existing window, allowing you to
change dimensions, partition types, frame properties, and panel configurations
while preserving the window's position and other unchanged attributes.

Key Features:
- Selective property updates (only specified properties are changed)
- Maintains existing properties not specified in the update
- Automatic representation regeneration
- Support for all partition types and frame configurations
- Preserves window placement and relationships

**Parameters:**

- **window_guid (str): GUID of the existing window to update**
- **dimensions (Dict[str, float], optional): New window dimensions:**
- "width": New window width in meters
- "height": New window height in meters
- **partition_type (str, optional): New partition type if changing panel configuration**
- **frame_properties (Dict[str, float], optional): Updated frame properties:**
- "lining_depth", "lining_thickness", "lining_offset"
- "lining_to_panel_offset_x", "lining_to_panel_offset_y"
- "mullion_thickness", "first_mullion_offset", "second_mullion_offset"
- "transom_thickness", "first_transom_offset", "second_transom_offset"
- **panel_properties (Dict[str, float], optional): Updated panel properties:**
- "frame_thickness": Panel frame thickness
- "frame_depth": Panel frame depth
- **custom_panels (List[Dict[str, Any]], optional): Custom panel configurations**
- **part_of_product (Any, optional): Updated part of product reference**
- **touch_overall_attrs (bool): Update IFC overall width/height attributes (default: True)**
- **verbose (bool): Enable detailed logging (default: False)**
- **Usage Examples:**
  # Update window dimensions only
- **update_window("window-guid-123", dimensions={"width": 1.8, "height": 1.6})**
  # Change partition type and frame properties
  update_window(
  "window-guid-456",
  partition_type="DOUBLE_PANEL_VERTICAL",
- **frame_properties={"mullion_thickness": 0.08}**
  )
  # Update multiple properties
  update_window(
  "window-guid-789",
- **dimensions={"width": 2.0, "height": 1.4},**
  partition_type="TRIPLE_PANEL_VERTICAL",
- **panel_properties={"frame_thickness": 0.04}**
  )
- **Returns:**
- **str: JSON result containing:**
- success (bool): Whether update was successful
- window_guid (str): GUID of updated window
- updated_properties (dict): Properties that were changed
- current_dimensions (dict): Current window dimensions after update
- current_partition_type (str): Current partition type after update
- message (str): Success/error description

---

### `create_trimesh_ifc`

```python
create_trimesh_ifc(trimesh_code: str, ifc_class: str = "IfcBuildingElementProxy", name: Optional[str] = None, location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, parameters: Optional[Dict[str, Any]] = None, result_variable_name: str = "result", properties: Optional[Dict[str, Any]] = None, verbose: bool = False) -> str
```

```python
Execute Trimesh code and create IFC element in one step. Runs Trimesh in MCP server (full environment) then creates IFC element in Blender.

CRITICAL: NEVER use print() statements in trimesh_code - breaks MCP JSON parsing! Use comments (#) instead.

Args:
    trimesh_code (str): Python code creating Trimesh geometry. Must import trimesh, assign final mesh to result_variable_name.
    ifc_class (str): IFC class ("IfcWall", "IfcSlab", "IfcBeam", etc.). Default: "IfcBuildingElementProxy"
    name (str, optional): Element name
    location (List[float], optional): [x,y,z] position in meters
    rotation (List[float], optional): [rx,ry,rz] angles in degrees (ZYX order)
    parameters (Dict[str,Any], optional): Parameters injected into code namespace
    result_variable_name (str): Variable containing final mesh. Default: "result"
    properties (Dict[str,Any], optional): Additional IFC properties
    verbose (bool): Detailed logging

Code Rules: 1) NO print() statements 2) Start with "import trimesh" 3) End with "result = mesh" 4) Only use trimesh, numpy, math 5) Use parameters dict for values

Common Operations: Box(extents=[w,d,h]), Cylinder(radius=r,height=h), Sphere(radius=r), union/difference/intersection, apply_translation/scale

Examples:
    # Simple box
    create_trimesh_ifc('''import trimesh\nresult = trimesh.primitives.Box(extents=[10,0.3,0.5])''', "IfcBeam")
    
    # Parametric wall with opening
    create_trimesh_ifc('''import trimesh\nwall = trimesh.primitives.Box(extents=[length,thickness,height])\nwindow = trimesh.primitives.Box(extents=[window_width,thickness*1.1,window_height])\nwindow.apply_translation([2,0,1])\nresult = wall.difference(window)''', "IfcWall", parameters={"length":8,"thickness":0.2,"height":3,"window_width":1.5,"window_height":1.2})

Returns: JSON with success, element_guid, vertex_count, face_count, is_watertight, volume, message
```

---

### `get_window_properties`

```python
get_window_properties(window_guid: str) -> str
```

```python
Retrieve detailed properties of an existing window by its GUID.

This function extracts comprehensive information about a window including
its current dimensions, partition type, frame properties, panel configurations,
and positioning information. Useful for understanding existing windows before
making modifications or for documentation purposes.

Parameters:
    window_guid (str): GUID of the window to retrieve properties for

Returns:
    str: JSON result containing:
        - success (bool): Whether properties were retrieved successfully
        - window_guid (str): GUID of the queried window
        - name (str): Window name
        - dimensions (dict): Current window dimensions (width, height)
        - partition_type (str): Current partition type
        - location (list): Window position coordinates [x, y, z]
        - rotation (list): Window rotation angles [rx, ry, rz]
        - frame_properties (dict): Current frame/lining properties
        - panel_properties (list): Current panel configurations
        - ifc_class (str): IFC class type ("IfcWindow")
        - predefined_type (str): IFC predefined type
        - message (str): Success/error description

Usage Examples:
    # Get properties of a specific window
    get_window_properties("window-guid-123")
    
    # Retrieve properties for inspection before update
    props = get_window_properties("window-guid-456")
    # Use properties to make informed updates
```

---

### `get_stairs_types`

```python
get_stairs_types() -> str
```

```python
Get all supported stairs types and their IFC mappings.

This function retrieves all available stairs types that can be created,
including their IFC class mappings and descriptions. These types are used
in the stairs_type parameter for creating different kinds of stairs.

Returns:
    str: JSON containing a dictionary of stairs types mapped to their IFC equivalents:
        - STRAIGHT: Maps to STRAIGHT_RUN_STAIR
        - SPIRAL: Maps to SPIRAL_STAIR  
        - L_SHAPED: Maps to QUARTER_TURN_STAIR
        - U_SHAPED: Maps to HALF_TURN_STAIR

Examples:
    result = get_stairs_types()
    # Returns supported stairs types for use in create_stairs function
```

---

### `create_stairs`

```python
create_stairs(width: float, height: float, stairs_type: str = "STRAIGHT", num_steps: Optional[int] = None, length: float = 4.0, riser_height: Optional[float] = None, radius: Optional[float] = None, landing_width: Optional[float] = None, landing_depth: Optional[float] = None, name: Optional[str] = None, location: Optional[List[float]] = None, rotation: Optional[List[float]] = None, transformation_matrix: Optional[List[List[float]]] = None, unit_scale: Optional[float] = None, verbose: bool = False) -> str
```

Create parametric IfcStair using IFC mesh representation.

This function creates various types of stairs with configurable parameters,
including automatic calculation of steps and riser heights based on standard
building codes. Supports straight, spiral, L-shaped, and U-shaped configurations.

**Parameters:**

- **width (float): Stairs width in meters (must be > 0).**
- **height (float): Total height in meters (must be > 0).**
- **stairs_type (str): Type of stairs - options: STRAIGHT, SPIRAL, L_SHAPED, U_SHAPED,**
- **CURVED, WINDING, BIFURCATED, NOTDEFINED, USERDEFINED (default: "STRAIGHT").**
- **num_steps (int, optional): Number of steps. If None, auto-calculated based on ideal riser height.**
- **length (float): Length of each tread in meters (default: 4.0).**
- **riser_height (float, optional): Height of each riser in meters. If None, auto-calculated.**
- **radius (float, optional): Radius for spiral stairs in meters. If None, auto-calculated as width * 1.5.**
- **landing_width (float, optional): Landing width for L/U shaped stairs. If None, defaults to width.**
- **landing_depth (float, optional): Landing depth for L/U shaped stairs. If None, defaults to width * 2.**
- **name (str, optional): Custom name for the stairs. If None, auto-generated.**
- **location (List[float], optional): [x, y, z] position offset (default: [0, 0, 0]).**
- **rotation (List[float], optional): [rx, ry, rz] rotation angles in degrees (default: [0, 0, 0]).**
- **transformation_matrix (List[List[float]], optional): 4x4 transformation matrix.**
- **unit_scale (float, optional): IFC unit scale factor. If None, auto-calculated.**
- **verbose (bool): Enable detailed operation logging (default: False).**
- **Returns:**
- **str: JSON containing creation results:**
- success (bool): Whether creation was successful
- stairs_guid (str): GUID of created stairs if successful
- name (str): Name of the created stairs
- stairs_type (str): IFC stairs type used
- width (float): Applied width
- height (float): Applied height
- num_steps (int): Number of steps created
- vertices_count (int): Number of vertices in the mesh
- faces_count (int): Number of faces in the mesh
- error (str): Error message if unsuccessful
- **Examples:**
  # Create simple straight stairs
  create_stairs(width=1.2, height=3.0)
  # Create spiral stairs with custom radius
  create_stairs(width=1.5, height=2.8, stairs_type="SPIRAL", radius=1.0)
  # Create L-shaped stairs with landing
  create_stairs(width=1.0, height=3.5, stairs_type="L_SHAPED", landing_width=1.2)

---

### `update_stairs`

```python
update_stairs(stairs_guid: str, width: Optional[float] = None, height: Optional[float] = None, stairs_type: Optional[str] = None, num_steps: Optional[int] = None, name: Optional[str] = None, verbose: bool = False) -> str
```

Update existing stairs properties and regenerate geometry.

This function allows modification of existing stairs by regenerating their
geometry with new parameters. Only the parameters that are provided will be updated,
others will retain their current values.

**Parameters:**

- **stairs_guid (str): The GUID of the stairs to update (required).**
- **width (float, optional): New stairs width in meters.**
- **height (float, optional): New stairs height in meters.**
- **stairs_type (str, optional): New stairs type (STRAIGHT, SPIRAL, L_SHAPED, U_SHAPED).**
- **num_steps (int, optional): New number of steps.**
- **name (str, optional): New name for the stairs.**
- **verbose (bool): Enable detailed operation logging (default: False).**
- **Returns:**
- **str: JSON containing update results:**
- success (bool): Whether update was successful
- stairs_guid (str): GUID of the updated stairs
- message (str): Success/error description
- error (str): Error message if unsuccessful
- **Examples:**
  # Update stairs dimensions
  update_stairs(stairs_guid="abc123", width=1.5, height=3.2)
  # Change stairs type and number of steps
  update_stairs(stairs_guid="def456", stairs_type="SPIRAL", num_steps=20)
  # Rename stairs
  update_stairs(stairs_guid="ghi789", name="Main Staircase")

---

### `delete_stairs`

```python
delete_stairs(stairs_guids: List[str]) -> str
```

Delete one or more stairs by their IFC GUIDs.

This function removes stairs from both the IFC model and the Blender scene,
including any associated representations and spatial relationships.

**Parameters:**

- **stairs_guids (List[str]): List of stairs GUIDs to delete.**
- **Returns:**
- **str: JSON containing deletion results:**
- success (bool): Whether any stairs were successfully deleted
- deleted_count (int): Number of stairs successfully deleted
- errors (List[str]): List of error messages for failed deletions
- message (str): Summary message
- **Examples:**
  # Delete single stairs
  delete_stairs(stairs_guids=["abc123"])
  # Delete multiple stairs
  delete_stairs(stairs_guids=["abc123", "def456", "ghi789"])

---

### `create_surface_style`

```python
create_surface_style(name: str = "New Style", color: Optional[List[float]] = None, transparency: float = 0.0, style_type: str = "shading", verbose: bool = False) -> str
```

Create a basic surface style with color and transparency.

This function creates IFC-compliant surface styles that can be applied to materials
or objects for visual appearance control. Supports both basic shading and advanced
rendering styles with full color and transparency control.

**Parameters:**

- **name (str): Name of the style (default: "New Style").**
- **color (List[float], optional): RGB color values [R, G, B] from 0-1.**
  If None, defaults to [0.8, 0.8, 0.8].
- **transparency (float): Transparency value 0-1 (0=opaque, 1=transparent) (default: 0.0).**
- **style_type (str): Type of style - "shading" for basic color, "rendering" for advanced (default: "shading").**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing creation results:**
- success (bool): Whether style creation was successful
- style_guid (str): GUID of created style if successful
- style_name (str): Name of the created style
- color (List[float]): Applied RGB color values
- transparency (float): Applied transparency value
- message (str): Success/error description
- **Examples:**
  # Basic red surface style
  create_surface_style(name="Red Wall", color=[1.0, 0.0, 0.0])
  # Transparent glass style
  create_surface_style(name="Glass", color=[0.8, 0.9, 1.0], transparency=0.7)
  # Advanced rendering style
  create_surface_style(
  name="Premium Material",
  color=[0.6, 0.4, 0.2],
  style_type="rendering"
  )

---

### `create_pbr_style`

```python
create_pbr_style(name: str = "PBR Style", diffuse_color: Optional[List[float]] = None, metallic: float = 0.0, roughness: float = 0.5, transparency: float = 0.0, emissive_color: Optional[List[float]] = None, verbose: bool = False) -> str
```

Create a PBR (Physically Based Rendering) style with advanced material properties.

This function creates sophisticated material styles using PBR principles for
realistic rendering. Supports metallic workflows, roughness control, emissive
properties, and transparency for professional architectural visualization.

**Parameters:**

- **name (str): Name of the PBR style (default: "PBR Style").**
- **diffuse_color (List[float], optional): Base diffuse color [R, G, B] from 0-1.**
  If None, defaults to [0.8, 0.8, 0.8].
- **metallic (float): Metallic factor 0-1 (0=dielectric, 1=metallic) (default: 0.0).**
- **roughness (float): Roughness factor 0-1 (0=mirror, 1=completely rough) (default: 0.5).**
- **transparency (float): Transparency 0-1 (0=opaque, 1=transparent) (default: 0.0).**
- **emissive_color (List[float], optional): Emissive color [R, G, B] from 0-1.**
  If None, defaults to [0.0, 0.0, 0.0].
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing creation results:**
- success (bool): Whether PBR style creation was successful
- style_guid (str): GUID of created style if successful
- style_name (str): Name of the created style
- diffuse_color (List[float]): Applied diffuse color values
- metallic (float): Applied metallic factor
- roughness (float): Applied roughness factor
- transparency (float): Applied transparency value
- emissive_color (List[float]): Applied emissive color values
- message (str): Success/error description
- **Examples:**
  # Metallic material (steel, aluminum)
  create_pbr_style(
  name="Steel",
  diffuse_color=[0.5, 0.5, 0.5],
  metallic=0.9,
  roughness=0.1
  )
  # Wood material
  create_pbr_style(
  name="Oak Wood",
  diffuse_color=[0.6, 0.4, 0.2],
  metallic=0.0,
  roughness=0.8
  )
  # Emissive material (LED strip)
  create_pbr_style(
  name="LED Strip",
  diffuse_color=[1.0, 1.0, 0.9],
  emissive_color=[1.0, 1.0, 0.5]
  )

---

### `apply_style_to_object`

```python
apply_style_to_object(object_guids: Union[str, List[str]], style_name: str, verbose: bool = False) -> str
```

Apply a style directly to one or more IFC objects' representations.

This function applies visual styles directly to IFC objects, affecting their
appearance in both the IFC model and Blender visualization. The style is
applied to the objects' geometric representations. Processing multiple objects
in a single call is much more efficient than individual calls.

**Parameters:**

- **object_guids (Union[str, List[str]]): Single GUID string or list of GUID strings**
  of IFC objects to style.
- **style_name (str): Name of the style to apply.**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing batch application results:**
- success (bool): Whether the overall operation was successful
- style_name (str): Name of the applied style
- total_objects (int): Total number of objects processed
- successful_objects (list): List of successfully styled objects with details
- failed_objects (list): List of failed objects with error details
- total_styled_items (int): Total number of representation items styled
- message (str): Overall operation summary
- **Examples:**
  # Apply style to single object
  apply_style_to_object(
  object_guids="1AbCdEfGhIjKlMnOp",
  style_name="Red Wall"
  )
  # Apply style to multiple objects (much faster)
  apply_style_to_object(
  object_guids=["1AbCdEfGhIjKlMnOp", "2BcDeFgHiJkLmNoP", "3CdEfGhIjKlMnOpQ"],
  style_name="Concrete Grey"
  )

---

### `list_styles`

```python
list_styles() -> str
```

List all available styles in the current IFC model.

This function retrieves comprehensive information about all styles defined
in the current IFC model, including their properties, colors, and material
characteristics for easy reference and management.

Returns:
    str: JSON containing styles information:
        - success (bool): Whether the listing was successful
        - styles (List[Dict]): List of style dictionaries containing:
            - name (str): Style name
            - id (str): Style ID
            - type (str): Style type (usually "IfcSurfaceStyle")
            - color (List[float]): RGB color values (if basic style)
            - transparency (float): Transparency value (if applicable)
            - surface_color (List[float]): Surface color (if rendering style)
            - diffuse_color (List[float]): Diffuse color (if PBR style)
            - metallic (float): Metallic factor (if PBR style)
            - roughness (float): Roughness factor (if PBR style)
            - style_type (str): "Shading" or "Rendering/PBR"
        - count (int): Total number of styles
        - message (str): Summary message

Examples:
    # List all styles in the model
    styles_info = list_styles()
    
    # Use the returned information to see available styles before applying
    print(f"Found {styles_info['count']} styles")
    for style in styles_info['styles']:
        print(f"- {style['name']}: {style.get('color', 'No color info')}")

---

### `update_style`

```python
update_style(style_name: str, color: Optional[List[float]] = None, transparency: Optional[float] = None, metallic: Optional[float] = None, roughness: Optional[float] = None, verbose: bool = False) -> str
```

Update properties of an existing style.

This function allows modification of existing style properties without
recreating the style. Only the parameters that are provided will be updated,
others will retain their current values.

**Parameters:**

- **style_name (str): Name of the style to update.**
- **color (List[float], optional): New RGB color values [R, G, B] from 0-1.**
- **transparency (float, optional): New transparency value 0-1.**
- **metallic (float, optional): New metallic factor 0-1 (for PBR styles).**
- **roughness (float, optional): New roughness factor 0-1 (for PBR styles).**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing update results:**
- success (bool): Whether style update was successful
- style_name (str): Name of the updated style
- updated_properties (List[str]): List of properties that were updated
- message (str): Success/error description
- **Examples:**
  # Update color only
  update_style(style_name="Red Wall", color=[0.8, 0.2, 0.2])
  # Update multiple PBR properties
  update_style(
  style_name="Steel",
  metallic=0.95,
  roughness=0.05
  )
  # Add transparency to existing style
  update_style(style_name="Glass", transparency=0.8)

---

### `remove_style`

```python
remove_style(style_name: str, verbose: bool = False) -> str
```

Remove a style from the model.

This function removes a style definition from the IFC model. Note that
removing a style that is currently applied to materials or objects may
affect their appearance.

**Parameters:**

- **style_name (str): Name of the style to remove.**
- **verbose (bool): Enable detailed logging (default: False).**
- **Returns:**
- **str: JSON containing removal results:**
- success (bool): Whether style removal was successful
- style_name (str): Name of the removed style
- message (str): Success/error description
- **Examples:**
  # Remove an unused style
  remove_style(style_name="Old Style")
  # Remove style with verbose logging
  remove_style(style_name="Temp Style", verbose=True)
- **Warning:**
  Removing a style that is currently applied to materials or objects
  may cause those elements to lose their visual appearance properties.

---

### `create_mesh_ifc`

```python
create_mesh_ifc(items: List[Dict[str, Any]], ifc_class: str = "IfcBuildingElementProxy", name: Optional[str] = None, predefined_type: Optional[str] = None, placement: Optional[List[List[float]]] = None, force_faceted_brep: bool = False, apply_solidify: bool = False, solidify_thickness: float = 0.1, properties: Optional[Dict[str, Any]] = None, verbose: bool = False) -> str
```

```python
Create an IFC element from JSON mesh data.

This function creates IFC elements from mesh data provided as JSON format.
It validates and sanitizes mesh data, then converts it to IFC representation.

Args:
    ctx (Context): The MCP context (not used directly).
    items (List[Dict]): List of mesh items, each with 'vertices' and 'faces'
        - Each item must have:
          - "vertices": List of [x, y, z] coordinates as floats
          - "faces": List of face indices (see Face Format below), no nested list allowed. It should be mx4 size
    ifc_class (str): IFC element class name (default: "IfcBuildingElementProxy")
        Valid classes: "IfcWall", "IfcRoof", "IfcSlab", "IfcBeam", "IfcColumn", etc.
    name (str, optional): Name for the element
    predefined_type (str, optional): Predefined type for the IFC element
    placement (List[List[float]], optional): 4x4 transformation matrix
    force_faceted_brep (bool): Use IfcFacetedBrep for closed meshes (default: False)
    apply_solidify (bool): Apply solidification in Blender if available (default: False)
    solidify_thickness (float): Thickness for solidification (default: 0.1)
    properties (Dict, optional): Additional properties to store in property set
    verbose (bool): Print debug information (default: False)

Face Format:
    SIMPLE FORMAT (RECOMMENDED): Each face is a list of vertex indices
    - faces: [[0,1,2,3], [4,5,6,7], ...]
    - Each face must have at least 3 vertices
    - Vertices are referenced by their index in the vertices array
    
    IMPORTANT: Faces with holes (nested arrays) are NOT SUPPORTED in this version.
    For walls with openings, create separate geometry or use boolean operations.

Returns:
    str: JSON containing creation results with element GUID and status

Examples:
    # Simple box
    create_mesh_ifc(
        items=[{
            "vertices": [
                [0,0,0], [2,0,0], [2,3,0], [0,3,0],
                [0,0,1], [2,0,1], [2,3,1], [0,3,1]
            ],
            "faces": [
                [0,1,2,3], [4,7,6,5], [0,4,5,1],
                [2,6,7,3], [0,3,7,4], [1,5,6,2]
            ]
        }],
        ifc_class="IfcWall",
        name="Simple Wall"
    )
    
    # Triangle mesh
    create_mesh_ifc(
        items=[{
            "vertices": [[0,0,0], [1,0,0], [0.5,0,1]],
            "faces": [[0,1,2]]
        }],
        ifc_class="IfcRoof"
    )
```

---

### `list_ifc_entities`

```python
list_ifc_entities(schema_version: Optional[str] = None) -> str
```

List valid IFC entity classes for mesh generation.

This function returns all valid IFC element classes that can be used
with the create_mesh_ifc function for the current or specified schema.

**Parameters:**

- **ctx (Context): The MCP context (not used directly).**
- **schema_version (str, optional): Schema version (IFC2X3, IFC4, etc.)**
  If not provided, uses the current file's schema.
- **Returns:**
- **str: JSON containing schema info and list of valid entity classes**
- **Examples:**
  # Get entities for current schema
  list_ifc_entities()
  # Get entities for specific schema
  list_ifc_entities(schema_version="IFC4")

---

### `get_trimesh_examples`

```python
get_trimesh_examples() -> str
```

Get comprehensive Trimesh code examples for various architectural elements.

This function returns a collection of Trimesh code examples specifically
designed for creating building elements. Each example includes complete
working code, descriptions, and recommended IFC classes.

Returns:
    str: JSON with example code snippets, usage tips, and Trimesh reference

Examples include:
- Simple boxes and beams
- Walls with openings (windows, doors)
- Cylindrical columns
- L-shaped walls using polygon extrusion
- Stepped foundations
- Boolean operations
- Custom meshes from vertices
- And many more architectural elements

Each example shows:
- Complete Trimesh code
- Recommended IFC class
- Description of the geometry
- Common use cases

---

## Rag Tools
*File: `rag_tools.py`*

This module contains 8 tool(s):

### `ensure_ifc_knowledge_ready`

```python
ensure_ifc_knowledge_ready(force_rebuild: bool = False, timeout_seconds: int = 30) -> str
```

Complete IFC knowledge system initialization for local model only.

**Parameters:**

- **force_rebuild: Rebuild the index even if it exists**
- **timeout_seconds: Maximum time to wait for initialization**
- **Returns:**
  JSON status with initialization results

---

### `search_ifc_knowledge`

```python
search_ifc_knowledge(query: str, context_type: Optional[str] = None, module: Optional[str] = None, max_results: int = 5) -> str
```

Search the IFC OpenShell knowledge base for functions, modules, and documentation.

This tool performs semantic search across the entire IFC knowledge base using
advanced retrieval techniques. Results include functions, examples, and documentation
relevant to your query. Designed for instant performance after initialization.

**Parameters:**

- **query (str): Natural language search query describing what you're looking for.**
- **Examples: "create wall", "assign material", "spatial structure"**
- **context_type (Optional[str]): Filter by content type:**
- 'function': Only function definitions and signatures
- 'module': Only module information and descriptions
- 'workflow': Usage patterns and workflows
- None: Search all content types
- **module (Optional[str]): Limit search to specific IFC module:**
- 'root': Core entity operations
- 'material': Material and properties
- 'geometry': Geometric representations
- 'spatial': Spatial relationships
- None: Search all modules
- **max_results (int): Maximum number of results to return (default: 5, max: 20)**
- **Returns:**
- **str: JSON response containing:**
- query: The search query used
- results_count: Number of results found
- results: Array of search results, each containing:
- type: Content type ('function', 'module', etc.)
- module: IFC module name
- function: Function name (if applicable)
- description: Relevant description or documentation
- signature: Function signature (if applicable)
- parameters: Function parameters (if applicable)
- returns: Return type (if applicable)
- examples: Usage examples (if available)
- search_time: Time taken for the search in seconds
- status: Search status ('success', 'error', 'not_ready')
- cache_hit: Whether result came from cache
- **Example:**
  >>> search_ifc_knowledge("create wall", max_results=3)
  {
- **"query": "create wall",**
- **"results_count": 3,**
- **"results": [**
  {
- **"type": "function",**
- **"module": "root",**
- **"function": "create_wall",**
- **"description": "Creates a new IFC wall entity",**
- **"signature": "create_wall(length, height, thickness)"**
  }
  ],
- **"search_time": 0.023**
  }
- **Note:**
  Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.

---

### `get_ifc_knowledge_status`

```python
get_ifc_knowledge_status() -> str
```

Get the current status of the IFC knowledge base system.

This tool provides a comprehensive overview of the system's initialization state,
cache statistics, and readiness for operations. Use this to check if the system
is ready for instant operations or needs initialization.

Returns:
    str: JSON response containing:
        - ready_for_instant_operations: Boolean indicating if system is ready
        - fully_initialized: Boolean indicating complete initialization
        - knowledge_store_loaded: Boolean indicating if knowledge store is loaded
        - retriever_loaded: Boolean indicating if retriever is loaded
        - initialization_error: Any initialization error message (if failed)
        - cached_searches: Number of cached search results
        - cached_modules: Number of cached module information entries
        - status: Overall status ('ready', 'error', 'not_initialized')
        - message: Human-readable status message
        - stats: Detailed initialization statistics (if available)

Example:
    >>> get_ifc_knowledge_status()
    {
        "ready_for_instant_operations": true,
        "status": "ready",
        "message": "All systems ready - operations are instant",
        "cached_searches": 15,
        "cached_modules": 8
    }

Note:
    If status is 'not_initialized', call ensure_ifc_knowledge_ready() to initialize.

---

### `find_ifc_function`

```python
find_ifc_function(operation: str, object_type: Optional[str] = None, module: Optional[str] = None) -> str
```

Find IFC functions by operation type and object type - instant operation after initialization.

This tool searches the IFC knowledge base for functions that match the specified operation
and object type. It's designed for instant performance after the initial setup.

**Parameters:**

- **operation (str): The operation to search for (e.g., 'create', 'assign', 'delete', 'get')**
- **object_type (Optional[str]): Specific IFC object type to filter by (e.g., 'wall', 'slab', 'beam')**
- **module (Optional[str]): Specific IFC module to search in (e.g., 'root', 'material', 'geometry')**
- **Returns:**
- **str: JSON response containing:**
- operation: The search operation used
- object_type: The object type filter used
- functions_found: Number of matching functions found
- functions: Array of function objects with details:
- module: IFC module name
- function: Function name
- full_path: Complete module path
- signature: Function signature (if available)
- description: Function description (if available)
- parameters: Function parameters (if available)
- returns: Return type (if available)
- usage: Usage example (if available)
- search_time: Time taken for the search in seconds
- message: Additional status message
- **Example:**
  >>> find_ifc_function("create", "wall")
  Returns functions for creating walls
  >>> find_ifc_function("assign", "material", "material")
  Returns material assignment functions
- **Note:**
  Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.

---

### `get_ifc_module_info`

```python
get_ifc_module_info(module_name: str) -> str
```

Get detailed information about a specific IFC module - instant operation after initialization.

This tool retrieves comprehensive information about IFC modules including their functions,
descriptions, and usage statistics. Information is cached for instant subsequent access.

**Parameters:**

- **module_name (str): Name of the IFC module to get information for. Common modules include:**
- 'root': Core IFC entity creation and management
- 'material': Material and material layer operations
- 'geometry': Geometric representation and transformations
- 'spatial': Spatial structure and relationships
- 'attribute': Property sets and attributes
- 'aggregate': Aggregation and grouping operations
- 'type': Type definitions and relationships
- **Returns:**
- **str: JSON response containing:**
- module: The module name requested
- description: Module description and purpose
- functions: List of functions available in the module
- function_count: Total number of functions in the module
- search_time: Time taken for the lookup in seconds
- available_modules: List of all available modules (if module not found)
- **Example:**
  >>> get_ifc_module_info("material")
  {
- **"module": "material",**
- **"description": "Material and material layer operations",**
- **"function_count": 25,**
- **"functions": ["create_material", "assign_material", ...]**
  }
- **Note:**
  Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.

---

### `get_ifc_function_details`

```python
get_ifc_function_details(function_name: str, module: Optional[str] = None) -> str
```

Get detailed information about a specific IFC function - instant operation after initialization.

This tool provides comprehensive details about IFC functions including their signatures,
parameters, return types, documentation, and usage examples. Results are cached for
instant subsequent access.

**Parameters:**

- **function_name (str): Name of the IFC function to get details for**
- **module (Optional[str]): Specific module to search in (speeds up search if known)**
- **Returns:**
- **str: JSON response containing:**
- function: The function name requested
- module: The module containing the function
- full_path: Complete module path to the function
- signature: Function signature with parameters
- description: Detailed function description
- parameters: List of function parameters with types
- returns: Return type information
- examples: Usage examples and code snippets
- search_time: Time taken for the lookup in seconds
- similar_functions: Alternative functions if exact match not found
- **Example:**
  >>> get_ifc_function_details("create_wall")
  {
- **"function": "create_wall",**
- **"module": "root",**
- **"signature": "create_wall(length: float, height: float, thickness: float)",**
- **"description": "Creates a new IFC wall entity with specified dimensions",**
- **"parameters": [{"name": "length", "type": "float"}, ...],**
- **"examples": ["wall = create_wall(5.0, 3.0, 0.2)"]**
  }
- **Note:**
  Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.

---

### `clear_ifc_knowledge_cache`

```python
clear_ifc_knowledge_cache() -> str
```

Clear all cached IFC knowledge data to free memory or force fresh lookups.

This tool clears the internal caches used for instant performance. Use this when:
- Memory usage needs to be reduced
- You want to force fresh lookups from the knowledge base
- Cache corruption is suspected
- Testing cache behavior

Returns:
    str: JSON response containing:
        - status: Operation status ('cache_cleared')
        - message: Confirmation message
        - previous_cache_sizes: Cache sizes before clearing:
            - function_cache_entries: Number of cached function searches
            - module_cache_entries: Number of cached module information entries

Example:
    >>> clear_ifc_knowledge_cache()
    {
        "status": "cache_cleared",
        "message": "All caches cleared - next operations will rebuild cache",
        "previous_cache_sizes": {
            "function_cache_entries": 15,
            "module_cache_entries": 8
        }
    }

Note:
    Cache will be rebuilt automatically on subsequent operations. This does not
    affect the underlying knowledge base, only the performance caches.

---

### `get_cache_statistics`

```python
get_cache_statistics() -> str
```

Get detailed statistics about the IFC knowledge cache usage and patterns.

This tool provides insights into cache performance, usage patterns, and system
statistics. Useful for monitoring performance and understanding cache behavior.

Returns:
    str: JSON response containing:
        - function_cache_entries: Number of cached function search results
        - module_cache_entries: Number of cached module information entries
        - cached_modules: List of module names currently cached
        - cache_types: Breakdown of cache entry types by category
        - system_stats: Complete system initialization statistics
        - most_cached_queries: Analysis of frequently cached queries

Example:
    >>> get_cache_statistics()
    {
        "function_cache_entries": 23,
        "module_cache_entries": 12,
        "cached_modules": ["root", "material", "geometry"],
        "cache_types": {
            "function_search": 15,
            "search": 8
        },
        "system_stats": {
            "document_count": 1250,
            "initialization_time": 8.45
        }
    }

Note:
    This provides diagnostic information about cache usage patterns and system performance.

---
