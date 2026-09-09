"""
Antigravity Kimi K3 Worker for EC2
Runs autonomous BIM architecture synthesis with full Antigravity agentic loops,
IfcOpenShell, and InfraStudioHarness on AWS.
"""

import os
import sys
import json
import asyncio
import argparse
from typing import Dict, Any, Optional

try:
    import httpx
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx", "fastapi", "uvicorn"])
    import httpx

# Configuration
ALIBABA_MAAS_URL = os.getenv(
    "QWEN_BASE_URL",
    "https://ws-sq2piu8admaum4we.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
)
QWEN_API_KEY = os.getenv("QWEN_API_KEY", "")
MCP_URL = os.getenv("MCP_URL", "http://127.0.0.1:8000/mcp")

ANTIGRAVITY_SYSTEM_PROMPT = """You are Antigravity, Google DeepMind's elite Autonomous Coding Agent and Master Computational Architect.
Your task is to generate complete, high-performance, watertight, clash-free Python scripts that build stunning architectural BIM models using IfcOpenShell and InfraStudioHarness.

RULES OF ENGAGEMENT:
1. ALWAYS WRITE RUNNABLE PYTHON CODE USING InfraStudioHarness.
2. Watertight geometry is mandatory: never overlap solid geometry.
3. For walls with doors or windows, use create_wall(..., openings=[...]) which creates genuine physical rectangular voids in the wall assembly, and add corresponding framed windows/doors inside those openings.
4. Structural integrity: Provide a structural column grid (add_column) at corner intersections, continuous floor plates (create_slab), cantilevered upper-level balconies with safety railings (add_railing), and a solid roof (create_roof or flat slab with parapets).
5. All dimensions in meters:
   - Ground slab: thickness 0.30m, z_elevation -0.30m
   - Walls: height 3.2m, thickness 0.25m
   - Columns: radius 0.20m or square 0.30m
   - Railings: height 1.05m
   - Doors: width 0.90m to 1.10m, height 2.10m
   - Windows: width 1.20m to 2.40m, height 1.40m, sill_height 0.90m
6. Structure of script:
   - Retrieve IFC: ifc = get_ifc_file()
   - Storey setup: storey = ifc.by_type("IfcBuildingStorey")[0]
   - Harness: h = InfraStudioHarness(ifc, storey)
   - Primitives: h.create_slab, h.create_wall, h.add_column, h.add_beam, h.add_railing, h.add_window, h.add_door, h.create_stairs, h.create_roof
   - Commit: count = h.commit()
   - Finalize: save_and_load_ifc()
   - Print: print(f"Committed {count} elements.")

Output format:
Return JSON:
{
  "thought_process": "Your step-by-step spatial and structural reasoning",
  "structure_name": "Descriptive Name",
  "python_code": "Complete executable Python script"
}"""


async def call_kimi_k3(prompt: str, api_key: str, history: Optional[list] = None) -> Dict[str, Any]:
    """Invoke Kimi K3 on Alibaba Cloud MaaS endpoint."""
    messages = [{"role": "system", "content": ANTIGRAVITY_SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": prompt})

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "kimi-k3",
        "messages": messages,
        "temperature": 0.6,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"}
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(ALIBABA_MAAS_URL, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)


async def execute_on_mcp(code: str, session_id: str = "") -> Dict[str, Any]:
    """Execute Python harness script via Bonsai MCP server."""
    headers = {"Content-Type": "application/json"}
    if session_id:
        headers["mcp-session-id"] = session_id

    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "execute_ifc_code_tool",
            "arguments": {"code": code}
        }
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(MCP_URL, headers=headers, json=body)
        resp.raise_for_status()
        session = resp.headers.get("mcp-session-id", session_id)
        return {"data": resp.json(), "session": session}


async def run_antigravity_loop(user_brief: str, api_key: str, max_retries: int = 3):
    """Full Antigravity ReAct self-correction loop."""
    print(f"\n🚀 [Antigravity Agent] Starting architectural synthesis for: '{user_brief}'")
    session_id = ""
    error_feedback = ""
    last_code = ""

    for attempt in range(1, max_retries + 1):
        if attempt == 1:
            prompt = f"Design brief: {user_brief}\nGenerate complete architectural Python code using InfraStudioHarness."
        else:
            print(f"\n🔧 [Antigravity Agent] Self-healing error from attempt {attempt - 1}...")
            prompt = f"Previous execution on MCP failed with error:\n{error_feedback}\n\nFailed code:\n```python\n{last_code}\n```\nAnalyze, fix, and return corrected JSON with python_code."

        print(f"🧠 Calling Kimi K3 (Attempt {attempt}/{max_retries})...")
        res = await call_kimi_k3(prompt, api_key)
        thought = res.get("thought_process", "")
        code = res.get("python_code", "")
        last_code = code

        print(f"💭 Thought: {thought[:200]}...")
        print(f"⚡ Executing {len(code)} bytes of Python code on MCP ({MCP_URL})...")

        try:
            mcp_res = await execute_on_mcp(code, session_id)
            session_id = mcp_res["session"]
            print(f"✅ Model compiled successfully on Bonsai MCP! Session: {session_id}")
            return {
                "success": True,
                "structure_name": res.get("structure_name", "Villa"),
                "python_code": code,
                "session_id": session_id,
                "attempts": attempt
            }
        except Exception as e:
            print(f"❌ Execution failed: {e}")
            error_feedback = str(e)

    print("⚠️ Max retries reached.")
    return {"success": False, "error": error_feedback, "attempts": max_retries}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Antigravity Kimi K3 BIM Worker")
    parser.add_argument("--prompt", type=str, default="Modern 2-storey cantilevered villa with balcony and stairs")
    parser.add_argument("--key", type=str, default=QWEN_API_KEY or os.getenv("QWEN_KEY", ""))
    args = parser.parse_args()

    if not args.key:
        print("Error: QWEN_API_KEY is required. Pass --key or set QWEN_API_KEY environment variable.")
        sys.exit(1)

    asyncio.run(run_antigravity_loop(args.prompt, args.key))
