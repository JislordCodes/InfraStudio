import os
import sys

_current_dir = os.path.dirname(os.path.abspath(__file__))
_mcp_dir = os.path.join(_current_dir, "ifc-bonsai-mcp-main")
_docker_dir = os.path.join(_mcp_dir, "docker")
_src_dir = os.path.join(_mcp_dir, "src")

for p in [_mcp_dir, _docker_dir, _src_dir]:
    if p not in sys.path:
        sys.path.insert(0, p)

os.chdir(_mcp_dir)

# Use exec so the process is replaced entirely — avoids module import issues
# and works whether or not uvicorn is on the initial PYTHONPATH
port = int(os.environ.get("PORT", 8000))
print(f"=== Starting MCP Server on 0.0.0.0:{port} ===", flush=True)
os.execv(
    sys.executable,
    [
        sys.executable, "-m", "uvicorn",
        "serve_sse:mcp_asgi_app",
        "--host", "0.0.0.0",
        "--port", str(port),
        "--log-level", "info",
    ],
)
