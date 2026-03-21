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

# Keep Blender alive in headless mode
logger.info("Blender is now running and keeping the process alive for MCP requests.")
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    logger.info("Blender process received shutdown signal.")
