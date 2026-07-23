import { fetch as uFetch, Agent, setGlobalDispatcher } from "undici";
import puppeteer from 'puppeteer';
import * as fs from "fs";

const localAgent = new Agent({ headersTimeout: 900000, bodyTimeout: 900000, connectTimeout: 60000 });
setGlobalDispatcher(localAgent);

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";
const ARTIFACTS = "C:\\Users\\david\\.gemini\\antigravity\\brain\\c2579048-00a5-46d3-9c07-409e7d26348d";

async function main() {
  console.log("=== TESTING FLUSH GRID-ALIGNED FLOORPLAN LAYOUT ===\n");

  // 1. Call Agent Architect with a 4-room prompt
  const brief = {
    messages: [
      { role: "user", content: "create a house with living room, kitchen, bedroom, bathroom" }
    ]
  };

  console.log("1. Calling agent-interpreter...");
  const interpRes = await uFetch(`${BASE_URL}/agent-interpreter`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(brief)
  }).then(r => r.json());

  console.log("2. Calling agent-architect...");
  const plan = await uFetch(`${BASE_URL}/agent-architect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(interpRes)
  }).then(r => r.json());

  console.log("\nArchitect Plan (Grid Snapped Rooms):");
  console.log(JSON.stringify(plan.storey_plans?.[0]?.rooms, null, 2));

  // 3. Build floorplan using MCP tools via BIM loop
  console.log("\n3. Building floorplan via agent-bim...");
  const initRes = await uFetch(`${BASE_URL}/gemini-chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "init", session_id: "" })
  }).then(r => r.json());
  let sid = initRes.session_id;

  await uFetch(`${BASE_URL}/agent-bim`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "initialize", mcpSessionId: sid })
  });

  const rooms = plan.storey_plans?.[0]?.rooms || [];
  for (const r of rooms) {
    console.log(`   Building room ${r.name} at origin [${r.origin.join(', ')}], size ${r.width}x${r.length}...`);
    const res = await uFetch(`${BASE_URL}/agent-bim`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "build_room", room: r, mcpSessionId: sid })
    }).then(r => r.json());
    sid = res.mcpSessionId || sid;
  }

  console.log("   Deduplicating shared walls...");
  const dedupRes = await uFetch(`${BASE_URL}/agent-bim`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "deduplicate_walls", mcpSessionId: sid })
  }).then(r => r.json());
  sid = dedupRes.mcpSessionId || sid;
  console.log(`   Removed ${dedupRes.removed} duplicate walls.`);

  console.log("   Exporting IFC...");
  const exportRes = await uFetch(`${BASE_URL}/agent-bim`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "export", mcpSessionId: sid })
  }).then(r => r.json());

  const ifcUrl = exportRes.ifc_url;
  console.log(`\n📦 Aligned Floorplan IFC URL: ${ifcUrl}\n`);

  // 4. Render in Puppeteer and capture top-down screenshot
  console.log("4. Capturing top-down 3D render screenshot...");
  const executablePath = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));

  const browser = await puppeteer.launch({
    executablePath, headless: "new",
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=swiftshader']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));

  const loadResult = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      const file = new File([blob], 'model.ifc', { type: 'application/octet-stream' });
      const input = document.querySelector('input[type="file"][accept=".ifc"]');
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, bytes: blob.size };
      }
      return { error: 'no input' };
    } catch(e) { return { error: e.message }; }
  }, ifcUrl);

  console.log(`   IFC loaded: ${JSON.stringify(loadResult)}`);
  await new Promise(r => setTimeout(r, 20000));

  const ssPath = `${ARTIFACTS}\\flush_aligned_floorplan.png`;
  await page.screenshot({ path: ssPath });
  console.log(`   ✅ Saved Screenshot: ${ssPath}`);

  await browser.close();
  console.log("\n=== TEST COMPLETE ===");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
