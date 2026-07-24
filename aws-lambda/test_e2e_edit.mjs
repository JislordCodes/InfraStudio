async function testFullEditFlow() {
  console.log('=== E2E EDIT FLOW TEST ===');
  
  // TURN 1: Create house
  console.log('\n--- TURN 1: Initial Creation ---');
  const history1 = [{ role: 'user', content: 'create a 1 storey modern house with living room and bedroom' }];
  
  const ir1 = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-interpreter', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ messages: history1 })
  }).then(r=>r.json());
  console.log('Turn 1 Interpreter (is_edit):', ir1.is_edit);

  const ar1 = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-architect', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(ir1)
  }).then(r=>r.json());
  console.log('Turn 1 Architect rooms:', ar1.storey_plans?.[0]?.rooms?.map(r=>r.name));

  // Initialize BIM project for Turn 1
  const bimInit = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-bim', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'initialize' })
  }).then(r=>r.json());
  const mcpSessionId = bimInit.mcpSessionId;
  console.log('Turn 1 MCP Session ID:', mcpSessionId);

  // Build Turn 1 rooms
  for (const r of ar1.storey_plans[0].rooms) {
    await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-bim', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action: 'build_room', room: r, mcpSessionId })
    });
  }

  const export1 = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-bim', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'export', mcpSessionId })
  }).then(r=>r.json());
  console.log('Turn 1 IFC URL:', export1.ifc_url?.slice(0, 80));

  // TURN 2: Edit house ("add a garage on the east side")
  console.log('\n--- TURN 2: Edit Request ---');
  const history2 = [
    { role: 'user', content: 'create a 1 storey modern house with living room and bedroom' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'add a garage on the east side' }
  ];

  const ir2 = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-interpreter', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ messages: history2, sessionId: mcpSessionId })
  }).then(r=>r.json());
  console.log('Turn 2 Interpreter (is_edit):', ir2.is_edit, '| edit_instructions:', ir2.edit_instructions);

  const ar2 = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-architect', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(ir2)
  }).then(r=>r.json());
  console.log('Turn 2 Architect output:', JSON.stringify(ar2, null, 2));

  // Test BIM dynamic_edit with Turn 2 Architect output
  console.log('\nCalling BIM dynamic_edit...');
  const bimEdit = await fetch('https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws/agent-bim', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'dynamic_edit', plan: ar2, mcpSessionId })
  }).then(r=>r.json());
  console.log('Turn 2 BIM Edit status:', JSON.stringify(bimEdit, null, 2));
}

testFullEditFlow().catch(e => console.error('E2E ERROR:', e));
