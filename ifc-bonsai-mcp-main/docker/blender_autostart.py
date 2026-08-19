"""
blender_autostart.py — runs inside Blender's Python interpreter at startup.
"""
import os
import sys
import time
import logging
import addon_utils

# Standardize logs to stdout for App Runner/CloudWatch
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] blender: %(message)s',
    force=True  # Ensure we override any Blender internal logging config
)
logger = logging.getLogger('blender_mcp')

def get_addons_path():
    try:
        import bpy
        major_ver = f"{bpy.app.version[0]}.{bpy.app.version[1]}"
        blender_dir = os.environ.get('BLENDER_DIR', f"/opt/blender-{bpy.app.version[0]}.{bpy.app.version[1]}.{bpy.app.version[2]}-linux-x64")
        return os.path.join(blender_dir, major_ver, 'scripts', 'addons')
    except Exception:
        return "/opt/blender-4.3.2-linux-x64/4.3/scripts/addons"

addons_path = get_addons_path()

# 1. Inject addons path and blendermcp path into sys.path
for p in [addons_path, os.path.join(addons_path, 'blendermcp'), os.path.join(addons_path, 'bonsai')]:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)
        logger.info(f"Injected {p} into sys.path")

logger.info(f"=== Filesystem Audit: {addons_path} ===")
if os.path.exists(addons_path):
    logger.info(f"Addons folder content: {os.listdir(addons_path)}")
logger.info("==========================================")
logger.info("Starting Blender internal autostart sequence...")

def enable_addons():
    try:
        # Enable Bonsai (BIM Engine) first
        logger.info("Enabling 'bonsai' addon...")
        # Note: In Blender 4.4, the addon name is 'bonsai'
        res = addon_utils.enable("bonsai", default_set=True)
        if res:
            logger.info("Bonsai addon enabled successfully")
        else:
            logger.error("Failed to enable 'bonsai' addon (returned False/None)")

        # Enable BlenderMCP (Our integration)
        logger.info("Enabling 'blendermcp' addon...")
        res = addon_utils.enable("blendermcp", default_set=True)
        if res:
            logger.info("BlenderMCP addon enabled successfully")
        else:
            logger.error("Failed to enable 'blendermcp' addon")
            
    except Exception as e:
        logger.error(f"Error during addon activation: {str(e)}", exc_info=True)

# Run activation
enable_addons()

# ── Ensure the socket server is running and intercept timers ───────────────
import queue
import bpy

_mcp_queue = queue.Queue()
_original_register = bpy.app.timers.register

def custom_register(func, first_interval=0.0, persistent=False):
    """Intercept timer registrations so we can process them in our blocking loop."""
    _mcp_queue.put((func, time.time() + first_interval))
    return first_interval

bpy.app.timers.register = custom_register
logger.info("Intercepted bpy.app.timers.register to allow headless execution.")

# Start the socket server directly (since we bypassed the normal timers)
try:
    from blendermcp import core as _core
    port = int(os.environ.get("BLENDER_MCP_PORT", "9876"))
    srv = _core.create_server_instance(port=port)
    srv.start()
    logger.info(f"BlenderMCP socket server started directly on port {port}.")
except Exception as e:
    logger.error(f"Could not start socket server: {e}", exc_info=True)

# ── Phase 8.1.1: Pre-initialize IFC context to avoid tool-call latency ──────
try:
    logger.info("Pre-initializing IFC project context...")
    # Addons are enabled, so we can import our API
    from blendermcp.api.project import initialize_project
    init_res = initialize_project(project_name="Cloud Default Project")
    if init_res.get("success"):
        logger.info(f"IFC Context ready: {init_res.get('project_guid')}")
    else:
        logger.warning(f"IFC Context initialization returned error: {init_res.get('error')}")
except Exception as e:
    logger.warning(f"IFC Context pre-initialization failed (will fallback on first call): {e}", exc_info=True)

# Keep Blender alive in headless mode AND process tasks
logger.info("Blender is now running custom headless event pump for MCP requests.")
try:
    while True:
        try:
            func, exec_time = _mcp_queue.get(timeout=0.1)
            current_time = time.time()
            if current_time >= exec_time:
                try:
                    res = func()
                    # If timer returns a number, it wants to run again after that delay
                    if isinstance(res, (int, float)) and res > 0:
                        _mcp_queue.put((func, time.time() + res))
                except Exception as e:
                    logger.error(f"Timer execution failed: {e}", exc_info=True)
            else:
                # Not ready yet, put it back
                _mcp_queue.put((func, exec_time))
                time.sleep(0.05)
        except queue.Empty:
            time.sleep(0.02)
except KeyboardInterrupt:
    logger.info("Blender process received shutdown signal.")
