"""
blender_autostart.py — runs inside Blender's Python interpreter at startup.

Blender is launched via:
  blender -b --addons blendermcp --python /app/docker/blender_autostart.py

This script:
1. Ensures the blendermcp addon is enabled and its path is in sys.path.
2. Starts the socket server on port 9876 so the MCP Python server can connect.
3. Registers a persistent timer to keep Blender's event loop alive in background mode.
"""

import bpy
import sys
import os

print("=== BlenderMCP Autostart: initialising ===")

# ── Ensure Blender can find the addon module ───────────────────────────────
# In Docker, we know exactly where it is. For local execution, we fallback to
# addon_utils. This ensures 'import blendermcp' works even if Blender hasn't
# fully scanned the addons directory yet.
DOCKER_ADDON_PATH = "/opt/blender-4.4.3-linux-x64/4.4/scripts/addons"
if os.path.exists(DOCKER_ADDON_PATH) and DOCKER_ADDON_PATH not in sys.path:
    sys.path.insert(0, DOCKER_ADDON_PATH)

import addon_utils as _au
_found = False
for _mod in _au.modules():
    if getattr(_mod, "bl_info", {}).get("name") == "Blender MCP":
        _addon_dir = os.path.dirname(_mod.__file__)
        _addons_parent = os.path.dirname(_addon_dir)
        if _addons_parent not in sys.path:
            sys.path.insert(0, str(_addons_parent))
        print(f"  [INFO] blendermcp addon found at: {_addon_dir}")
        _found = True
        break

if not _found:
     # Final safety: add /app/blender_addon parent to path if everything else fails
     # but we are in the repository directory
     _repo_addon_parent = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
     if _repo_addon_parent not in sys.path:
         sys.path.insert(0, _repo_addon_parent)

# ── Ensure addon is registered and enabled ─────────────────────────────────
try:
    import addon_utils
    # The folder name is 'blendermcp' (as per the Dockerfile install step)
    addon_utils.enable("blendermcp", default_set=True, persistent=True)
    print("  [OK] blendermcp addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable blendermcp addon: {e}")

# ── Start the socket server ────────────────────────────────────────────────
# The addon folder is named 'blendermcp' so its submodules are accessed as
# blendermcp.core. 
try:
    # Use the exported factory function to get/create the singleton server
    from blendermcp.core import create_server_instance
    server = create_server_instance(port=9876)
    server.start()
    print("  [OK] BlenderMCP socket server started on port 9876.")
except Exception as e:
    print(f"  [WARN] Could not start BlenderMCP server via blendermcp.core: {e}")
    # Fallback to operator in case addon registration finished but imports are weird
    try:
        if hasattr(bpy.ops, "blendermcp"):
            bpy.ops.blendermcp.start_server()
            print("  [OK] BlenderMCP server started via bpy operator.")
        else:
            print("  [ERROR] blendermcp operator not found.")
    except Exception as e2:
        print(f"  [ERROR] All BlenderMCP server start attempts failed: {e2}")

print("=== BlenderMCP Autostart: running event loop ===")

# ── Keep Blender alive with a persistent timer ─────────────────────────────
# Without this, Blender exits immediately after the --python script returns
# in -b (background) mode. The timer keeps the event loop alive so 
# bpy.app.timers and the socket server thread can continue processing commands.
def keep_alive():
    """Re-schedule itself every second to keep Blender's event loop running."""
    return 1.0

if not bpy.app.timers.is_registered(keep_alive):
    bpy.app.timers.register(keep_alive, first_interval=1.0, persistent=True)
    print("  [OK] Keep-alive timer registered.")

print("  [INFO] Blender background process is now running and listening on port 9876.")
