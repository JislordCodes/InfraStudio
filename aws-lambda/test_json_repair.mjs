export function cleanJsonResponse(rawStr) {
  let clean = rawStr.trim();
  
  if (clean.includes("```")) {
    const startIdx = clean.indexOf("```");
    if (startIdx !== -1) {
      const newlineIdx = clean.indexOf("\n", startIdx);
      const contentStart = newlineIdx !== -1 ? newlineIdx + 1 : startIdx + 3;
      const endIdx = clean.indexOf("```", contentStart);
      if (endIdx !== -1) {
        clean = clean.substring(contentStart, endIdx);
      } else {
        clean = clean.substring(contentStart);
      }
    }
  }
  
  clean = clean.trim();
  const firstBrace = clean.indexOf('{');
  if (firstBrace !== -1) {
    clean = clean.substring(firstBrace);
  }

  // Strip trailing commas before closing brackets or braces
  clean = clean.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(clean);
  } catch (_err) {
    // Attempt JSON repair for truncated strings
    let repaired = autoRepairTruncatedJson(clean);
    try {
      return JSON.parse(repaired);
    } catch (_err2) {
      const sanitized = repaired.replace(/[\u0000-\u001F]+/g, " ");
      return JSON.parse(sanitized);
    }
  }
}

function autoRepairTruncatedJson(jsonStr) {
  let str = jsonStr.trim();

  // Strip incomplete trailing key/value fragments
  str = str.replace(/,\s*"[^"]*"?\s*:\s*[^,\}\]]*$/, '');
  str = str.replace(/,\s*"[^"]*$/, '');
  str = str.replace(/,\s*$/, '');

  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    str += '"';
  }

  // Clean trailing commas after string closure
  str = str.replace(/,\s*$/, '');

  while (stack.length > 0) {
    str += stack.pop();
  }

  return str;
}

// Quick test
const sampleTruncated = `{"storey_plans":[{"name":"Ground Floor","rooms":[{"name":"Living","width":4,"length":5`;
console.log("Truncated Input:", sampleTruncated);
const repaired = cleanJsonResponse(sampleTruncated);
console.log("Repaired Output:", JSON.stringify(repaired, null, 2));
