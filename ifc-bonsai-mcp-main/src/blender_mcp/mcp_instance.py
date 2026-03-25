from mcp.server.fastmcp import FastMCP
import logging

logger = logging.getLogger("mcp_instance")

mcp = FastMCP(
    "BlenderMCP",
    instructions="Blender integration through the Model Context Protocol",
)

logger.info(f"FastMCP instance created. ID: {id(mcp)}")