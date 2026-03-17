# For MCP inspector, Run: npx @modelcontextprotocol/inspector uv --directory . run main.py
from blender_mcp.server import main as server_main

def main():
    """Entry point for the blender-mcp package"""
    server_main()

if __name__ == "__main__":
    main()
