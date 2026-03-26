"""
MCP Server - Uses FastMCP's native transport (streamable HTTP on /mcp by default).
Adds 'ifc.' prefix aliases so 'ifc.create_wall' works with the Supabase proxy.
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
            print(f"TELEMETRY: Blender socket ready.", flush=True)
            return True
        except (ConnectionRefusedError, OSError):
            time.sleep(3)
    print("TELEMETRY: WARNING - Blender not ready, proceeding anyway", flush=True)
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
# The proxy calls tools as 'ifc.create_wall' but they are registered as 'create_wall'.
try:
    # Access the internal tool registry dict directly
    tool_registry = mcp._tool_manager._tools
    base_tools = list(tool_registry.items())
    for tool_name, tool_fn in base_tools:
        if not tool_name.startswith('ifc.'):
            prefixed = f"ifc.{tool_name}"
            tool_registry[prefixed] = tool_fn
    total = len(tool_registry)
    base_count = len(base_tools)
    print(f"TELEMETRY: {base_count} base tools + {base_count} ifc. aliases = {total} total registered", flush=True)
except Exception as e:
    print(f"TELEMETRY: prefix alias error: {e}", flush=True)

# ── Host security bypass ──────────────────────────────────────────────────
try:
    from mcp.server.transport_security import TransportSecurityMiddleware
    TransportSecurityMiddleware._validate_host = lambda self, host: True
    print("TELEMETRY: TransportSecurityMiddleware patched.", flush=True)
except (ImportError, AttributeError):
    pass

# ── Run using FastMCP's native streamable HTTP transport ─────────────────
# FastMCP defaults to streamable-http on /mcp which correctly handles POST /mcp
if __name__ == "__main__":
    print(f"TELEMETRY: Starting FastMCP on {MCP_HOST}:{MCP_PORT}...", flush=True)
    mcp.run(host=MCP_HOST, port=MCP_PORT)
