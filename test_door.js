const code = `
import ifcopenshell
import ifcopenshell.api

ifc_file = get_ifc_file()
body_ctx = get_or_create_body_context(ifc_file)
unit_scale = calculate_unit_scale(ifc_file)

wall = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcWall", name="Wall_2")
rep = ifcopenshell.api.run("geometry.add_wall_representation", ifc_file, context=body_ctx, length=5.0, height=3.0, thickness=0.2)
ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=wall, representation=rep)

door = ifcopenshell.api.run("root.create_entity", ifc_file, ifc_class="IfcDoor", name="Door_1")
door_rep = ifcopenshell.api.run("geometry.add_door_representation", ifc_file, context=body_ctx, overall_height=2.1, overall_width=0.9, operation_type="SINGLE_SWING_LEFT")
ifcopenshell.api.run("geometry.assign_representation", ifc_file, product=door, representation=door_rep)

save_and_load_ifc()
`;

const payload = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "execute_ifc_code_tool",
    arguments: { code }
  }
};

fetch('https://m63bpfmqks.us-east-1.awsapprunner.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));
