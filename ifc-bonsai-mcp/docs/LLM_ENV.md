# LLM Environment Helpers (IFC Bonsai MCP)

The following helpers are importable from `blender_addon.api` when executing Python code via the MCP `execute_blender_code` tool or the addon's `execute_code` command. Use these to access the IFC model, containers, selection, and to sync changes.

- get_ifc_file: Returns the current `ifcopenshell.file`.
  Import: `from blender_addon.api.ifc_utils import get_ifc_file`

- get_default_container: Returns a suitable spatial container (e.g., IfcBuildingStorey).
  Import: `from blender_addon.api.ifc_utils import get_default_container`

- save_and_reload: Persists and reloads the IFC so Blender's viewport updates.
  Import: `from blender_addon.api.ifc_utils import save_and_load_ifc as save_and_reload`

- get_selected_objects: Returns selected Blender objects with IFC GUIDs (if any).
  Import: `from blender_addon.api.scene import get_selected_objects`

- get_object_info: Returns detailed IFC info by GUID(s) or current selection.
  Import: `from blender_addon.api.scene import get_object_info`

Recommended code prelude for generated scripts:

```python
import ifcopenshell
import ifcopenshell.api
from blender_addon.api.ifc_utils import get_ifc_file, get_default_container, save_and_load_ifc as save_and_reload

ifc_file = get_ifc_file()
model = ifc_file

def sync_ifc():
    try:
        save_and_reload()
    except Exception:
        pass
```

Notes:
- All parameters and return values should be JSON-serializable when used via MCP tools.
- Prefer using `ifcopenshell.api` functions for IFC operations.
- After creating or modifying elements, call `sync_ifc()` to refresh the viewport.

