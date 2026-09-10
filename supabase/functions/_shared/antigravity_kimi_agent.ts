import { callQwen, cleanJsonResponse, mcpCallTool } from "./shared.ts";
import { synthesizeBuildingPythonCode } from "../agent-architect/index.ts";

export interface AntigravityAgentOptions {
  maxRetries?: number;
  model?: string;
  onStep?: (msg: string) => void;
}

export interface AntigravityAgentResult {
  success: boolean;
  python_code: string;
  mcpSessionId: string;
  resultText?: string;
  iterations: number;
  steps: string[];
  error?: string;
}

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity's Autonomous Computational BIM Architect & Structural Engineer.
Given the user's design request, write a complete, standalone, runnable Python script that generates an IFC model matching their requirements using IfcOpenShell and Trimesh.
You have complete creative and mathematical freedom: you can design any architectural style, complex parametric curves, lofted surfaces, organic shells, towers, bridges, or modern buildings without being bound to rigid box templates.

EXECUTION ENVIRONMENT (AWS Bonsai MCP Server):
- Python 3.11 with ifcopenshell, ifcopenshell.api as api, trimesh, numpy as np, and math pre-imported.
- ifc = get_ifc_file()
- save_and_load_ifc()
- SANDBOX RULES:
  * Do NOT import 'os', 'sys', 'subprocess', or any filesystem/OS modules (blocked by EC2 security sandbox).
  * Do NOT define custom Python classes; write clean procedural/functional code.
  * Write standard multiline Python code with 4-space indentation. Do NOT join statements with semicolons (;).
- InfraStudioHarness(ifc, storey) is available if you wish to use high-level primitives:
  * h.create_slab(polygon_2d, thickness=0.30, z_elevation=0.0) -> trimesh.Trimesh
  * h.create_wall(p1, p2, height=3.2, thickness=0.25, z_bottom=0.0, openings=[...]) -> trimesh.Trimesh (creates watertight walls with true rectangular opening voids)
  * h.add_window(p1, p2, offset, width, height, sill_height, z_bottom, name)
  * h.add_door(p1, p2, offset, width, height, z_bottom, name)
  * h.add_column(pos=[x,y], height=3.2, radius=0.2, z_bottom=0.0, shape="round|square", name)
  * h.add_beam(p1, p2, depth=0.45, width=0.25, z_elevation=3.0, name)
  * h.add_railing(p1, p2, height=1.05, z_bottom=0.0, name)
  * h.create_stairs(start_pt, length, width, height, num_steps)
  * h.create_roof(footprint_2d, roof_type, height, z_elevation, thickness)
  * h.add_mesh_element(mesh, name, ifc_class, mat_name, rgb, transparency)
  * count = h.commit()
- You can ALSO write raw ifcopenshell entities or trimesh geometry directly for any custom, parametric, or organic structures.
- End your script with:
  save_and_load_ifc()
  print("IFC model generated successfully.")

