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
import time
import threading
import sys

print("=== BlenderMCP Autostart: initialising ===")

# ── Ensure addon is registered ─────────────────────────────────────────────
try:
    import addon_utils
    addon_utils.enable("blendermcp", default_set=True, persistent=True)
    print("  [OK] blendermcp addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable blendermcp addon: {e}")

# ── Start the socket server ────────────────────────────────────────────────
try:
    from blender_addon.core import create_server_instance
    server = create_server_instance(port=9876)
    server.start()
    print("  [OK] BlenderMCP socket server started on port 9876.")
except Exception as e:
    print(f"  [WARN] Could not start BlenderMCP server via import: {e}")

    # Fallback: try via bpy operator if registered
    try:
        bpy.ops.blendermcp.start_server()
        print("  [OK] BlenderMCP server started via bpy operator.")
    except Exception as e2:
        print(f"  [ERROR] All BlenderMCP server start attempts failed: {e2}")

print("=== BlenderMCP Autostart: running event loop ===")

# ── Keep Blender alive with a minimal timer loop ───────────────────────────
# Without this, Blender exits immediately in -b (background) mode after
# running the Python script. We need it to stay alive so the socket server
# keeps processing commands via bpy.app.timers.
def keep_alive():
    """Keep Blender alive by re-scheduling itself every second."""
    return 1.0  # return delay in seconds for next call

bpy.app.timers.register(keep_alive, first_interval=1.0, persistent=True)

# Block the script from returning (Blender exits if the script returns in -b mode)
print("  [OK] Timer registered. Blender will run indefinitely in background mode.")
