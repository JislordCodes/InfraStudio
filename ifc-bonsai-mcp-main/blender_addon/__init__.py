"""Blender MCP Addon - Model Context Protocol Integration for Blender.

This addon establishes a bidirectional communication channel between Blender and Claude AI
using the Model Context Protocol (MCP). It creates a socket server within Blender that
listens for and executes commands from Claude, enabling AI-assisted 3D modeling and
scene manipulation.

Key Features:
    - Socket server for real-time command reception
    - Integration with Blender's UI through sidebar panel
    - Modular command system for extensibility
    - Automatic server lifecycle management

Architecture:
    - core: Server implementation and connection handling
    - ui: User interface panels and operators
    - commands: Command registry and execution logic

Note:
    The addon requires Blender 3.0+ and operates on configurable ports (default: 9876).
"""

bl_info = {
    "name": "Blender MCP",
    "author": "ifc-bonsai-mcp",
    "version": (1, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > BlenderMCP",
    "description": "Connect Blender to Claude via MCP",
    "category": "Interface",
}

import bpy
from bpy.props import StringProperty, IntProperty, BoolProperty, EnumProperty

from . import core
from . import ui
from . import commands
from . import api

def register():
    """Register the addon and its components with Blender"""
    core.register()
    ui.register()
    commands.register()

    bpy.types.Scene.blendermcp_port = IntProperty(
        name="Port",
        description="Port for the BlenderMCP server",
        default=9876,
        min=1024,
        max=65535
    )
    
    bpy.types.Scene.blendermcp_server_running = BoolProperty(
        name="Server Running",
        default=False
    )

def unregister():
    """Unregister the addon and its components from Blender"""
    server_instance = core.get_server_instance()
    if server_instance:
        server_instance.stop()

    del bpy.types.Scene.blendermcp_port
    del bpy.types.Scene.blendermcp_server_running

    commands.unregister()
    ui.unregister()
    core.unregister()

if __name__ == "__main__":
    register()
