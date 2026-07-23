import { fetch } from "undici";

const BASE_URL = "https://225v6b2eozsjnityz5eo7p3jnq0qoawb.lambda-url.eu-west-2.on.aws";

async function testArchitect() {
  console.log("Testing agent-architect with glm-5.2...");
  const sampleBrief = {
    is_edit: false,
    edit_instructions: [],
    project_type: "villa",
    storeys: [{ name: "Ground Floor", elevation: 0, height: 3 }],
    room_requirements: [{ name: "Living Room", suggested_area: 25 }, { name: "Bedroom", suggested_area: 16 }],
    special_features: [],
    material_requirements: [],
    style_preferences: []
  };

  const res = await fetch(`${BASE_URL}/agent-architect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sampleBrief)
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text}`);
}

testArchitect();
