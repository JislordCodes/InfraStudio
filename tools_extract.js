const fs = require('fs');
let c = fs.readFileSync('tools.json', 'utf16le');
if (!c.includes('{')) c = fs.readFileSync('tools.json', 'utf8');
const start = c.indexOf('{');
if (start > -1) {
  const json = JSON.parse(c.substring(start));
  const tools = json.result.tools.map(t => '- ' + t.name);
  console.log(tools.join('\n'));
} else {
  console.log('No tools found in JSON string');
}
