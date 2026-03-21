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
    # ── Phase 8.1: Explicit App Manifestation ────────────────────────────────
    # App Runner REQUIRES binding to 0.0.0.0.
    # FastMCP requires calling streamable_http_app() BEFORE accessing internal state.
    app = None
    
    try:
        if hasattr(mcp, "streamable_http_app"):
            logger.info("Calling mcp.streamable_http_app() to manifest ASGI app...")
            app = mcp.streamable_http_app()
    except Exception as e:
        logger.warning(f"Failed to call streamable_http_app: {e}")

    if not app:
        # Fallback to known attributes if call failed
        for attr in ["starlette_app", "app", "_app"]:
            if hasattr(mcp, attr):
                app = getattr(mcp, attr)
                logger.info(f"Using existing app attribute: {attr}")
                break

    if not app:
        # Final desperate search via duck-typing (avoiding session_manager)
        for attr in dir(mcp):
            if attr in ("__init__", "session_manager"): continue
            try:
                val = getattr(mcp, attr)
                if hasattr(val, "router") and hasattr(val, "add_event_handler"):
                    app = val
                    logger.info(f"Found MCP app via duck-typing: {attr}")
                    break
            except Exception:
                continue

    if app:
        logger.info(f"Starting MCP SSE server on {MCP_HOST}:{MCP_PORT}")
        uvicorn.run(app, host=MCP_HOST, port=MCP_PORT)
    else:
        logger.error("CRITICAL: Could not manifest Starlette app. Falling back to mcp.run().")
        try:
            mcp.run(transport='sse', host=MCP_HOST, port=MCP_PORT)
        except TypeError:
            mcp.run(transport='sse')
