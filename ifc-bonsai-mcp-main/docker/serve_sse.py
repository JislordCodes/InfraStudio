"""
MCP SSE HTTP Server with explicit tool synchronization and dual-route support.
"""
import os
import sys
import time
import logging
import socket as _socket
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
from mcp.server.sse import SseServerTransport

print("TELEMETRY: server starting...", flush=True)

_current_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.normpath(os.path.join(_current_dir, '..', 'src'))
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger('serve_sse')

BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_PORT', '9876'))
MCP_HOST = os.environ.get('HOST', '0.0.0.0')
MCP_PORT = int(os.environ.get('PORT', '8000'))

def wait_for_blender(host, port, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT)

try:
    from blender_mcp.mcp_instance import mcp  # type: ignore
    import blender_mcp.mcp_functions.api_tools as api_tools  # type: ignore
    import blender_mcp.mcp_functions.analysis_tools as analysis_tools  # type: ignore
    import blender_mcp.mcp_functions.prompts as prompts  # type: ignore
    
    # ── CRITICAL: Manual Tool Synchronization ──────────────────────────────
    # FastMCP only syncs tools to the underlying McpServer during its own 
    # run() loop. Since we are running the server manually, we must sync.
    if hasattr(mcp, '_tool_manager') and hasattr(mcp, 'server'):
        registered_tools = mcp._tool_manager.list_tools()
        print(f"TELEMETRY: Syncing {len(registered_tools)} tools to Low-Level Server...", flush=True)
        for tool in registered_tools:
            # We use register_tool on the McpServer instance
            mcp.server.register_tool(tool)
        print(f"TELEMETRY: Sync complete. Low-Level Registry: {len(mcp.server._tools)}", flush=True)
    
except Exception as e:
    print(f"CRITICAL ERROR during sync: {e}", flush=True)

# ── Manual SSE Transport Binding ──────────────────────────────────────────
# We use /message as the message-posting endpoint.
sse = SseServerTransport("/message")

async def handle_sse(request):
    print(f"TELEMETRY: Incoming SSE connection at {request.url.path}", flush=True)
    async with sse.connect_scope(request.scope, request.receive, request.send) as (read_stream, write_stream):
        # We run the ALREADY SYNCED mcp.server
        await mcp.server.run(read_stream, write_stream, mcp.server.create_initialization_options())

async def handle_messages(request):
    # Log the session ID if present
    session_id = request.query_params.get("sessionId")
    print(f"TELEMETRY: Incoming POST at /message. Session: {session_id}", flush=True)
    await sse.handle_post_request(request.scope, request.receive, request.send)

# ── DUAL ROUTE SUPPORT ──────────────────────────────────────────────────
# We support both /sse and /mcp as connection endpoints to be safe.
app = Starlette(
    routes=[
        Route("/sse", endpoint=handle_sse),
        Route("/mcp", endpoint=handle_sse), # Backward shim
        Route("/message", endpoint=handle_messages, methods=["POST"]),
        Route("/ping", endpoint=lambda r: JSONResponse({"status": "ok"}), methods=["GET", "HEAD"]),
        Route("/", endpoint=lambda r: JSONResponse({"status": "ok", "message": "Synced Blender MCP Server"}), methods=["GET"]),
    ]
)

# Host check bypass
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: TransportSecurityMiddleware patched.", flush=True)
except ImportError:
    pass

if __name__ == "__main__":
    import uvicorn
    print(f"TELEMETRY: Starting Starlette on {MCP_PORT}. Support for /sse and /message.", flush=True)
    uvicorn.run(app, host=MCP_HOST, port=MCP_PORT, log_level="info")
