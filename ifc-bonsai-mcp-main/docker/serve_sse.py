"""
MCP Server — Stateless JSON-RPC Bridge for Supabase Edge Functions.

Architecture:
  GET  /mcp → SSE stream  (traditional MCP clients with session)
  POST /mcp → Stateless JSON-RPC  (Supabase Edge Functions, one-shot)
  GET  /     → Health check
  GET  /ping → Health check

Root-cause fix: use FastMCP's public async methods (mcp.list_tools(),
mcp.call_tool()) instead of the low-level _mcp_server handlers which
require a live ServerSession and cannot be called statelessly.
"""

import os
import sys
import time
import json
import logging
import socket as _socket
import traceback

from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
from mcp.server.sse import SseServerTransport

print("TELEMETRY: server starting...", flush=True)

# ── Path setup ────────────────────────────────────────────────────────────────
_current_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.normpath(os.path.join(_current_dir, "..", "src"))
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("serve_sse")

# ── Config ────────────────────────────────────────────────────────────────────
BLENDER_HOST = os.environ.get("BLENDER_MCP_HOST", "127.0.0.1")
BLENDER_PORT = int(os.environ.get("BLENDER_PORT", "9876"))
MCP_HOST = os.environ.get("HOST", "0.0.0.0")
MCP_PORT = int(os.environ.get("PORT", "8000"))


def wait_for_blender(host: str, port: int, timeout: int = 120) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            print(f"TELEMETRY: Blender is up at {host}:{port}", flush=True)
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    print(f"TELEMETRY: Blender NOT reachable after {timeout}s — continuing anyway", flush=True)
    return False


wait_for_blender(BLENDER_HOST, BLENDER_PORT)

# ── Import the FastMCP instance and all tool modules ─────────────────────────
mcp = None
_import_error = None
try:
    from blender_mcp.mcp_instance import mcp  # type: ignore  # noqa: E402
    import blender_mcp.mcp_functions.api_tools as _api_tools  # type: ignore  # noqa: E402, F401
    import blender_mcp.mcp_functions.analysis_tools as _analysis_tools  # type: ignore  # noqa: E402, F401
    import blender_mcp.mcp_functions.prompts as _prompts  # type: ignore  # noqa: E402, F401
    _tool_count = len(mcp._tool_manager.list_tools())
    print(f"TELEMETRY: MCP ready — {_tool_count} tools registered.", flush=True)
except Exception as _e:
    _import_error = _e
    print(f"CRITICAL: import failure: {_e}", flush=True)
    traceback.print_exc()

# ── Patch transport-security to allow App Runner's internal hostnames ─────────
try:
    from mcp.server.transport_security import TransportSecurityMiddleware  # type: ignore
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: TransportSecurityMiddleware patched.", flush=True)
except ImportError:
    pass

# ── SSE transport (used for GET /mcp — traditional SSE clients) ───────────────
sse = SseServerTransport("/mcp")

# ── Minimal health-check Starlette app ───────────────────────────────────────
_health_app = Starlette(
    routes=[
        Route(
            "/ping",
            endpoint=lambda r: JSONResponse({"status": "ok"}),
            methods=["GET", "HEAD"],
        ),
        Route(
            "/",
            endpoint=lambda r: JSONResponse(
                {
                    "status": "ok",
                    "message": "Blender MCP Server",
                    "tools": len(mcp._tool_manager.list_tools()) if mcp else 0,
                }
            ),
            methods=["GET"],
        ),
    ]
)


