# Contributing to IFC Bonsai MCP

## Adding a New MCP Tool
1. Create a module or function in `src/blender_mcp/mcp_functions/`.
2. Decorate callable endpoints with `@mcp.tool()` from `mcp.server.fastmcp`. Provide clear docstrings - they show up in MCP clients.
3. Import the new module in `src/blender_mcp/mcp_functions/__init__.py` so it registers at startup.
4. If the tool talks to Blender, use `get_blender_connection()` from `src/blender_mcp/server.py` to reuse the managed socket.
5. Update `pyproject.toml` if new dependencies are needed.

## Blender Add-on Development
- The packaged add-on lives under `blender_addon/`. 
- Create a new file and add new tools. Register the file in `__init__.py`. 
- Use @register_command for every new tool, so the tools can be discovered by the MCP server.
- Run `python scripts/install.py --create-addon-zip` after making changes.
- Keep Blender-specific dependencies inside the add-on where possible; Python dependencies shared with the MCP server belong in `pyproject.toml`.

## Testing
- Use [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to test the added tools. To test the MCP server, run `npx @modelcontextprotocol/inspector uv --directory . run main.py` from the root directory. This starts the MCP server with the inspector UI.

