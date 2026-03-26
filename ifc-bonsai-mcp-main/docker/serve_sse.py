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
except Exception as e:
    print(f"CRITICAL ERROR during sync: {e}", flush=True)

async def ensure_synced():
    """Lazily synchronize tools from FastMCP to the low-level McpServer."""
    try:
        if hasattr(mcp, '_tool_manager') and hasattr(mcp, 'server'):
            registered_tools = mcp._tool_manager.list_tools()
            low_level_names = set(mcp.server._tools.keys())
            
            # If we haven't synced yet, or new tools arrived
            if len(registered_tools) > 0 and len(low_level_names) < len(registered_tools):
                for tool in registered_tools:
                    # 1. Register base name
                    if tool.name not in low_level_names:
                        mcp.server.register_tool(tool)
                    
                    # 2. Register with 'ifc.' prefix for Supabase Proxy compatibility
                    prefixed_name = f"ifc.{tool.name}"
                    if prefixed_name not in low_level_names:
                        from mcp.types import Tool
                        prefixed_tool = Tool(
                            name=prefixed_name,
                            description=tool.description,
                            inputSchema=tool.inputSchema
                        )
                        mcp.server.register_tool(prefixed_tool)
                
                print(f"TELEMETRY: Sync complete. {len(mcp.server._tools.keys())} total tools.", flush=True)
            
    except Exception as e:
        print(f"TELEMETRY: Lazy sync error: {e}", flush=True)

# Supabase proxy expects to GET /mcp and POST /mcp.
sse = SseServerTransport("/mcp")

async def handle_sse(request):
    print(f"TELEMETRY: Incoming SSE connection at {request.url.path}", flush=True)
    await ensure_synced()
    async with sse.connect_scope(request.scope, request.receive, request.send) as (read_stream, write_stream):
        await mcp.server.run(read_stream, write_stream, mcp.server.create_initialization_options())

async def handle_messages(request):
    await ensure_synced()
    session_id = request.query_params.get("sessionId")
    print(f"TELEMETRY: Incoming POST at /mcp. Session: {session_id}", flush=True)
    await sse.handle_post_message(request.scope, request.receive, request.send)

app = Starlette(
    routes=[
        Route("/mcp", endpoint=handle_sse, methods=["GET"]),
        Route("/mcp", endpoint=handle_messages, methods=["POST"]),
        # Keep pure SSE route just in case
        Route("/sse", endpoint=handle_sse, methods=["GET"]),
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
    print(f"TELEMETRY: Starting Starlette on {MCP_PORT}. Support for /mcp.", flush=True)
    uvicorn.run(app, host=MCP_HOST, port=MCP_PORT, log_level="info")
