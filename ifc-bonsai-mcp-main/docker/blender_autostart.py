"""
blender_autostart.py — runs inside Blender's Python interpreter at startup.

Blender is launched via:
  blender -b --addons blendermcp --python /app/docker/blender_autostart.py

This script:
1. Ensures the blendermcp addon is enabled.
2. Starts the socket server on port 9876 so the MCP Python server can connect.
3. Keeps Blender alive processing events (required for bpy.app.timers to work).
"""

import bpy
import sys
import os

print("=== BlenderMCP Autostart: initialising ===")

# ── Ensure Blender can find the addon module ───────────────────────────────
# The addon is installed as a folder named 'blendermcp' inside Blender's
# scripts/addons directory. Add its PARENT to sys.path so we can import it.
import addon_utils as _au
for _mod in _au.modules():
    if _mod.bl_info.get("name") == "Blender MCP":
        _addon_dir = os.path.dirname(_mod.__file__)
        _addons_parent = os.path.dirname(_addon_dir)
        if _addons_parent not in sys.path:
            sys.path.insert(0, _addons_parent)
        print(f"  [INFO] blendermcp addon dir: {_addon_dir}")
        break

# ── Ensure addon is registered ─────────────────────────────────────────────
try:
    import addon_utils
    addon_utils.enable("blendermcp", default_set=True, persistent=True)
    print("  [OK] blendermcp addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable blendermcp addon: {e}")

# ── Start the socket server ────────────────────────────────────────────────
# The addon folder is named 'blendermcp' so its submodules are accessed as
# blendermcp.core — NOT blender_addon.core.
try:
    from blendermcp.core import create_server_instance
    server = create_server_instance(port=9876)
    server.start()
    print("  [OK] BlenderMCP socket server started on port 9876.")
except Exception as e:
    print(f"  [WARN] Could not start BlenderMCP server via blendermcp.core: {e}")

    # Fallback: try via bpy operator if the addon registered one
    try:
        bpy.ops.blendermcp.start_server()
        print("  [OK] BlenderMCP server started via bpy operator.")
    except Exception as e2:
        print(f"  [ERROR] All BlenderMCP server start attempts failed: {e2}")

print("=== BlenderMCP Autostart: running event loop ===")

# ── Keep Blender alive with a persistent timer ─────────────────────────────
# Without this, Blender exits immediately after the--python script returns
# in -b mode. The timer keeps the event loop alive so bpy.app.timers and
# the socket server thread can continue to process commands.
def keep_alive():
    """Re-schedule itself every second to keep Blender's event loop running."""
    return 1.0

bpy.app.timers.register(keep_alive, first_interval=1.0, persistent=True)
print("  [OK] Keep-alive timer registered. Blender running indefinitely in background.")
