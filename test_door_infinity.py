import sys
sys.path.append("ifc-bonsai-mcp-main/src")

import os
from blender_mcp.mcp_functions.api_tools import init_project, create_wall, create_opening, create_door

init_project(name="Test Door Infinity")

wall_res = create_wall(name="Wall 1", dimensions={"length": 5.0, "height": 3.0, "thickness": 0.2}, location=[0.0, 0.0, 0.0])
print(f"Wall: {wall_res}")

open_res = create_opening(
    element_guid=wall_res['wall_guid'], 
    width=0.9, 
    height=2.1, 
    depth=0.3, 
    location=[2.0, 0.0, 0.0]
)
print(f"Opening: {open_res}")

door_res = create_door(
    opening_guid=open_res['opening_guid'],
    overall_width=0.9,
    overall_height=2.1,
    location=[2.0, 0.0, 0.0]
)
print(f"Door: {door_res}")

print("Done. Saved to local directory ifc file.")
