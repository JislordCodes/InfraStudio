import { fetch, Agent, setGlobalDispatcher } from "undici";

const localAgent = new Agent({
  headersTimeout: 900000,
  bodyTimeout: 900000,
  connectTimeout: 60000
});
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function fetchTools() {
  const res = await fetch(`${BASE_URL}/gemini-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());

  console.log("Sample tool item:", JSON.stringify(res.tools[0], null, 2));
  console.log(`\nTotal Exposed MCP Tools: ${res.tools.length}\n`);
  res.tools.forEach((t, i) => {
    const name = t.name || t.function?.name || (typeof t === 'string' ? t : JSON.stringify(t));
    console.log(`${i + 1}. ${name}`);
  });
}

fetchTools();
