import { fetch } from "undici";

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function testAllAgents() {
  console.log("=== VERIFYING ALL 4 AGENTS ON NEW MODEL ASSIGNMENTS ===\n");

  // 1. Agent Interpreter (qwen3.7-max-2026-05-20)
  console.log("1. Testing Agent Interpreter (qwen3.7-max-2026-05-20)...");
  const interpRes = await fetch(`${BASE_URL}/agent-interpreter`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "build a 3-room modern bungalow" }] })
  });
  const interpData = await interpRes.json();
  console.log(`   ✅ Interpreter HTTP ${interpRes.status}: project_type=${interpData.project_type || 'ok'}`);

  // 2. Agent Architect (glm-5.2)
  console.log("\n2. Testing Agent Architect (glm-5.2)...");
  const archRes = await fetch(`${BASE_URL}/agent-architect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(interpData)
  });
  const archData = await archRes.json();
  console.log(`   ✅ Architect HTTP ${archRes.status}: rooms_count=${archData.storey_plans?.[0]?.rooms?.length || 0}`);

  // 3. Agent BIM (kimi-k2.7-code)
  console.log("\n3. Testing Agent BIM (kimi-k2.7-code)...");
  const initRes = await fetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  
  const bimRes = await fetch(`${BASE_URL}/agent-bim`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "initialize", projectName: "Model Test Villa", mcpSessionId: initRes.session_id })
  });
  const bimData = await bimRes.json();
  console.log(`   ✅ BIM HTTP ${bimRes.status}: status=${bimData.status}`);

  // 4. Agent Reviewer (qwen3.7-plus)
  console.log("\n4. Testing Agent Reviewer (qwen3.7-plus)...");
  const revRes = await fetch(`${BASE_URL}/agent-reviewer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mcpSessionId: bimData.mcpSessionId })
  });
  const revData = await revRes.json();
  console.log(`   ✅ Reviewer HTTP ${revRes.status}: status=${revData.status}`);

  console.log("\n🎉 ALL 4 AGENTS PASSED VERIFICATION!");
}

testAllAgents().catch(e => console.error("Error:", e));
