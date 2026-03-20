"""
blender_autostart.py — runs inside Blender's Python interpreter at startup.
# pyre-ignore-all-errors
"""
import sys
import os
import bpy  # type: ignore

print("=== BlenderMCP Autostart: initialising ===")

DOCKER_ADDON_PATH = "/opt/blender-4.4.3-linux-x64/4.4/scripts/addons"
if os.path.exists(DOCKER_ADDON_PATH) and DOCKER_ADDON_PATH not in sys.path:
    sys.path.insert(0, DOCKER_ADDON_PATH)

import addon_utils as _au  # type: ignore
_found = False
for _mod in _au.modules():  # type: ignore
    if getattr(_mod, "bl_info", {}).get("name") == "Blender MCP":
        _addon_dir = os.path.dirname(getattr(_mod, "__file__", ""))
        _addons_parent = os.path.dirname(_addon_dir)
        if _addons_parent and str(_addons_parent) not in sys.path:
            sys.path.insert(0, str(_addons_parent))
        _found = True
        break

try:
    _au.enable("blendermcp", default_set=True, persistent=True)  # type: ignore
    print("  [OK] blendermcp addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable blendermcp addon: {e}")

try:
    from blendermcp.core import create_server_instance  # type: ignore
    server = create_server_instance(port=9876)  # type: ignore
    server.start()  # type: ignore
    print("  [OK] BlenderMCP socket server started on port 9876.")
except Exception as e:
    print(f"  [WARN] Could not start BlenderMCP server: {e}")

def keep_alive():
    return 1.0

try:
    if not bpy.app.timers.is_registered(keep_alive):  # type: ignore
        bpy.app.timers.register(keep_alive, first_interval=1.0, persistent=True)  # type: ignore
except Exception:
    pass

# Keep Blender alive in headless mode
import time
print("=== BlenderMCP is now running and keeping the process alive ===")
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("=== BlenderMCP shutting down ===")

