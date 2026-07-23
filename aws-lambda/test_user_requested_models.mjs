import { fetch } from "undici";

const qwenKey = process.env.QWEN_API_KEY || "sk-ws-H.IXPRPH.wpQo.MEYCIQDGaOFthnPMgvcqPxg5yin91LnkQFW9S2EdZDzlFjyiuwIhAO4M5pNSPn_H4ncna21SUgKCgO5vzUPKsUuuJNwaKvKv";

const requestedModels = [
  { role: "agent-architect", name: "glm-5.2" },
  { role: "agent-interpreter", name: "qwen3.7-max-2026-05-20" },
  { role: "agent-executor", name: "kimi-k2.7-code" },
  { role: "agent-reviewer", name: "qwen3.7-plus" }
];

async function testRequestedModels() {
  console.log("Testing user requested model names against DashScope API...\n");

  for (const item of requestedModels) {
    try {
      const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: item.name,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10
        })
      });

      const text = await res.text();
      if (res.ok) {
        console.log(`✅ [${item.role}] "${item.name}": SUCCESS (HTTP ${res.status})`);
      } else {
        console.log(`❌ [${item.role}] "${item.name}": FAILED (HTTP ${res.status}) -> ${text.substring(0, 180)}`);
      }
    } catch (e) {
      console.log(`💥 [${item.role}] "${item.name}": ERROR -> ${e.message}`);
    }
  }
}

testRequestedModels();
