import puppeteer from 'puppeteer';
import * as fs from 'fs';

async function captureFrontendScreenshots() {
  console.log("==========================================");
  console.log("🌐 STARTING BROWSER SCREENSHOT AUTOMATION...");
  console.log("==========================================\n");

  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  let executablePath = possiblePaths.find(p => fs.existsSync(p));
  console.log(`Using Browser Executable: ${executablePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-webgl',
        '--ignore-gpu-blocklist'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    console.log("1. Navigating to http://localhost:5173/...");
    await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });

    console.log("2. Taking initial dashboard screenshot...");
    await page.screenshot({ path: "screenshot_dashboard_initial.png", fullPage: false });
    console.log("   ✅ Saved: screenshot_dashboard_initial.png");

    console.log("3. Typing prompt into chat input: 'create a room with fully enclosed gable roof'...");
    const inputSelector = 'textarea, input[type="text"]';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.type(inputSelector, "create a room with fully enclosed gable roof");

    console.log("4. Submitting prompt...");
    await page.keyboard.press("Enter");

    console.log("5. Waiting for multi-agent generation to finish...");
    await new Promise(r => setTimeout(r, 45000));

    console.log("6. Taking rendered 3D Canvas screenshot...");
    await page.screenshot({ path: "screenshot_rendered_gable_roof.png", fullPage: false });
    console.log("   ✅ Saved: screenshot_rendered_gable_roof.png");

    console.log("\n==========================================");
    console.log("🎉 BROWSER SCREENSHOT AUTOMATION COMPLETE!");
    console.log("==========================================");

  } catch (err) {
    console.error("💥 Browser automation error:", err);
  } finally {
    if (browser) await browser.close();
  }
}

captureFrontendScreenshots();
