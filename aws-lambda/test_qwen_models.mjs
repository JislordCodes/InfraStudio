import { fetch } from "undici";

const qwenKey = process.env.QWEN_API_KEY || "sk-ws-H.IXPRPH.wpQo.MEYCIQDGaOFthnPMgvcqPxg5yin91LnkQFW9S2EdZDzlFjyiuwIhAO4M5pNSPn_H4ncna21SUgKCgO5vzUPKsUuuJNwaKvKv";

const modelsToTest = [
  "qwen-plus",
  "qwen-turbo",
  "qwen-max",
  "qwen-flash",
  "qwen2.5-72b-instruct",
  "qwen2.5-7b-instruct"
];

async function testModels() {
  console.log("Testing Qwen API Key against DashScope models...\n");

  for (const model of modelsToTest) {
    try {
      const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10
        })
      });

      const text = await res.text();
      if (res.ok) {
        console.log(`✅ ${model}: SUCCESS (HTTP ${res.status})`);
      } else {
        console.log(`❌ ${model}: FAILED (HTTP ${res.status}) -> ${text.substring(0, 150)}`);
      }
    } catch (e) {
      console.log(`💥 ${model}: ERROR -> ${e.message}`);
    }
  }
}

testModels();
