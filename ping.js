const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const url = process.env.MCP_URL || "https://m63bpfmqks.us-east-1.awsapprunner.com/mcp";

async function ping() {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "ping", arguments: {} }
      })
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
  } catch (e) {
    console.error(e);
  }
  console.log("Time:", Date.now() - start, "ms");
}

ping();
