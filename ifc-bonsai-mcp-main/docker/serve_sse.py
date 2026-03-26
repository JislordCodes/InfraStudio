"""
MCP HTTP Server using FastMCP's native Streamable HTTP transport.
The Supabase proxy sends POST /mcp - this handles it correctly.
Tools are registered with 'ifc.' prefix so 'ifc.create_wall' works.
"""
import os
import sys
import time
import logging
import socket as _socket

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
            print(f"TELEMETRY: Blender socket ready on {host}:{port}", flush=True)
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    print(f"TELEMETRY: WARNING - Blender not ready after {timeout}s, proceeding anyway", flush=True)
    return False

wait_for_blender(BLENDER_HOST, BLENDER_PORT)

try:
    from blender_mcp.mcp_instance import mcp  # type: ignore
    import blender_mcp.mcp_functions.api_tools as api_tools  # type: ignore
    import blender_mcp.mcp_functions.analysis_tools as analysis_tools  # type: ignore
    import blender_mcp.mcp_functions.prompts as prompts  # type: ignore
    print(f"TELEMETRY: Modules imported. FastMCP id={id(mcp)}", flush=True)
except Exception as e:
    print(f"CRITICAL ERROR importing modules: {e}", flush=True)
    raise

# ── Add ifc. prefix aliases for Supabase MCP proxy compatibility ──────────
# The Supabase proxy calls tools as 'ifc.create_wall' etc.
# We wrap every tool to also be reachable with the 'ifc.' prefix.
try:
    original_tools = list(mcp._tool_manager._tools.items())
    for tool_name, tool_fn in original_tools:
        prefixed_name = f"ifc.{tool_name}"
        if prefixed_name not in mcp._tool_manager._tools:
            # Re-register with prefix by aliasing the same function
            mcp._tool_manager._tools[prefixed_name] = tool_fn
    
    total = len(mcp._tool_manager._tools)
    print(f"TELEMETRY: Tool registry has {total} entries (includes ifc. prefixed aliases)", flush=True)
except Exception as e:
    print(f"TELEMETRY: prefix alias error: {e}", flush=True)

# ── Host security bypass ──────────────────────────────────────────────────
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: TransportSecurityMiddleware patched.", flush=True)
except (ImportError, AttributeError):
    pass

# ── Use FastMCP's native HTTP transport (handles POST /mcp correctly) ─────
if __name__ == "__main__":
    print(f"TELEMETRY: Starting FastMCP native HTTP server on port {MCP_PORT}...", flush=True)
    mcp.run(
        transport="streamable-http",
        host=MCP_HOST,
        port=MCP_PORT,
        path="/mcp",
        log_level="info",
    )
