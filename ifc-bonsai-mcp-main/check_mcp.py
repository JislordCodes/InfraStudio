from mcp.server.fastmcp import FastMCP
import sys

mcp = FastMCP("test")
print("--- FastMCP Attributes ---")
for attr in dir(mcp):
    if not attr.startswith("__"):
        print(f"{attr}: {type(getattr(mcp, attr))}")

print("--- Check common internal attributes ---")
print(f"Has 'server': {hasattr(mcp, 'server')}")
print(f"Has '_server': {hasattr(mcp, '_server')}")
print(f"Has 'mcp_server': {hasattr(mcp, 'mcp_server')}")
