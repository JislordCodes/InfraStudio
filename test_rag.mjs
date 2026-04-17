async function run() {
  const res = await fetch("https://m63bpfmqks.us-east-1.awsapprunner.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_ifc_knowledge", arguments: { query: "create ifcwall geometric representation" } }
    })
  });
  console.log(await res.text());
}
run();
