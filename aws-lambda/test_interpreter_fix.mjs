import { fetch } from "undici";

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function testInterpreter() {
  console.log("Testing agent-interpreter with updated qwen-max model routing...");
  const res = await fetch(`${BASE_URL}/agent-interpreter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "create a small 2-room villa" }]
    })
  });
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text.substring(0, 300)}`);
}

testInterpreter();
