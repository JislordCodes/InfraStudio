import bpy
import os
import sys

# Ensure addon is in path if not already installed
try:
    import blender_addon
except ImportError:
    # Not installed globally, might need to append path
    pass

def init_blender_mcp():
    print("Initializing Blender MCP Headless Server...")
    
    # 1. Enable bonsai addon
    try:
        bpy.ops.preferences.addon_enable(module="bonsai")
    except Exception as e:
        print(f"Failed to enable Bonsai addon: {e}")

    # 2. Create an empty IFC project
    ifc_path = "/app/model.ifc"
    try:
        import bonsai.tool as tool
        bpy.ops.bim.create_project()
        
        from bonsai.bim.ifc import IfcStore
        IfcStore.path = ifc_path
        
        import logging
        from bonsai.bim import export_ifc
        logger = logging.getLogger("BonsaiExport")
        export_settings = export_ifc.IfcExportSettings.factory(bpy.context, ifc_path, logger)
        exporter = export_ifc.IfcExporter(export_settings)
        exporter.export()
        print(f"Created empty IFC project at {ifc_path}")
    except Exception as e:
        print(f"Failed to create empty IFC project: {e}")

    # 3. Start the MCP socket server
    try:
        from blender_addon import core
        # Ensure it's listening on all interfaces in docker
        # Wait, the core.py uses host='localhost' by default in BlenderMCPServer.__init__
        # Let's override it
        server = core.create_server_instance(port=9876)
        server.host = '0.0.0.0'
        server.start()
        print("Blender MCP server started on 0.0.0.0:9876!")
    except Exception as e:
        print(f"Failed to start Blender MCP server: {e}")

if __name__ == "__main__":
    init_blender_mcp()
