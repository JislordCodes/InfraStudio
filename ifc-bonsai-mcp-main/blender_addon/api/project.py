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
