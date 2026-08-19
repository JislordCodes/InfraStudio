import os
import sys

_current_dir = os.path.dirname(os.path.abspath(__file__))
_mcp_dir = os.path.join(_current_dir, "ifc-bonsai-mcp-main")
_docker_dir = os.path.join(_mcp_dir, "docker")
_src_dir = os.path.join(_mcp_dir, "src")
_lib_dir = os.path.join(_current_dir, "lib")  # pip --target installs here

for p in [_lib_dir, _mcp_dir, _docker_dir, _src_dir]:
    if p not in sys.path:
        sys.path.insert(0, p)

os.chdir(_mcp_dir)

port = int(os.environ.get("PORT", 8000))
print(f"=== Starting MCP Server on 0.0.0.0:{port} ===", flush=True)
print(f"=== sys.path: {sys.path[:4]} ===", flush=True)

# Prepend lib dir so uvicorn and all packages are importable by the exec'd process
env = os.environ.copy()
existing_pythonpath = env.get("PYTHONPATH", "")
env["PYTHONPATH"] = _lib_dir + (":" + existing_pythonpath if existing_pythonpath else "")

os.execve(
    sys.executable,
    [
        sys.executable, "-m", "uvicorn",
        "serve_sse:mcp_asgi_app",
        "--host", "0.0.0.0",
        "--port", str(port),
        "--log-level", "info",
    ],
    env,
)

