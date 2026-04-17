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
    
    Args:
        project_name: The name of the new IFC project.
        
    Returns:
        Dict containing success status and project information.
    """
    try:
        from bonsai.bim.ifc import IfcStore
        
        # 1. Create a fresh IFC4 file
        ifc_file = ifcopenshell.file(schema="IFC4")
        
        # 2. Add structural project elements
        project = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcProject", name=project_name)
        ifcopenshell.api.run("unit.assign_unit", ifc_file)
        
        site = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcSite", name="Default Site")
        building = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcBuilding", name="Default Building")
        storey = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcBuildingStorey", name="Level 0")
        
        # 3. Create spatial hierarchy
        ifcopenshell.api.run("aggregate.assign_object", ifc_file, relating_object=project, products=[site])
        ifcopenshell.api.run("aggregate.assign_object", ifc_file, relating_object=site, products=[building])
        ifcopenshell.api.run("aggregate.assign_object", ifc_file, relating_object=building, products=[storey])
        
        # 3b. Create geometric representation contexts (required for all geometry creation)
        model_context = ifcopenshell.api.run(
            "context.add_context", ifc_file,
            context_type="Model",
        )
        body_context = ifcopenshell.api.run(
            "context.add_context", ifc_file,
            context_type="Model",
            context_identifier="Body",
            target_view="MODEL_VIEW",
            parent=model_context,
        )
        plan_context = ifcopenshell.api.run(
            "context.add_context", ifc_file,
            context_type="Plan",
        )
        axis_context = ifcopenshell.api.run(
            "context.add_context", ifc_file,
            context_type="Plan",
            context_identifier="Axis",
            target_view="GRAPH_VIEW",
            parent=plan_context,
        )
        logger.info(f"Created geometric contexts: Model={model_context.id()}, Body={body_context.id()}, Plan={plan_context.id()}, Axis={axis_context.id()}")
        
        # 4. Set as active file in Bonsai
        IfcStore.file = ifc_file
        IfcStore.path = "new_project.ifc"
        
        # 5. Sync with Blender
        # In headless mode, we must save the file to disk first so Bonsai can load it
        # and trigger its internal UI/data synchronization, setting up `tool.Ifc.get()`.
        try:
            ifc_file.write("new_project.ifc")
            bpy.ops.bim.load_project(filepath="new_project.ifc")
        except Exception as e:
            # If the operator fails, log it
            logger.warning(f"bpy.ops.bim.load_project warning: {e}")
        
        return {
            "success": True,
            "message": f"Successfully initialized new IFC project: {project_name}",
            "project_guid": project.GlobalId,
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
