const qwenKey = process.env.QWEN_API_KEY;
if (!qwenKey) {
  console.error("ERROR: QWEN_API_KEY environment variable is required to run this test.");
  process.exit(1);
}

async function testGlm52WithoutJsonFormat() {
  console.log("=== TEST 1: glm-5.2 WITHOUT response_format ===");
  const res1 = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: "You are the Architectural Reasoning Agent for InfraStudio. Output ONLY valid JSON matching schema." },
        { role: "user", content: JSON.stringify({ is_edit: false, project_type: "villa", room_requirements: [{ name: "Living Room", suggested_area: 25 }] }) }
      ],
      temperature: 0.1,
      max_tokens: 4000
    })
  });
  const data1 = await res1.json();
  const text1 = data1.choices?.[0]?.message?.content || "";
  console.log(`Length 1: ${text1.length}, Snippet: ${text1.substring(0, 300)}`);

  console.log("\n=== TEST 2: glm-5.2 WITH response_format ===");
  const res2 = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: "You are the Architectural Reasoning Agent for InfraStudio. Output ONLY valid JSON matching schema." },
        { role: "user", content: JSON.stringify({ is_edit: false, project_type: "villa", room_requirements: [{ name: "Living Room", suggested_area: 25 }] }) }
      ],
      temperature: 0.1,
      max_tokens: 4000,
      response_format: { type: "json_object" }
    })
  });
  const data2 = await res2.json();
  const text2 = data2.choices?.[0]?.message?.content || "";
  console.log(`Length 2: ${text2.length}, Snippet: ${text2.substring(0, 300)}`);
}

testGlm52WithoutJsonFormat();
