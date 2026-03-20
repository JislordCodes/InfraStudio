"""
MCP SSE HTTP Server entrypoint for AWS App Runner.

Starts the FastMCP server using SSE (Server-Sent Events) transport
so it is accessible over HTTP on port 8080 instead of stdio.

App Runner routes inbound HTTPS traffic → port 8080 on this container.
The MCP client (your frontend AI) connects to this endpoint.

The server connects to the Blender addon socket server running on
127.0.0.1:9876 (started by Blender in headless mode via supervisord).
"""
import os
import sys
import time
import logging
import socket as _socket

# ── Ensure /app/src is at the front of the Python path ──────────────────────
_current_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.normpath(os.path.join(_current_dir, '..', 'src'))
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger('serve_sse')

# ── Configuration ───────────────────────────────────────────────────────────
BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
BLENDER_WAIT_SECONDS = int(os.environ.get('BLENDER_WAIT_SECONDS', '120'))
MCP_HOST = os.environ.get('HOST', '0.0.0.0')
MCP_PORT = int(os.environ.get('PORT', '8080'))

# ── Wait for Blender addon socket ──────────────────────────────────────────
def wait_for_blender(host, port, timeout):
    """Poll until the Blender socket is reachable."""
    logger.info(f'Waiting up to {timeout}s for Blender addon socket on {host}:{port}...')
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            logger.info('✅ Blender addon socket is ready.')
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    logger.warning(f'⚠️  Blender addon socket not available after {timeout}s. Starting MCP server anyway...')
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT, BLENDER_WAIT_SECONDS)

# ── Load MCP server and register tools ──────────────────────────────────────
# Note: we import individual modules to ensure their decorators run.
logger.info('Loading MCP server and registering tools from blender_mcp.mcp_functions...')

try:
    from blender_mcp.mcp_instance import mcp
    import blender_mcp.mcp_functions.api_tools as api_tools
    import blender_mcp.mcp_functions.analysis_tools as analysis_tools
    import blender_mcp.mcp_functions.prompts as prompts
    import blender_mcp.mcp_functions.rag_tools as rag_tools
    
    logger.info('Successfully registered all tool modules.')
except ImportError as e:
    logger.error(f'❌ Failed to import tools: {e}')
    # If imports fail because of missing Blender-only packages, it's okay if 
    # the server still starts to provide non-Blender tools (like RAG).
    pass

logger.info(f'Starting SSE HTTP server on {MCP_HOST}:{MCP_PORT} ...')

# ── Start MCP Server ────────────────────────────────────────────────────────
# This call is blocking. It uses the FastMCP built-in SSE transport.
mcp.run(transport='sse', host=MCP_HOST, port=MCP_PORT)
