"""
MCP SSE HTTP Server entrypoint for AWS App Runner.

Starts the FastMCP server using SSE (Server-Sent Events) transport
so it is accessible over HTTP on port 8080 instead of stdio.

App Runner routes inbound HTTPS traffic → port 8080 on this container.
The MCP client (your frontend AI) connects to this endpoint.

The server also attempts to connect to the Blender addon socket server
running on 127.0.0.1:9876 (started by Blender in headless mode via
supervisord BEFORE this process starts, see supervisord.conf priority order).
"""
import os
import sys
import time
import logging

# Ensure package root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger('serve_sse')

# ── Wait for Blender addon socket to be ready ──────────────────────────────
import socket as _socket

BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
BLENDER_WAIT_SECONDS = int(os.environ.get('BLENDER_WAIT_SECONDS', '60'))

def wait_for_blender(host, port, timeout):
    """Poll for the Blender socket to become available."""
    logger.info(f'Waiting up to {timeout}s for Blender addon socket on {host}:{port}...')
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            logger.info('Blender addon socket is ready.')
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(2)
    logger.warning(
        f'Blender addon socket not available after {timeout}s. '
        'MCP tools requiring Blender will fail until Blender is ready. '
        'Continuing startup anyway...'
    )
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT, BLENDER_WAIT_SECONDS)

# ── Load the MCP server and all tools ─────────────────────────────────────
logger.info('Loading MCP server and tools...')
from blender_mcp.mcp_instance import mcp  # noqa: E402

# Import all tool modules so they register themselves onto the mcp instance
from blender_mcp.mcp_functions import api_tools, analysis_tools, prompts, rag_tools  # noqa: E402,F401

logger.info('All MCP tools loaded. Starting SSE HTTP server on 0.0.0.0:8080 ...')

# ── Run ────────────────────────────────────────────────────────────────────
# transport="sse"  → HTTP + Server-Sent Events (compatible with all MCP clients)
# host="0.0.0.0"  → required for App Runner to receive external traffic
# port=8080       → the port App Runner is configured to health-check
if __name__ == '__main__':
    mcp.run(transport='sse', host='0.0.0.0', port=8080)
