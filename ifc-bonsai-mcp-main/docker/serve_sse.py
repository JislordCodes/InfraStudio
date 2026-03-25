"""
MCP SSE HTTP Server entrypoint for AWS App Runner.
"""
import os
import sys
import time
import logging
import socket as _socket

print("TELEMETRY: serve_sse: Script starting...", flush=True)

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
    print(f"TELEMETRY: serve_sse: Modules imported. Tools in registry: {len(mcp._tool_manager._tools) if hasattr(mcp, '_tool_manager') else 'N/A'}", flush=True)
except Exception as e:
    print(f"CRITICAL ERROR: {e}", flush=True)

# Create app
app = mcp.streamable_http_app()

# Audit Routes
print("TELEMETRY: serve_sse: Auditing Starlette routes:", flush=True)
for route in app.routes:
    # Starlette Route objects have 'path' and 'name'
    methods = getattr(route, 'methods', None)
    print(f"TELEMETRY: ROUTE: {route.path} (Methods: {methods})", flush=True)

from starlette.responses import JSONResponse

# Transport patch
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: serve_sse: TransportSecurityMiddleware patched.", flush=True)
except ImportError:
    pass

app.add_route("/ping", lambda r: JSONResponse({"status": "ok"}), methods=["GET", "HEAD"])

if __name__ == "__main__":
    import uvicorn
    print(f"TELEMETRY: serve_sse: Starting on {MCP_PORT}", flush=True)
    uvicorn.run(app, host=MCP_HOST, port=MCP_PORT, log_level="info")
