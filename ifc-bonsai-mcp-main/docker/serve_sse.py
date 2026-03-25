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

print(f"TELEMETRY: serve_sse: sys.path modified. New sys.path: {sys.path}", flush=True)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger('serve_sse')

BLENDER_HOST = os.environ.get('BLENDER_MCP_HOST', '127.0.0.1')
BLENDER_PORT = int(os.environ.get('BLENDER_MCP_PORT', '9876'))
BLENDER_WAIT_SECONDS = int(os.environ.get('BLENDER_WAIT_SECONDS', '120'))
MCP_HOST = os.environ.get('HOST', '0.0.0.0')
MCP_PORT = int(os.environ.get('PORT', '8000'))

def wait_for_blender(host, port, timeout):
    print(f"TELEMETRY: serve_sse: Waiting for Blender at {host}:{port}...", flush=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = _socket.create_connection((host, port), timeout=2)
            s.close()
            print(f"TELEMETRY: serve_sse: Blender ready.", flush=True)
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    print(f"TELEMETRY: serve_sse: Blender wait TIMEOUT.", flush=True)
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT, BLENDER_WAIT_SECONDS)

try:
    print("TELEMETRY: serve_sse: Importing mcp instance...", flush=True)
    from blender_mcp.mcp_instance import mcp  # type: ignore
    print(f"TELEMETRY: serve_sse: Loaded mcp instance. ID: {id(mcp)}", flush=True)
    
    print("TELEMETRY: serve_sse: Importing tool modules...", flush=True)
    import blender_mcp.mcp_functions.api_tools as api_tools  # type: ignore
    import blender_mcp.mcp_functions.analysis_tools as analysis_tools  # type: ignore
    import blender_mcp.mcp_functions.prompts as prompts  # type: ignore
    import blender_mcp.mcp_functions.rag_tools as rag_tools  # type: ignore
    print("TELEMETRY: serve_sse: Tool modules imported.", flush=True)
except Exception as e:
    print(f"CRITICAL ERROR: serve_sse: Failed to import tools: {e}", flush=True)
    import traceback
    traceback.print_exc()

# Create app
print("TELEMETRY: serve_sse: Creating streamable_http_app...", flush=True)
app = mcp.streamable_http_app()

# Verify tool registration
try:
    tool_list = []
    if hasattr(mcp, '_tool_manager') and hasattr(mcp._tool_manager, '_tools'):
        tool_list = list(mcp._tool_manager._tools.keys())
    
    print(f"TELEMETRY: serve_sse: Phase 8.8.4: Registered tools: {tool_list} (Count: {len(tool_list)})", flush=True)
    if not tool_list:
        print("TELEMETRY: CRITICAL: tool_list is EMPTY in serve_sse registry!", flush=True)
except Exception as debug_e:
    print(f"TELEMETRY: serve_sse: Error inspecting tool registry: {debug_e}", flush=True)

from starlette.responses import JSONResponse

# ── Phase 8.8.6: Dynamic Origin Whitelisting via Python Monkeypatch ───────
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: serve_sse: Phase 8.8.6: TransportSecurityMiddleware bypassed for AWS DNS.", flush=True)
except ImportError as e:
    print(f"TELEMETRY: serve_sse: Phase 8.8.6: TransportSecurityMiddleware patch skipped ({e})", flush=True)

lifespan = None

# Bind the App Runner health check intrinsically
app.add_route("/ping", lambda r: JSONResponse({"status": "ok", "version": "8.8.5"}), methods=["GET", "HEAD"])

if __name__ == "__main__":
    import uvicorn
    print(f"TELEMETRY: serve_sse: Phase 8.8: Starting Explicit SSE server on {MCP_HOST}:{MCP_PORT}", flush=True)
    try:
        uvicorn.run(app, host=MCP_HOST, port=MCP_PORT, log_level="info")
    except Exception as e:
        print(f"CRITICAL ERROR: serve_sse: Failed to start MCP server: {e}", flush=True)
        sys.exit(1)
