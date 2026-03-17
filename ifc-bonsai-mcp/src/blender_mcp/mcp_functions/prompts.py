'''
Prompts
'''

from ..mcp_instance import mcp

@mcp.prompt()
def ifc_building_element_creation_strategy() -> str:
    """Defines the preferred strategy for creating IFC building elements"""
    return """
    When creating IFC building elements in Bonsai (formerly BlenderBIM), follow these guidelines:
    
    1. IFC Structure and Hierarchy:
       - Respect the IFC hierarchy: Project → Site → Building → Building Story → Building Elements
       - Every element must belong to a proper container (typically a Building Story)
       - Use proper IFC entity types (IfcWall, IfcSlab, IfcDoor, etc.) that match the element's function
    
    2. #ToDo:
    
    Following these guidelines will ensure a well-structured, standards-compliant IFC model.
    """