OUTPUT FORMAT:
Return ONLY a JSON object:
{
  "structure_name": "Descriptive Name",
  "python_code": "Complete executable Python script"
}
Do NOT include thought_process or markdown explanations in the JSON. Focus directly on executable python_code.`;

/**
 * Extracts raw Python code from LLM response (supports JSON or markdown code block).
 */
export function extractPythonCode(response: string): string {
  if (!response || typeof response !== "string") return "";
  const trimmed = response.trim();

  // 1. Try parsing JSON
  try {
    const parsed = cleanJsonResponse(trimmed);
    if (parsed && typeof parsed.python_code === "string" && parsed.python_code.trim().length > 20) {
      return parsed.python_code.trim();
    }
  } catch {
    // Not valid JSON, proceed to extract code block
  }

  // 2. Extract from markdown code fence
  const codeBlockMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1].trim().length > 20) {
    return codeBlockMatch[1].trim();
  }

  // 3. Fallback if entire string is python code
  if (trimmed.includes("InfraStudioHarness") && trimmed.includes("commit()")) {
    return trimmed;
  }

  return "";
}

/**
 * Runs the Antigravity Agentic ReAct self-correction loop using Kimi K3 on AWS.
 */
export async function runAntigravityKimiAgent(
  brief: any,
  initialSessionId: string,
  options: AntigravityAgentOptions = {}
): Promise<AntigravityAgentResult> {
  const maxRetries = options.maxRetries ?? 3;
  const model = options.model || "kimi-k3";
  const onStep = options.onStep || (() => {});
  const steps: string[] = [];

  const logStep = (msg: string) => {
    steps.push(msg);
    onStep(msg);
  };

  logStep(`🧠 Antigravity Agent (${model}): Analyzing design brief & calculating spatial grids...`);

  let currentSessionId = initialSessionId;
  let code = "";
  let promptText = typeof brief === "string" ? brief : JSON.stringify(brief);
  let errorFeedback = "";
  let iterations = 0;

  while (iterations < maxRetries) {
    iterations++;

    try {
      let promptMessage = "";
      const stepModel = "kimi-k3";
      if (iterations === 1) {
        promptMessage = `User Design Brief: ${promptText}\n\nDesign a complete, high-quality, watertight architectural BIM model using InfraStudioHarness. Return JSON with structure_name and python_code.`;
      } else {
        logStep(`🔧 Antigravity Agent: Fast self-healing error from previous pass with ${stepModel} (Attempt ${iterations}/${maxRetries})...`);
        promptMessage = `PREVIOUS PYTHON CODE EXECUTION FAILED ON EC2 BONSAI WITH ERROR:\n${errorFeedback}\n\nFAILED CODE:\n\`\`\`python\n${code}\n\`\`\`\n\nAnalyze why this failed, repair the geometry/parameters, ensure all InfraStudioHarness methods are valid, and return the corrected JSON with repaired python_code.`;
      }

      const rawResponse = await callQwen(
        ANTIGRAVITY_SYSTEM_PROMPT,
        promptMessage,
        true,
        stepModel
      );

      code = extractPythonCode(rawResponse);
      if (!code || code.length < 50) {
        throw new Error(`Failed to extract valid Python code from ${stepModel} response.`);
      }

      // Pre-execution code sanitization:
      let codeToRun = code;
      codeToRun = codeToRun.replace(/import\s+InfraStudioHarness\s+as\s+h;?/g, "h = InfraStudioHarness()");
      codeToRun = codeToRun.replace(/import\s+InfraStudioHarness;?/g, "");
      codeToRun = codeToRun.replace(/from\s+InfraStudioHarness\s+import\s+[^;\n]+;?/g, "");
      codeToRun = codeToRun.replace(/import\s+(os|sys|subprocess|shutil)[^\n;]*;?/g, "# removed system import");

      logStep(`⚡ Antigravity Agent: Executing ${codeToRun.length} bytes of Python code on EC2 Bonsai MCP...`);

      // Execute on EC2 Bonsai MCP server
      const toolRes = await mcpCallTool("execute_ifc_code_tool", { code: codeToRun }, currentSessionId);
      currentSessionId = toolRes.session;

      logStep(`✅ Antigravity Agent: Execution succeeded! Model generated cleanly.`);
      return {
        success: true,
        python_code: code,
        mcpSessionId: currentSessionId,
        resultText: toolRes.resultText,
        iterations,
        steps
      };

    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[AntigravityAgent] Attempt ${iterations} failed: ${errMsg.slice(0, 300)}`);
      errorFeedback = errMsg;

      if (iterations >= maxRetries) {
        logStep(`⚠️ Antigravity Agent: Max retries reached (${maxRetries}). Engaging deterministic architectural fallback.`);
        break;
      }
    }
  }

  // If retries exhausted, produce deterministic clean synthesis
  const fallbackCode = synthesizeBuildingPythonCode(brief);
  try {
    const fallbackRes = await mcpCallTool("execute_ifc_code_tool", { code: fallbackCode }, currentSessionId);
    currentSessionId = fallbackRes.session;
    return {
      success: true,
      python_code: fallbackCode,
      mcpSessionId: currentSessionId,
      resultText: fallbackRes.resultText,
      iterations,
      steps: [...steps, "✅ Deterministic architectural fallback executed cleanly."]
    };
  } catch (finalErr: any) {
    return {
      success: false,
      python_code: fallbackCode,
      mcpSessionId: currentSessionId,
      error: finalErr?.message || String(finalErr),
      iterations,
      steps
    };
  }
}
