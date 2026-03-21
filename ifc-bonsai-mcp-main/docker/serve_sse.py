"""
MCP SSE HTTP Server entrypoint for AWS App Runner.
"""
import os
import sys
import time
import logging
import socket as _socket

_current_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.normpath(os.path.join(_current_dir, '..', 'src'))
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger('serve_sse')

BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
BLENDER_WAIT_SECONDS = int(os.environ.get('BLENDER_WAIT_SECONDS', '120'))
MCP_HOST = os.environ.get('HOST', '0.0.0.0')
MCP_PORT = int(os.environ.get('PORT', '8000'))

def wait_for_blender(host, port, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT, BLENDER_WAIT_SECONDS)

try:
    from blender_mcp.mcp_instance import mcp  # type: ignore
    import blender_mcp.mcp_functions.api_tools as api_tools  # type: ignore
    import blender_mcp.mcp_functions.analysis_tools as analysis_tools  # type: ignore
    import blender_mcp.mcp_functions.prompts as prompts  # type: ignore
    import blender_mcp.mcp_functions.rag_tools as rag_tools  # type: ignore
except ImportError as e:
    logger.error(f'Failed to import tools: {e}')

if __name__ == "__main__":
    import uvicorn
    # ── Phase 7: Duck-Typing Discovery ──────────────────────────────────────
    # We must find the Starlette/FastAPI instance regardless of its attribute name.
    # App Runner REQUIRES binding to 0.0.0.0.
    app = None
    
    # 1. Check known attribute names first
    for attr in ["starlette_app", "app", "_app"]:
        if hasattr(mcp, attr):
            app = getattr(mcp, attr)
            logger.info(f"Found MCP app on known attribute: {attr}")
            break
            
    # 2. If not found, scan all attributes for something that looks like an ASGI app
    if not app:
        for attr in dir(mcp):
            if attr.startswith("__"): continue
            val = getattr(mcp, attr)
            # Starlette apps have 'router' and 'add_event_handler'
            if hasattr(val, "router") and hasattr(val, "add_event_handler"):
                app = val
                logger.info(f"Found MCP app via duck-typing on attribute: {attr}")
                break

    if app:
        logger.info(f"Starting MCP SSE server on {MCP_HOST}:{MCP_PORT}")
        uvicorn.run(app, host=MCP_HOST, port=MCP_PORT)
    else:
        logger.error("CRITICAL: Could not find Starlette app on FastMCP instance. Falling back to mcp.run().")
        # Standardize fallback to bind to all interfaces if possible
        # Early versions of FastMCP might not support these kwargs
        try:
            mcp.run(transport='sse', host=MCP_HOST, port=MCP_PORT)
        except TypeError:
            logger.warning("mcp.run() does not support host/port. Defaulting to 8000 on 127.0.0.1 (likely to fail health checks).")
            mcp.run(transport='sse')