# ── Helper: serialise any Pydantic model or list thereof ─────────────────────
def _sanitize_gemini_schema(obj):
    if isinstance(obj, dict):
        obj.pop("additionalProperties", None)
        return {k: _sanitize_gemini_schema(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_gemini_schema(item) for item in obj]
    return obj

def _to_json_safe(obj):
    if obj is None:
        return None
    if isinstance(obj, list):
        return [_to_json_safe(item) for item in obj]
    if hasattr(obj, "model_dump"):
        return _sanitize_gemini_schema(obj.model_dump())
    if isinstance(obj, dict):
        return _sanitize_gemini_schema(obj)
    return str(obj)


# ── Main ASGI handler ─────────────────────────────────────────────────────────
async def mcp_asgi_app(scope, receive, send):
    if scope["type"] != "http":
        await _health_app(scope, receive, send)
        return

    path = scope.get("path", "")
    method = scope.get("method", "").upper()

    # ── /mcp route ────────────────────────────────────────────────────────────
    if path == "/mcp":

        if mcp is None:
            _err_body = json.dumps({
                "jsonrpc": "2.0", "id": None,
                "error": {"code": -32603, "message": f"Server failed to start: {_import_error}"}
            }).encode()
            await send({"type": "http.response.start", "status": 503,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": _err_body})
            return

        # ── GET /mcp → SSE session ─────────────────────────────────────────
        if method == "GET":
            print("TELEMETRY: Incoming SSE connection at /mcp", flush=True)
            async with sse.connect_sse(scope, receive, send) as (r, w):
                await mcp._mcp_server.run(
                    r, w, mcp._mcp_server.create_initialization_options()
                )
            return

        # ── POST /mcp → Stateless JSON-RPC bridge ─────────────────────────
        if method == "POST":
            request_id = None
            try:
                # 1. Check for a live SSE session — if present, relay via SSE
                from urllib.parse import parse_qs
                qs = scope.get("query_string", b"").decode()
                params = parse_qs(qs)
                has_session = "sessionId" in params or "session_id" in params
                live_sessions = hasattr(sse, "_sessions") and bool(sse._sessions)

                if has_session or live_sessions:
                    # Inject session_id if missing (auto-hijack the only live session)
                    if not has_session and live_sessions:
                        sid = list(sse._sessions.keys())[-1]
                        sep = "&" if qs else ""
                        scope["query_string"] = f"{qs}{sep}sessionId={sid}".encode()
                        print(f"TELEMETRY: Auto-hijacking SSE session {sid}", flush=True)
                    print("TELEMETRY: Routing POST to SSE session handler", flush=True)
                    await sse.handle_post_message(scope, receive, send)
                    return

                # 2. Stateless bridge — read full body
                print("TELEMETRY: Stateless bridge mode", flush=True)
                body_bytes = b""
                while True:
                    msg = await receive()
                    if msg["type"] == "http.request":
                        body_bytes += msg.get("body", b"")
                        if not msg.get("more_body", False):
                            break

                if not body_bytes:
                    raise ValueError("Empty request body")

                req = json.loads(body_bytes)
                request_id = req.get("id")
                rpc_method = req.get("method", "")
                rpc_params = req.get("params") or {}

                print(f"TELEMETRY: Stateless RPC method={rpc_method} id={request_id}", flush=True)

                # 3. Dispatch using FastMCP's own async public methods
                #    These are the CORRECT API — not _mcp_server internal methods.
                result_data = None

                if rpc_method == "initialize":
                    result_data = {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
                        "serverInfo": {"name": "ifc-bonsai-mcp", "version": "1.0.0"},
                    }

                elif rpc_method == "tools/list":
                    # mcp.list_tools() is the FastMCP public async method.
                    # Returns list[mcp.types.Tool] (Pydantic models).
                    tools = await mcp.list_tools()
                    # Add ifc. prefixed aliases so Supabase proxy can find them
                    from mcp.types import Tool as MCPTool
                    prefixed = [
                        MCPTool(
                            name=f"ifc.{t.name}",
                            description=t.description,
                            inputSchema=t.inputSchema,
                        )
                        for t in tools
                    ]
                    all_tools = tools + prefixed
                    result_data = {"tools": [_to_json_safe(t) for t in all_tools]}

                elif rpc_method == "tools/call":
                    tool_name = rpc_params.get("name", "")
                    tool_args = rpc_params.get("arguments") or {}
                    # Strip ifc. prefix — tools are stored without it
                    if tool_name.startswith("ifc."):
                        tool_name = tool_name[4:]
                    # mcp.call_tool() is the FastMCP public async method.
                    # Internally handles context injection & result conversion.
                    content = await mcp.call_tool(tool_name, tool_args)
                    result_data = {
                        "content": [_to_json_safe(c) for c in content],
                        "isError": False,
                    }

                elif rpc_method == "resources/list":
                    resources = await mcp.list_resources()
                    result_data = {"resources": [_to_json_safe(r) for r in resources]}

                elif rpc_method == "prompts/list":
                    prompts_list = await mcp.list_prompts()
                    result_data = {"prompts": [_to_json_safe(p) for p in prompts_list]}

                elif rpc_method == "notifications/initialized":
                    # Client notification — no response body needed
                    await send({"type": "http.response.start", "status": 204, "headers": []})
                    await send({"type": "http.response.body", "body": b""})
                    return

                else:
                    raise ValueError(f"Unsupported method in stateless mode: {rpc_method}")

                # 4. Send response
                response_body = json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": result_data,
                }).encode()
                await send({
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"access-control-allow-origin", b"*"),
                    ],
                })
                await send({"type": "http.response.body", "body": response_body})
                print(f"TELEMETRY: Stateless response OK for {rpc_method}", flush=True)
                return

            except Exception as exc:
                print(f"CRITICAL: Stateless bridge error: {exc}", flush=True)
                traceback.print_exc()
                err_body = json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": str(exc)},
                }).encode()
                await send({
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"access-control-allow-origin", b"*"),
                    ],
                })
                await send({"type": "http.response.body", "body": err_body})
                return

        # ── OPTIONS /mcp → CORS pre-flight ────────────────────────────────
        if method == "OPTIONS":
            await send({
                "type": "http.response.start",
                "status": 204,
                "headers": [
                    (b"access-control-allow-origin", b"*"),
                    (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                    (b"access-control-allow-headers", b"content-type, authorization"),
                ],
            })
            await send({"type": "http.response.body", "body": b""})
            return

    # ── Fallback: health checks ───────────────────────────────────────────────
    await _health_app(scope, receive, send)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print(f"TELEMETRY: Starting ASGI Server on {MCP_HOST}:{MCP_PORT}", flush=True)
    uvicorn.run(mcp_asgi_app, host=MCP_HOST, port=MCP_PORT, log_level="info")
