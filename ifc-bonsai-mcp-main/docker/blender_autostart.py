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
    print("  [DEBUG] Attempting to enable 'bonsai' addon...")
    _au.enable("bonsai", default_set=True, persistent=True)  # type: ignore
    print("  [OK] bonsai addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable bonsai addon: {e}")

try:
    print("  [DEBUG] Attempting to enable 'blendermcp' addon...")
    _au.enable("blendermcp", default_set=True, persistent=True)  # type: ignore
    print("  [OK] blendermcp addon enabled.")
except Exception as e:
    print(f"  [WARN] Could not enable blendermcp addon: {e}")

import addon_utils
import logging
import time
import os
import sys

# Standardize logs to stdout for App Runner/CloudWatch
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] blender: %(message)s')
logger = logging.getLogger('blender_autostart')

# ── Phase 6: Path Hardening for Bonsai (v0.8.5+) ──────────────────────────
# Ensure scripts/addons is in sys.path so sub-packages like 'bonsai.bim' can be found.
blender_dir = os.environ.get('BLENDER_DIR', '/opt/blender-4.4.3-linux-x64')
addons_path = os.path.join(blender_dir, '4.4', 'scripts', 'addons')
if addons_path not in sys.path:
    sys.path.insert(0, addons_path)
    logger.info(f"Added {addons_path} to sys.path")

logger.info("Starting Blender internal autostart script...")

def enable_addons():
    try:
        # Bonsai v0.8.5 alpha requires special treatment
        logger.info("Enabling bonsai addon...")
        res = addon_utils.enable("bonsai", default_set=True)
        if res:
            logger.info("Bonsai addon enabled successfully")
        else:
            logger.error("Failed to enable bonsai addon (returned None/False)")

        logger.info("Enabling blendermcp addon...")
        res = addon_utils.enable("blendermcp", default_set=True)
        if res:
            logger.info("BlenderMCP addon enabled successfully")
        else:
            logger.error("Failed to enable blendermcp addon")
            
    except Exception as e:
        logger.error(f"Error enabling addons: {str(e)}", exc_info=True)

# Run activation
enable_addons()

# Keep Blender alive in headless mode
print("=== BlenderMCP is now running and keeping the process alive ===")
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    print("=== BlenderMCP shutting down ===")
