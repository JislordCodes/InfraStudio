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

def audit_filesystem():
    try:
        blender_dir = os.environ.get('BLENDER_DIR', '/opt/blender-4.4.3-linux-x64')
        addons_path = os.path.join(blender_dir, '4.4', 'scripts', 'addons')
        logger.info(f"=== Filesystem Audit: {addons_path} ===")
        if os.path.exists(addons_path):
            logger.info(f"Addons folder content: {os.listdir(addons_path)}")
            bonsai_dir = os.path.join(addons_path, 'bonsai')
            if os.path.exists(bonsai_dir):
                logger.info(f"Bonsai folder content: {os.listdir(bonsai_dir)}")
                # Check for bim folder
                bim_dir = os.path.join(bonsai_dir, 'bim')
                logger.info(f"Bonsai/bim exists: {os.path.exists(bim_dir)}")
            else:
                logger.error("Bonsai directory MISSING in addons folder!")
        else:
            logger.error("Addons path MISSING!")
        logger.info("==========================================")
    except Exception as e:
        logger.error(f"Audit failed: {e}")

# ── Phase 8.1: Hardened Path Initialization ──────────────────────────────
blender_dir = os.environ.get('BLENDER_DIR', '/opt/blender-4.4.3-linux-x64')
addons_path = os.path.join(blender_dir, '4.4', 'scripts', 'addons')

# 1. Audit first
audit_filesystem()

# 2. Inject paths BEFORE any imports
if addons_path not in sys.path:
    sys.path.insert(0, addons_path)
    logger.info(f"Injected {addons_path} into sys.path")

# 3. Specifically inject bonsai directory for internal resolution if needed
bonsai_path = os.path.join(addons_path, 'bonsai')
if bonsai_path not in sys.path:
    sys.path.insert(0, bonsai_path)
    logger.info(f"Injected {bonsai_path} into sys.path")

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
            pass
except KeyboardInterrupt:
    logger.info("Blender process received shutdown signal.")
