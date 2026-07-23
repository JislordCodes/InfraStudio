import { fetch, Agent, setGlobalDispatcher } from "undici";

// Configure local script timeout to 15 minutes to allow Qwen reasoning model to think
const localAgent = new Agent({
  headersTimeout: 900000,
  bodyTimeout: 900000,
  connectTimeout: 60000
});
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function callEndpoint(path, body) {
  const url = `${BASE_URL}${path}`;
  console.log(`[HTTP POST] Sending request to ${url}...`);
  const startTime = Date.now();
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[HTTP POST] Received response in ${duration}s (Status: ${res.status})`);
  
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Request to ${path} failed (HTTP ${res.status}): ${errorText}`);
  }
  
  return res.json();
}

async function runTest() {
  console.log("🚀 Starting End-to-End Programmatic Test...");
  console.log("Prompt: 'create a 2 bedroom apartment'\n");
  
  try {
    // 1. INTERPRETER
    console.log("----------------------------------------");
    console.log("Step 1: Calling Interpreter Agent...");
    const brief = await callEndpoint("/agent-interpreter", {
      messages: [{ role: "user", content: "create a 2 bedroom apartment" }]
    });
    console.log("Interpreter Brief Response:", JSON.stringify(brief, null, 2));

    // 2. ARCHITECT
    console.log("\n----------------------------------------");
    console.log("Step 2: Calling Architect Agent (Reasoning Model - may take a few minutes)...");
    const plan = await callEndpoint("/agent-architect", brief);
    console.log("Architect Layout Plan:", JSON.stringify(plan, null, 2));

    if (!plan.storey_plans || plan.storey_plans.length === 0) {
      throw new Error("Architect returned no storey plans.");
    }

    // 3. BIM EXECUTION
    console.log("\n----------------------------------------");
    console.log("Step 3: Initializing BIM Project...");
    let mcpSessionId = "";
    const initRes = await callEndpoint("/agent-bim", { action: "initialize" });
    mcpSessionId = initRes.mcpSessionId;
    console.log(`BIM Project Initialized. Session ID: ${mcpSessionId}`);

    for (const storey of plan.storey_plans) {
      console.log(`\nCreating Storey: ${storey.name} (Elevation: ${storey.elevation || 0})...`);
      const storeyRes = await callEndpoint("/agent-bim", {
        action: "create_storey",
        name: storey.name,
        elevation: storey.elevation || 0,
        mcpSessionId
      });
      mcpSessionId = storeyRes.mcpSessionId;

      if (!storey.rooms || storey.rooms.length === 0) continue;
      
      for (let i = 0; i < storey.rooms.length; i++) {
        const room = storey.rooms[i];
        console.log(`Building Room [${i + 1}/${storey.rooms.length}]: ${room.name}...`);
        const roomRes = await callEndpoint("/agent-bim", {
          action: "build_room",
          storeyHeight: storey.height || 3.0,
          room,
          mcpSessionId
        });
        mcpSessionId = roomRes.mcpSessionId;
      }
    }

    console.log("\nExporting final IFC model...");
    const exportRes = await callEndpoint("/agent-bim", {
      action: "export",
      mcpSessionId
    });
    console.log("\n✅ IFC Model Exported Successfully!");
    console.log(`IFC File URL: ${exportRes.ifc_url}`);

    // 4. REVIEWER
    console.log("\n----------------------------------------");
    console.log("Step 4: Calling Quality Reviewer Agent...");
    const review = await callEndpoint("/agent-reviewer", { mcpSessionId });
    console.log("Reviewer Validation Response:", JSON.stringify(review, null, 2));
    
    console.log("\n========================================");
    console.log("🎉 E2E TEST COMPLETED SUCCESSFULLY!");
    console.log(`Final Model: ${exportRes.ifc_url}`);
    console.log(`Review Status: ${review.status}`);
    console.log("========================================");

  } catch (err) {
    console.error("\n💥 TEST FAILED WITH ERROR:");
    console.error(err);
    process.exit(1);
  }
}

runTest();
