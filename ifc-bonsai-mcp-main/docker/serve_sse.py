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
        if hasattr(mcp, '_tool_manager') and hasattr(mcp, '_mcp_server'):
            registered_tools = mcp._tool_manager.list_tools()
            low_level_names = set(mcp._mcp_server._tools.keys())
            
            # If we haven't synced yet, or new tools arrived
            if len(registered_tools) > 0 and len(low_level_names) < len(registered_tools):
                for tool in registered_tools:
                    # 1. Register base name
                    if tool.name not in low_level_names:
                        mcp._mcp_server.register_tool(tool)
                    
                    # 2. Register with 'ifc.' prefix for Supabase Proxy compatibility
                    prefixed_name = f"ifc.{tool.name}"
                    if prefixed_name not in low_level_names:
                        from mcp.types import Tool
                        prefixed_tool = Tool(
                            name=prefixed_name,
                            description=tool.description,
                            inputSchema=tool.inputSchema
                        )
                        mcp._mcp_server.register_tool(prefixed_tool)
                
                print(f"TELEMETRY: Sync complete. {len(mcp._mcp_server._tools.keys())} total tools.", flush=True)
            
    except Exception as e:
        print(f"TELEMETRY: Lazy sync error: {e}", flush=True)

# Supabase proxy expects to GET /mcp and POST /mcp.
sse = SseServerTransport("/mcp")

# Basic routes for healthchecks
app = Starlette(
    routes=[
        Route("/ping", endpoint=lambda r: JSONResponse({"status": "ok"}), methods=["GET", "HEAD"]),
        Route("/", endpoint=lambda r: JSONResponse({"status": "ok", "message": "Synced Blender MCP Server"}), methods=["GET"]),
    ]
)

async def mcp_asgi_app(scope, receive, send):
    """Raw ASGI wrapper to route /mcp natively to the SSE transport."""
    if scope["type"] == "http":
        path = scope.get("path", "")
        method = scope.get("method", "")
        
        if path in ("/mcp", "/sse", "/message"):
            await ensure_synced()
            if method == "GET":
                print(f"TELEMETRY: Incoming SSE connection at {path}", flush=True)
                async with sse.connect_sse(scope, receive, send) as (read_stream, write_stream):
                    await mcp._mcp_server.run(read_stream, write_stream, mcp._mcp_server.create_initialization_options())
                return
            elif method == "POST":
                # Check for sessionId in query params
                from urllib.parse import parse_qs
                import json
                query_string = scope.get("query_string", b"").decode()
                params = parse_qs(query_string)
                
                has_session_param = ("sessionId" in params or "session_id" in params)
                has_active_sessions = hasattr(sse, "_sessions") and sse._sessions
                
                # MODE A: Session-based (Standard MCP SSE)
                if has_session_param or has_active_sessions:
                    if not has_session_param:
                        session_id = list(sse._sessions.keys())[-1]
                        separator = "&" if query_string else ""
                        new_qs = f"{query_string}{separator}sessionId={session_id}"
                        scope["query_string"] = new_qs.encode()
                        print(f"TELEMETRY: POST at {path}: Auto-hijacking session {session_id}", flush=True)
                    
                    print(f"TELEMETRY: Incoming POST at {path} (Session Mode).", flush=True)
                    await sse.handle_post_message(scope, receive, send)
                    return
                
                # MODE B: Stateless Bridge (For Supabase Edge Functions / one-shot fetch)
                print(f"TELEMETRY: Incoming POST at {path} (Stateless Bridge Mode).", flush=True)
                try:
                    # 1. Read body
                    body_bytes = b""
                    while True:
                        msg = await receive()
                        if msg["type"] == "http.request":
                            body_bytes += msg.get("body", b"")
                            if not msg.get("more_body", False):
                                break
                    
                    if not body_bytes:
                        raise ValueError("Empty request body")
                        
                    request_dict = json.loads(body_bytes)
                    
                    # 2. Manual Dispatch to avoid Session requirements
                    svr_method = request_dict.get("method")
                    svr_params = request_dict.get("params", {})
                    result = None
                    
                    if svr_method == "tools/list":
                        result = await mcp._mcp_server.list_tools()
                    elif svr_method == "tools/call":
                        result = await mcp._mcp_server.call_tool(svr_params.get("name"), svr_params.get("arguments"))
                    elif svr_method == "resources/list":
                        result = await mcp._mcp_server.list_resources()
                    elif svr_method == "prompts/list":
                        result = await mcp._mcp_server.list_prompts()
                    elif svr_method == "initialize":
                        # Return static capabilities to satisfy clients
                        result = {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
                            "serverInfo": {"name": "ifc-bonsai-mcp", "version": "1.0.0"}
                        }
                    else:
                        print(f"TELEMETRY: Method {svr_method} not natively supported in stateless bridge, skipping.", flush=True)
                    
                    # 3. Format result (dump Pydantic if needed)
                    if hasattr(result, "model_dump"):
                        result_data = result.model_dump()
                    else:
                        result_data = result
                        
                    response = {
                        "jsonrpc": "2.0",
                        "id": request_dict.get("id"),
                        "result": result_data
                    }
                    
                    await send({
                        "type": "http.response.start",
                        "status": 200,
                        "headers": [(b"content-type", b"application/json")],
                    })
                    await send({
                        "type": "http.response.body",
                        "body": json.dumps(response).encode(),
                    })
                    return

                except Exception as e:
                    print(f"CRITICAL ERROR in stateless POST bridge: {e}", flush=True)
                    import traceback
                    traceback.print_exc()
                    error_id = request_dict.get("id") if 'request_dict' in locals() else None
                    error_resp = {"jsonrpc": "2.0", "id": error_id, "error": {"code": -32603, "message": str(e)}}
                    await send({
                        "type": "http.response.start",
                        "status": 500,
                        "headers": [(b"content-type", b"application/json")],
                    })
                    await send({
                        "type": "http.response.body",
                        "body": json.dumps(error_resp).encode(),
                    })
                    return

    # Fallback to basic healthcheck app
    await app(scope, receive, send)

# Host check bypass
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: TransportSecurityMiddleware patched.", flush=True)
except ImportError:
    pass

if __name__ == "__main__":
    import uvicorn
    print(f"TELEMETRY: Starting ASGI Server on {MCP_PORT}. Support for /mcp.", flush=True)
    uvicorn.run(mcp_asgi_app, host=MCP_HOST, port=MCP_PORT, log_level="info")
