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

from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
from mcp.server.sse import SseServerTransport

app = Starlette(
    routes=[
        Route("/ping", lambda r: JSONResponse({"status": "ok", "version": "8.8"}), methods=["GET", "HEAD"]),
    ]
)

@app.on_event("startup")
async def startup():
    logger.info("Phase 8.8: Explicit Starlette Manifest starting...")

async def handle_sse(request):
    async with SseServerTransport("/messages") as transport:
        await mcp.server.handle_sse(
            transport.scope, transport.receive, transport.send, transport.endpoint
        )

# Explicitly mount MCP logic if needed or use the transport helper
# Actually, FastMCP has a helper for this:
stream_app = mcp.streamable_http_app()
app.mount("/", stream_app)

if __name__ == "__main__":
    import uvicorn
    logger.info(f"Phase 8.8: Starting Explicit SSE server on {MCP_HOST}:{MCP_PORT}")
    try:
        uvicorn.run(app, host=MCP_HOST, port=MCP_PORT, log_level="info")
    except Exception as e:
        logger.error(f"Failed to start MCP server: {e}")
        sys.exit(1)
