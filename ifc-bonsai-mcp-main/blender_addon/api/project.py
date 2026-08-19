"""Project management API for IFC Bonsai MCP
Initialize and manage IFC projects within the Blender environment.
"""

import bpy
import ifcopenshell
import ifcopenshell.api
import logging
from . import register_command
from .ifc_utils import save_and_load_ifc

logger = logging.getLogger(__name__)

@register_command('initialize_project', description="Initialize a new empty IFC4 project with standard hierarchy")
def initialize_project(project_name: str = "My Project") -> dict:
    """Initialize a new empty IFC4 project with Project, Site, Building, and Storey.
    
    Returns:
        Dict containing success status and project information.
    """
    try:
        from bonsai.bim.ifc import IfcStore
        import os
        import ifcopenshell
        import ifcopenshell.guid
        
        # Load from the bundled template to avoid all ifcopenshell.api creation bugs!
        template_path = os.path.join(os.path.dirname(__file__), "blank_project.ifc")
        ifc_file = ifcopenshell.open(template_path)
        
        project_element = ifc_file.by_type("IfcProject")[0]
        project_element.Name = project_name
        project_element.GlobalId = ifcopenshell.guid.new()
        
        # Geometric contexts are already in the template
        logger.info(f"Loaded template project with guid: {project_element.GlobalId}")
        
        # 4. Set as active file in Bonsai and locally
        IfcStore.file = ifc_file
        IfcStore.path = "new_project.ifc"
        try:
            from . import ifc_utils
            ifc_utils._ACTIVE_IFC_FILE = ifc_file
            logger.info("Set _ACTIVE_IFC_FILE successfully")
        except Exception as e:
            logger.warning(f"Failed to set _ACTIVE_IFC_FILE: {e}")
        
        # 5. Sync with Blender
        try:
            ifc_file.write("new_project.ifc")
            logger.info("Saved IFC project to new_project.ifc")
        except Exception as e:
            logger.warning(f"ifc_file.write warning: {e}")
        
        return {
            "success": True,
            "message": f"Successfully initialized new IFC project: {project_name}",
            "project_guid": project_element.GlobalId,
            "schema": "IFC4"
        }
        
    except Exception as e:
        error_msg = f"Failed to initialize project: {str(e)}"
        logger.error(error_msg)
        return {
            "success": False,
            "error": error_msg
        }

@register_command('create_storey', description="Create a new Building Storey")
def create_storey(name: str, elevation: float = 0.0) -> dict:
    """Create a new IfcBuildingStorey at the specified elevation.
    
    Args:
        name: Name of the storey (e.g. 'First Floor')
        elevation: Elevation height in meters
        
    Returns:
        Dict with success status and storey GUID
    """
    try:
        from bonsai.bim.ifc import IfcStore
        from .ifc_utils import get_ifc_file, save_and_load_ifc
        
        ifc_file = get_ifc_file()
        
        # Find the active building
        buildings = ifc_file.by_type("IfcBuilding")
        if not buildings:
            return {"success": False, "error": "No IfcBuilding found to attach storey to."}
        building = buildings[0]
        
        storey = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name=name)
        
        # Set elevation if requested
        if elevation != 0.0:
            ifcopenshell.api.run("geometry.edit_object_placement", ifc_file, product=storey, matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,elevation,1]])
            
        ifcopenshell.api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])
        
        # Set as the active spatial container for subsequent objects
        import bonsai.tool as tool
        try:
            # We must load into Blender representation first
            save_and_load_ifc()
        except:
            pass
            
        return {
            "success": True,
            "storey_guid": storey.GlobalId,
            "name": storey.Name,
            "message": f"Created Storey '{name}' at elevation {elevation}m."
        }
    except Exception as e:
        logger.error(f"Failed to create storey: {e}")
        return {"success": False, "error": str(e)}

@register_command('export_ifc', description="Save and export the current IFC project")
def export_ifc(params=None) -> dict:
    """Save the current IFC project to disk."""
    from .ifc_utils import save_and_load_ifc
    try:
        save_and_load_ifc()
        return {
            "success": True,
            "message": "Successfully exported and saved IFC project."
        }
    except Exception as e:
        logger.error(f"Failed to export IFC: {e}")
        return {
            "success": False,
            "error": str(e)
        }
