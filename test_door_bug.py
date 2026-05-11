import os
import sys

# Add the source directory to the Python path
sys.path.insert(0, os.path.abspath('ifc-bonsai-mcp-main/src'))
sys.path.insert(0, os.path.abspath('ifc-bonsai-mcp-main'))

from blender_mcp.mcp_functions.api_tools import execute_tool

def main():
    print("Initializing...")
    execute_tool("initialize_project", {})
    
    print("Creating wall...")
    wall_res = execute_tool("create_wall", {
        "name": "Test Wall", 
        "dimensions": {"length": 5.0, "height": 3.0, "thickness": 0.2},
        "location": [0,0,0],
        "rotation": [0,0,1.5708] # Rotated 90 degrees
    })
    wall_guid = wall_res["guid"]
    
    print("Creating opening...")
    open_res = execute_tool("create_opening", {
        "wall_guid": wall_guid,
        "width": 0.9, "height": 2.1, "depth": 0.3,
        "location": [0, 2.5, 0],
        "rotation": [0,0,1.5708] # Same as wall
    })
    opening_guid = open_res["opening_guid"]
    
    print("Creating door...")
    door_res = execute_tool("create_door", {
        "name": "Test Door",
        "dimensions": {"width": 0.9, "height": 2.1},
        "location": [0, 2.5, 0],
        "rotation": [0,0,1.5708] # Same as wall
    })
    door_guid = door_res["door_guid"]
    
    print("Filling opening...")
    fill_res = execute_tool("fill_opening", {
        "opening_guid": opening_guid,
        "element_guid": door_guid
    })
    
    print("Exporting...")
    execute_tool("export_ifc", {"filename": "test_door_bug.ifc"})
    print("Done")

if __name__ == "__main__":
    main()
