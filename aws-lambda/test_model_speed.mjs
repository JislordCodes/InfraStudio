import { fetch } from "undici";

const qwenKey = process.env.QWEN_API_KEY || "sk-ws-H.IXPRPH.wpQo.MEYCIQDGaOFthnPMgvcqPxg5yin91LnkQFW9S2EdZDzlFjyiuwIhAO4M5pNSPn_H4ncna21SUgKCgO5vzUPKsUuuJNwaKvKv";

const testModels = ["glm-5.2", "qwen3.7-max-2026-05-20", "qwen-max", "kimi-k2.7-code"];

async function testModelSpeed() {
  console.log("Testing model response times...\n");

  for (const m of testModels) {
    const start = Date.now();
    try {
      const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "user", content: "Reply with JSON: {\"status\": \"ok\"}" }],
          max_tokens: 200
        })
      });
      const data = await res.json();
      const elapsed = Date.now() - start;
      const content = data.choices?.[0]?.message?.content || "";
      console.log(`⏱ ${m}: ${elapsed}ms -> ${content.substring(0, 100)}`);
    } catch (e) {
      console.log(`💥 ${m}: ${Date.now() - start}ms -> Error: ${e.message}`);
    }
  }
}

testModelSpeed();
