const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const url = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/functions/v1/agent-bim` : "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1/agent-bim";

async function testExport() {
  console.log("Calling agent-bim export...");
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ action: 'export', mcpSessionId: '' })
  });
  
  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Response:", text);
}

testExport();
