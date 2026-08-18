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

if __name__ == "__main__":
    import uvicorn
    from serve_sse import app
    port = int(os.environ.get("PORT", 8000))
    print(f"=== Starting MCP Server on 0.0.0.0:{port} ===", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port)
