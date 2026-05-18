const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";
const url = "https://pzeoilvqeyuheslkfhjq.supabase.co/functions/v1/agent-bim";

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
