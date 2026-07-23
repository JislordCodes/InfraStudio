import { fetch } from "undici";

const qwenKey = process.env.QWEN_API_KEY || "sk-ws-H.IXPRPH.wpQo.MEYCIQDGaOFthnPMgvcqPxg5yin91LnkQFW9S2EdZDzlFjyiuwIhAO4M5pNSPn_H4ncna21SUgKCgO5vzUPKsUuuJNwaKvKv";

const systemPrompt = `You are the Architectural Reasoning Agent for InfraStudio. Output ONLY valid JSON matching schema.`;
const complexBrief = JSON.stringify({
  is_edit: false,
  project_type: "luxury villa",
  room_requirements: [
    { name: "Living Room", suggested_area: 30 },
    { name: "Master Bedroom", suggested_area: 25 },
    { name: "Kitchen", suggested_area: 20 },
    { name: "Bathroom", suggested_area: 12 },
    { name: "Guest Bedroom", suggested_area: 18 },
    { name: "Dining Room", suggested_area: 16 }
  ],
  special_features: ["gable roof", "stairs"],
  material_requirements: ["wood floor", "brick wall"]
});

async function testGlm52Output() {
  console.log("Testing glm-5.2 raw response output...\n");

  const res = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: complexBrief }
      ],
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: "json_object" }
    })
  });

  const data = await res.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  console.log("Raw Response Length:", rawText.length);
  console.log("Raw Response Snippet:\n", rawText.substring(0, 500));
  console.log("...\nEnd Snippet:\n", rawText.substring(rawText.length - 300));

  try {
    JSON.parse(rawText);
    console.log("\n✅ Direct JSON.parse succeeded!");
  } catch (e) {
    console.log("\n❌ Direct JSON.parse failed:", e.message);
  }
}

testGlm52Output();
