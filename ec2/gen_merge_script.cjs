// Regenerates supabase/functions/_shared/merge_ifc_script.ts from ec2/merge_ifc.py
const fs = require('fs');
const py = fs.readFileSync('ec2/merge_ifc.py', 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync('supabase/functions/_shared/merge_ifc_script.ts',
  '// GENERATED from ec2/merge_ifc.py by ec2/gen_merge_script.cjs - edit the .py and regenerate.\n' +
  'export const MERGE_IFC_PY = ' + JSON.stringify(py) + ';\n');
console.log('generated', py.length, 'chars');
