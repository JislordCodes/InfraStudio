const fs = require('fs');
let c = fs.readFileSync('tools.json', 'utf16le');
if (!c.includes('{')) c = fs.readFileSync('tools.json', 'utf8');
const start = c.indexOf('{');
const data = JSON.parse(c.substring(start));
const tools = data.result.tools;

const interesting = ['create_wall','create_door','create_window','create_slab','create_roof','create_stairs',
  'create_opening','fill_opening','create_surface_style','create_pbr_style','apply_style_to_object',
  'update_wall','update_door','update_slab','update_roof','update_stairs'];

tools.filter(t => interesting.includes(t.name)).forEach(t => {
  console.log('\n===== ' + t.name + ' =====');
  const props = (t.inputSchema && t.inputSchema.properties) ? t.inputSchema.properties : {};
  const required = (t.inputSchema && t.inputSchema.required) ? t.inputSchema.required : [];
  Object.entries(props).forEach(([k, v]) => {
    const req = required.includes(k) ? 'REQUIRED' : 'optional';
    let type = v.type || (v.anyOf ? v.anyOf.map(x=>x.type).join('|') : '?');
    let def = v.default !== undefined ? ' default=' + JSON.stringify(v.default) : '';
    console.log('  ' + k + ' [' + req + '] type=' + type + def);
  });
});
