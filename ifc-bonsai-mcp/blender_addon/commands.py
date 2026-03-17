"""Command execution and registration for IFC Bonsai MCP addon.

This module provides the central command execution system for the addon,
managing command registration, execution, and error handling. It acts as
the bridge between the MCP server and Blender's API, routing commands
to appropriate handlers.

Key Components:
    - Command execution with parameter validation
    - Dynamic command registration from API modules
    - Error handling and result formatting
    - Integration with Bonsai/IfcOpenShell when available

Module Structure:
    - execute_command: Main entry point for command execution
    - get_available_commands: Query registered commands
    - Automatic import of API modules for command registration
"""

import bpy
import traceback
from typing import Dict, Any

from .api import code, get_command, get_all_commands
from bonsai import tool

BONSAI_AVAILABLE = False
try:
    import ifcopenshell
    import ifcopenshell.api
    import ifcopenshell.api.aggregate as aggregate
    import ifcopenshell.api.context as context
    import ifcopenshell.api.geometry as geometry
    import ifcopenshell.api.project as project_api
    import ifcopenshell.api.root as root
    import ifcopenshell.api.spatial as spatial
    import ifcopenshell.api.unit as unit
    BONSAI_AVAILABLE = True
except ImportError:
    BONSAI_AVAILABLE = False
    print("Bonsai/IfcOpenShell not available.")

from .api import scene, wall
from .scene_analysis.scene_analysis import *

def execute_command(command_type: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Execute a command by name with parameters.
    This is the main entry point for executing commands.
    
    Args:
        command_type: The name of the command to execute
        params: Parameters to pass to the command
        
    Returns:
        dict: Result of the command execution
    """
    if params is None:
        params = {}
        
    try:
        handler = get_command(command_type)

        if handler:
            result = handler(**params)
            return {"status": "success", "result": result}
        else:
            return {"status": "error", "message": f"Unknown command type: {command_type}"}
    except Exception as e:
        print(f"Error executing command '{command_type}': {str(e)}")
        traceback.print_exc()
        return {"status": "error", "message": str(e)}

def get_available_commands():
    """
    Get a list of all available commands.
    
    Returns:
        dict: Command names and descriptions
    """
    return {name: info['description'] for name, info in get_all_commands().items()}

def register():
    """Register the module with Blender"""
    pass

def unregister():
    """Unregister the module from Blender"""
    pass