"""
MCP SSE HTTP Server entrypoint for AWS App Runner.

Starts the FastMCP server using SSE (Server-Sent Events) transport
so it is accessible over HTTP on port 8080 instead of stdio.

App Runner routes inbound HTTPS traffic → port 8080 on this container.
The MCP client (your frontend AI) connects to this endpoint.

The server connects to the Blender addon socket server running on
127.0.0.1:9876 (started by Blender in headless mode via supervisord,
BEFORE this process starts — see priority order in supervisord.conf).

NOTE: This file is invoked directly by supervisord as:
  python /app/docker/serve_sse.py
So mcp.run() is at module level — no if __name__ guard needed.
"""
import os
import sys
import time
import logging

# ── Ensure src/ is on the Python path ─────────────────────────────────────
# supervisord sets PYTHONPATH=/app/src but we also do it here as a safety net
# in case this script is invoked directly.
_src_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
_src_dir = os.path.normpath(_src_dir)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger('serve_sse')

# ── Wait for Blender addon socket to be ready ──────────────────────────────
import socket as _socket

BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
BLENDER_WAIT_SECONDS = int(os.environ.get('BLENDER_WAIT_SECONDS', '90'))
MCP_HOST = os.environ.get('HOST', '0.0.0.0')
MCP_PORT = int(os.environ.get('PORT', '8080'))


def wait_for_blender(host, port, timeout):
    """Poll until the Blender socket is available or timeout expires."""
    logger.info(f'Waiting up to {timeout}s for Blender addon socket on {host}:{port}...')
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            logger.info('Blender addon socket is ready.')
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    logger.warning(
        f'Blender addon socket not available after {timeout}s. '
        'MCP tools requiring Blender will fail until Blender is ready. '
        'Starting MCP server anyway...'
    )
    return False


wait_for_blender(BLENDER_HOST, BLENDER_PORT, BLENDER_WAIT_SECONDS)

# ── Load the MCP server instance and all tool modules ─────────────────────
# Importing these modules causes all @mcp.tool() decorators to run,
# registering every tool onto the shared FastMCP instance.
logger.info('Loading MCP server and registering tools...')

from blender_mcp.mcp_instance import mcp
from blender_mcp.mcp_functions import api_tools, analysis_tools, prompts, rag_tools  # noqa: F401

logger.info(f'All MCP tools loaded. Starting SSE HTTP server on {MCP_HOST}:{MCP_PORT} ...')

# ── Start the server ───────────────────────────────────────────────────────
# transport="sse"  → HTTP + Server-Sent Events (works with all MCP clients)
# host="0.0.0.0"  → listen on all interfaces (required for App Runner)
# port=MCP_PORT   → the port App Runner health-checks and routes to (default 8080)
mcp.run(transport='sse', host=MCP_HOST, port=MCP_PORT)
