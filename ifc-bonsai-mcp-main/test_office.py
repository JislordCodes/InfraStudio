import ifcopenshell
import ifcopenshell.api
from blender_addon.api.ifc_utils import save_and_load_ifc, get_ifc_file, get_or_create_body_context

ifc_file = get_ifc_file()
body = get_or_create_body_context(ifc_file)

wall = ifcopenshell.api.run('root.create_entity', file=ifc_file, ifc_class='IfcWall')
rep = ifcopenshell.api.run('geometry.add_wall_representation', file=ifc_file, context=body, length=5.0, height=3.0, thickness=0.2)
ifcopenshell.api.run('geometry.assign_representation', file=ifc_file, product=wall, representation=rep)
ifcopenshell.api.run('geometry.edit_object_placement', file=ifc_file, product=wall)

save_and_load_ifc()
