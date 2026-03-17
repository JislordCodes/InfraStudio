"""User Interface Module for IFC Bonsai MCP Addon.

This module implements the graphical user interface components that integrate with
Blender's UI system, providing controls for managing the MCP server connection.

Components:
    - BLENDERMCP_PT_Panel: Main sidebar panel in 3D viewport
    - BLENDERMCP_OT_StartServer: Operator to initiate server connection
    - BLENDERMCP_OT_StopServer: Operator to terminate server connection

UI Location:
    3D Viewport > Sidebar (N key) > BlenderMCP Tab

Features:
    - Dynamic server status display
    - Configurable port settings
    - One-click server management
    - Real-time connection status feedback
"""

import bpy
from bpy.types import Panel, Operator
from . import core

class BLENDERMCP_PT_Panel(Panel):
    """The main UI panel for the BlenderMCP addon in the 3D View sidebar."""
    bl_label = "BlenderMCP"
    bl_idname = "BLENDERMCP_PT_Panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'BlenderMCP'

    def draw(self, context):
        """Draw the panel UI elements."""
        layout = self.layout
        scene = context.scene
        
        server_instance = core.get_server_instance()
        is_running = server_instance and server_instance.running

        layout.prop(scene, "blendermcp_port", text="Server Port")
        if not is_running:
            layout.operator("blendermcp.start_server", text="Connect to MCP server")
        else:
            layout.operator("blendermcp.stop_server", text="Disconnect from MCP server")
            layout.label(text=f"Running on port {scene.blendermcp_port}")

class BLENDERMCP_OT_StartServer(Operator):
    """Operator to start the BlenderMCP server."""
    bl_idname = "blendermcp.start_server"
    bl_label = "Connect to Claude"
    bl_description = "Start the BlenderMCP server to connect with Claude"
    
    def execute(self, context):
        scene = context.scene
        
        server = core.create_server_instance(port=scene.blendermcp_port)
        server.start()
        scene.blendermcp_server_running = True
        
        return {'FINISHED'}

class BLENDERMCP_OT_StopServer(Operator):
    """Operator to stop the BlenderMCP server."""
    bl_idname = "blendermcp.stop_server"
    bl_label = "Stop the connection to Claude"
    bl_description = "Stop the connection to Claude"
    
    def execute(self, context):
        scene = context.scene
        
        server = core.get_server_instance()
        if server:
            server.stop()
        
        scene.blendermcp_server_running = False
        
        return {'FINISHED'}

classes = (
    BLENDERMCP_PT_Panel,
    BLENDERMCP_OT_StartServer,
    BLENDERMCP_OT_StopServer,
)

def register():
    """Register the module with Blender"""
    for cls in classes:
        bpy.utils.register_class(cls)
    print("History tracking started")

def unregister():
    """Unregister the module from Blender"""
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
