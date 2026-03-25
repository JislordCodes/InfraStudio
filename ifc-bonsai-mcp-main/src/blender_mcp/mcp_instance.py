from mcp.server.fastmcp import FastMCP
import sys

mcp = FastMCP(
    "BlenderMCP",
    instructions="Blender integration through the Model Context Protocol",
)

# CRITICAL TELEMETRY
print(f"TELEMETRY: FastMCP instance created in mcp_instance.py. ID: {id(mcp)}", flush=True)