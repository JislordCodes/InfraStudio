/**
 * Routes a new-build brief to the Antigravity CLI ("agy") - a real agentic
 * coding CLI driving Gemini 3.8 Flash High via the user's own Antigravity Pro
 * subscription - running headless on the EC2 MCP box via AWS SSM Run Command,
 * as an alternative to this pipeline's own direct-model orchestration and to
 * the (dormant) OpenHands/Token Harbor path in openhands_agent.ts.
 *
 * Unlike openhands_agent.ts's pollOpenHandsBuild (which blocks internally,
 * sleeping in 10s steps until its own deadline), pollAntigravityBuild does
 * exactly ONE GetCommandInvocation check per call and returns immediately -
 * SSM streams a running command's stdout into StandardOutputContent
 * progressively, before the command finishes, so a single check mid-run
 * already has real progress to show. The on-box script emits a
 * "PROGRESS:count=<n>" line to real stdout every ~10s while the agent works,
 * which this file greps out of that partial output. Returning fast (instead
 * of blocking) lets the caller's own continuation loop re-invoke every few
 * seconds and surface a fresh, live element count each time - this is what
 * actually produces "streaming" progress in the frontend, since the
 * frontend's continuation loop already renders whatever `progress` string
 * comes back on each pass.
 */
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { getMcpUrl, extractText } from "./shared.ts";
import { extractClashReport, type ClashReport } from "./clash_check.ts";
import { jevSafe, type ChoiceAnswer } from "./jev_client.ts";

const INSTANCE_ID = "i-006cf1785c4abbb6d";
const REGION = "us-east-1";
const AGY_MODEL = "gemini-3.8-flash-high";

// The box runs 3 fully isolated build slots (own Blender/MCP container each,
// see ec2/setup_mcp_slots.sh) so up to 3 builds can run at once without
// touching each other's IFC scene. A 4th+ concurrent build waits in a FIFO
// queue on the box itself (see buildScript's ticket/slot-lock logic) instead
// of every build serializing behind one global lock like before.
const STATUS_BUCKET = "infrastudio-ifc-models-us-east-1";

const ssmClient = new SSMClient({ region: REGION });

function b64(s: string): string {
  return typeof Buffer !== "undefined" ? Buffer.from(s, "utf-8").toString("base64") : btoa(s);
}

export interface ReferenceImage {
  url: string;
  /** e.g. "floor plan", "aerial view", "hand sketch" - shown to Antigravity next to the file path so it knows what each image represents before reading it. */
  caption?: string;
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "job";
}

function extForUrl(url: string): string {
  const clean = url.split("?")[0];
  const match = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : "jpg";
}

/** On-box directory a build's reference images are downloaded into - shared between the download script and the brief text so both agree on paths without a runtime round-trip. */
export function refImageDir(jobId: string): string {
  return `/root/agy_jobs/${safeJobId(jobId)}/images`;
}

export function refImagePath(jobId: string, index: number, url: string): string {
  return `${refImageDir(jobId)}/ref_${String(index + 1).padStart(2, "0")}.${extForUrl(url)}`;
}

/**
 * Shell lines that download every reference image to its predetermined
 * refImagePath before agy starts, so agy's workspace already has them by the
 * time it reads the brief's file-path references. Downloads over plain HTTP
 * from a public URL (Supabase Storage) rather than embedding image bytes in
 * the SSM command itself - SSM's command payload is far too small for real
 * image files (a single photo can already exceed it), the way it comfortably
 * fits the brief's own text.
 */
function buildImageFetchScript(jobId: string, images: ReferenceImage[]): string {
  if (!images.length) return "";
  const dir = refImageDir(jobId);
  const lines = [`mkdir -p ${dir}`];
  images.forEach((img, i) => {
    const path = refImagePath(jobId, i, img.url);
    const urlB64 = b64(img.url);
    lines.push(`curl -sL --max-time 30 -o "${path}" "$(echo ${urlB64} | base64 -d)" || echo "WARN: failed to download reference image ${i + 1}"`);
  });
  return lines.join("\n");
}

/**
 * Builds the on-box shell script for one build. The agy process itself is
 * backgrounded so this script can run a heartbeat loop alongside it that
 * polls get_scene_info and echoes progress to real stdout - the script only
 * exits (letting SSM mark the command Success) once agy itself has finished
 * and the final result has been parsed and printed as IFC_URL:/FILE_SIZE:/
 * ELEMENT_COUNT: markers, mirroring openhands_agent.ts's own marker
 * convention so the two engines can share a result-parsing shape later if
 * useful.
 *
 * Depends on infrastructure already set up once on this box this session:
 * the `agy` binary at ~/.local/bin, a login already exchanged for a Google
 * OAuth credential in gnome-keyring, and a persistent dbus session (env vars
 * in /root/dbus_env.sh) keeping that keyring unlocked and reachable. None of
 * that is created here - if the box is ever replaced/rebooted, that one-time
 * setup needs to be redone before this will work again.
 */
function buildScript(brief: string, jobId: string, images: ReferenceImage[] = []): string {
  const safeId = safeJobId(jobId);
  const briefB64 = b64(brief);
  const imageFetch = buildImageFetchScript(jobId, images);
  const addDirFlag = images.length ? `--add-dir ${refImageDir(jobId)}` : "";
  const inner = `#!/bin/bash
export HOME=/root
export PATH="$HOME/.local/bin:$PATH"
source /root/dbus_env.sh
mkdir -p /root/agy_jobs /root/agy_jobs/queue

# Single status channel the Lambda poller reads over plain HTTPS (it cannot
# reach this box's private ports, and SSM's own stdout never streams mid-
# command - confirmed: StandardOutputContent stays empty until Success). Every
# phase of this build (queued/building/done/error) is pushed here so the
# poller has one place to check regardless of which slot ends up running it.
STATUS_KEY="builds/${safeId}/status.json"
write_status() {
  echo "$1" > /tmp/status_${safeId}.json
  aws s3 cp /tmp/status_${safeId}.json "s3://${STATUS_BUCKET}/$STATUS_KEY" --region us-east-1 --content-type application/json >/dev/null 2>&1
}
write_status '{"status":"queued","position":1}'

${imageFetch}

echo "${briefB64}" | base64 -d > /root/agy_jobs/task_${safeId}.txt
BRIEF=$(cat /root/agy_jobs/task_${safeId}.txt)

# ── 3-slot queue ────────────────────────────────────────────────────────────
# The box runs 3 fully separate MCP containers (own Blender, own IFC scene -
# see ec2/setup_mcp_slots.sh), one per slot. A build takes whichever slot's
# lock it can grab; if all 3 are held it waits its turn in arrival order. This
# replaces the old single global flock, which made every build wait no matter
# how much spare capacity the box actually had.
exec 209>>/root/agy_jobs/ticket.lock
flock 209
TICKET=$(( $(cat /root/agy_jobs/ticket_counter 2>/dev/null || echo 0) + 1 ))
echo $TICKET > /root/agy_jobs/ticket_counter
flock -u 209
touch "/root/agy_jobs/queue/${safeId}.$TICKET"

exec 211>/root/agy_jobs/slot1.lock
exec 212>/root/agy_jobs/slot2.lock
exec 213>/root/agy_jobs/slot3.lock

SLOT=0
while [ "$SLOT" -eq 0 ]; do
  if flock -n 211; then SLOT=1
  elif flock -n 212; then SLOT=2
  elif flock -n 213; then SLOT=3
  else
    AHEAD=$(ls /root/agy_jobs/queue 2>/dev/null | awk -F. -v t="$TICKET" '{n=$NF; if ((n+0) < (t+0)) c++} END{print c+0}')
    write_status "{\\"status\\":\\"queued\\",\\"position\\":$((AHEAD+1))}"
    sleep 4
  fi
done
rm -f "/root/agy_jobs/queue/${safeId}.$TICKET"

case $SLOT in
  1) AGY_HOME=/root ;;
  2) AGY_HOME=/root/slots/home2 ;;
  3) AGY_HOME=/root/slots/home3 ;;
esac
SLOT_PORT=$((7999 + SLOT))
export SLOT_PORT
write_status "{\\"status\\":\\"building\\",\\"slot\\":$SLOT,\\"elementCount\\":0}"

# Heartbeat: reads the live element count from THIS slot's own MCP server
# (127.0.0.1 only, never crosses slots) and republishes it to S3 every ~6s so
# the poller can show live progress. Killed once agy itself finishes.
(
  while true; do
    CNT=$(curl -s -m 4 -X POST "http://127.0.0.1:$SLOT_PORT/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scene_info","arguments":{}}}' 2>/dev/null | grep -o '"count"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' | head -1)
    if [ -n "$CNT" ]; then write_status "{\\"status\\":\\"building\\",\\"slot\\":$SLOT,\\"elementCount\\":$CNT}"; fi
    sleep 6
  done
) &
HEARTBEAT_PID=$!

setsid nohup env HOME=$AGY_HOME agy --model ${AGY_MODEL} --effort high -p "$BRIEF" --dangerously-skip-permissions ${addDirFlag} --output-format json --print-timeout 30m > /root/agy_jobs/${safeId}.log 2>&1 < /dev/null &
AGY_PID=$!
wait $AGY_PID
kill $HEARTBEAT_PID 2>/dev/null

cat > /root/agy_jobs/parse_${safeId}.py <<'PYEOF'
import json, os, re, subprocess, time
import urllib.request as _ur
STATUS_BUCKET = "${STATUS_BUCKET}"
STATUS_KEY = "builds/${safeId}/status.json"

def push_status(obj):
    try:
        subprocess.run(
            ["aws", "s3", "cp", "-", f"s3://{STATUS_BUCKET}/{STATUS_KEY}", "--region", "us-east-1", "--content-type", "application/json"],
            input=json.dumps(obj).encode(), capture_output=True,
        )
    except Exception:
        pass

# Authoritative element count, straight from this slot's own MCP server (same
# call the heartbeat used during the build) - a real number regardless of how
# agy happened to phrase its own text summary. Preferred over the regex below,
# which only exists as a fallback for when this call fails.
def final_element_count():
    port = os.environ.get("SLOT_PORT")
    if not port:
        return None
    try:
        req = _ur.Request(
            f"http://127.0.0.1:{port}/mcp",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_scene_info", "arguments": {}}}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        )
        with _ur.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode())
        for item in body.get("result", {}).get("content", []) or []:
            if isinstance(item, dict) and "text" in item:
                parsed = json.loads(item["text"])
                if isinstance(parsed.get("count"), int):
                    return parsed["count"]
    except Exception:
        pass
    return None

# Authoritative file size, straight off the object actually sitting in S3 -
# real bytes, not agy's own text description of them. Only callable once the
# unique-key copy below has succeeded.
def s3_object_size(bucket, key):
    try:
        r = subprocess.run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", key, "--region", "us-east-1"], capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout).get("ContentLength")
    except Exception:
        pass
    return None

with open('/root/agy_jobs/${safeId}.log') as f:
    content = f.read()
try:
    data = json.loads(content)
    resp = data.get('response', '') or data.get('error', '') or content
except Exception:
    resp = content

url_match = re.search(r'https://\\S+\\.ifc\\S*', resp)
size_match = re.search(r'([\\d,]+)\\s*bytes', resp)
count_match = re.search(r'[Tt]otal[^:]*:\\s*\\**\\s*([\\d,]+)', resp)
# CLASH_REPORT:{...} is printed by the clash-check code agy runs and ends up
# embedded somewhere in its own prose response (e.g. inside a \`\`\`json fence),
# not necessarily at the end - confirmed live. A real report nests objects
# inside clash_types/worst, so a non-greedy regex up to the first '}' would
# truncate it there; json.JSONDecoder.raw_decode consumes exactly one valid
# JSON value from a given start position regardless of nesting, which a regex
# can't do correctly for arbitrarily nested braces. Takes the LAST marker in
# case agy quotes it more than once in its own summary.
clash_json = None
_dec = json.JSONDecoder()
for _m in re.finditer(r'CLASH_REPORT:', resp):
    try:
        _obj, _ = _dec.raw_decode(resp, _m.end())
        clash_json = _obj
    except Exception:
        pass
if clash_json is not None:
    print(f'CLASH_REPORT:{json.dumps(clash_json)}')
if url_match:
    url = url_match.group(0).rstrip(').,"\\'')
    # The MCP server exports every build to ONE shared S3 key per slot (its
    # path is md5 of a constant session id, or a fixed slot key for slots
    # 2/3), so a saved link would show whichever build in that slot exported
    # last. Copy this build's file to a key unique to this job while still
    # holding the slot lock (nobody else can have exported in this slot in
    # between), and hand back that link instead. Falls back to the shared
    # link only if the copy fails.
    final_url = url
    authoritative_size = None
    m = re.match(r'https://([^.]+)\\.s3[.\\w-]*\\.amazonaws\\.com/([^?]+)', url)
    if m:
        bucket, shared_key = m.group(1), m.group(2)
        unique_key = 'models/${safeId}/model.ifc'
        r = subprocess.run(['aws', 's3', 'cp', f's3://{bucket}/{shared_key}', f's3://{bucket}/{unique_key}', '--region', 'us-east-1'], capture_output=True, text=True)
        if r.returncode == 0:
            final_url = f'https://{bucket}.s3.us-east-1.amazonaws.com/{unique_key}?t={int(time.time())}'
            authoritative_size = s3_object_size(bucket, unique_key)
    final_count = final_element_count()
    if final_count is None and count_match:
        final_count = int(count_match.group(1).replace(",", ""))
    final_size = authoritative_size
    if final_size is None and size_match:
        final_size = int(size_match.group(1).replace(",", ""))
    print(f'IFC_URL:{final_url}')
    if final_size is not None:
        print(f'FILE_SIZE:{final_size}')
    if final_count is not None:
        print(f'ELEMENT_COUNT:{final_count}')
    push_status({
        "status": "done",
        "ifcUrl": final_url,
        "fileSize": final_size,
        "elementCount": final_count,
        "clashReport": clash_json,
    })
else:
    err = resp[-500:]
    print(f'BUILD_ERROR:{err}')
    push_status({"status": "error", "error": err})
PYEOF
python3 /root/agy_jobs/parse_${safeId}.py
`;
  return `echo ${b64(inner)} | base64 -d > /tmp/run_agy_${safeId}.sh && bash /tmp/run_agy_${safeId}.sh`;
}

export async function startAntigravityBuild(brief: string, jobId: string, images: ReferenceImage[] = []): Promise<string> {
  if (!brief || !brief.trim()) throw new Error("startAntigravityBuild: empty brief");
  const script = buildScript(brief, jobId, images);
  const res = await ssmClient.send(new SendCommandCommand({
    InstanceIds: [INSTANCE_ID],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [script] },
    TimeoutSeconds: 4500, // 75 min ceiling - up to 35 min waiting on the build lock, then the 30m --print-timeout, plus export overhead
  }));
  const commandId = res.Command?.CommandId;
  if (!commandId) throw new Error("startAntigravityBuild: SendCommand returned no CommandId");
  console.log(`[antigravity_agent] Started build jobId=${jobId} ssmCommandId=${commandId}`);
  return commandId;
}

/**
 * Live element count straight from the MCP server, bypassing SSM entirely -
 * kept as a fallback for slot 1 only (the one build slot whose MCP port is
 * actually public). Slots 2/3 bind to 127.0.0.1 on the box on purpose (see
 * ec2/setup_mcp_slots.sh), so their progress comes from the S3 status channel
 * (see fetchBuildStatus) instead - this function can no longer see them. Any
 * failure (server still booting, transient network blip) just yields "no
 * count this round", not a thrown error - a best-effort hint, not a critical path.
 */
async function fetchLiveElementCount(): Promise<number | undefined> {
  try {
    const res = await fetch(getMcpUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_scene_info", arguments: {} } }),
    });
    const json = await res.json();
    const text = extractText(json?.result?.content);
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    return typeof parsed?.count === "number" ? parsed.count : undefined;
  } catch {
    return undefined;
  }
}

interface BuildStatus {
  status?: "queued" | "building" | "done" | "error";
  position?: number;
  slot?: number;
  elementCount?: number;
  ifcUrl?: string;
  fileSize?: number;
  clashReport?: ClashReport;
  error?: string;
}

/**
 * Reads this build's own status.json off S3 - the one channel that works
 * regardless of which of the 3 slots ends up running it, and regardless of
 * whether the build is still queued (see buildScript's write_status calls).
 * Public bucket, so a plain fetch works from Lambda with no AWS credentials;
 * 404 just means the on-box script hasn't written anything yet (command still
 * propagating to the instance), not an error.
 */
async function fetchBuildStatus(jobId: string): Promise<BuildStatus | undefined> {
  try {
    const safeId = safeJobId(jobId);
    const url = `https://${STATUS_BUCKET}.s3.us-east-1.amazonaws.com/builds/${safeId}/status.json?t=${Date.now()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

export interface AntigravityPollResult {
  done: boolean;
  ifcUrl?: string;
  fileSize?: number;
  elementCount?: number;
  error?: string;
  progressMessage?: string;
  /** Position in the on-box queue (1 = next up) while every slot is busy.
   *  Undefined once the build has actually started (status moves to
   *  "building"). The frontend uses this to show a "you can close this tab"
   *  banner instead of the usual build-progress text. */
  queuePosition?: number;
  /** Raw geometric clash report Antigravity printed before exporting, if the
   *  brief asked it to run one (see clash_check.ts). Undefined if it never
   *  ran or printed nothing parseable - never treated as a failure either way. */
  clashReport?: ClashReport;
  /** Jev's severity triage of clashReport, if JEV_API_KEY is configured. A
   *  MAJOR_REGENERATE action is acted on by the caller (agent-bim/index.ts) -
   *  it triggers one targeted repair pass rather than just being logged. */
  clashVerdict?: { action: string; confidence: number };
}

/** Turns a raw (and potentially long) clash list into a short severity verdict
 *  Jev can reason about, without exceeding its ~32k token state+question cap
 *  and without burning tokens on trivial low-depth overlaps that don't matter.
 *  Never throws - see jevSafe. */
async function triageClashReport(report: ClashReport): Promise<{ action: string; confidence: number } | undefined> {
  if (report.clashes_found === 0) return undefined;
  const state = {
    elements_checked: report.elements_checked,
    clashes_found: report.clashes_found,
    // clash_types (counts per pair of classes) matters more here than the raw
    // list: a bounding-box check on diagonal/radial members (bracing,
    // diagrids, trusses) produces many geometrically-expected overlaps
    // between the SAME two classes at a similar depth, because an
    // axis-aligned box around a thin diagonal member is much bigger than the
    // member itself - confirmed against a real diagrid structure (1,560
    // flagged, ~99% one class-pair around convergence points, not real
    // problems). One class-pair dominating the count is a signal to weigh
    // that pattern down, not a signal of 1,560 real problems.
    clash_types: report.clash_types,
    worst_clashes: report.worst.slice(0, 20),
  };
  const answers = await jevSafe(state, {
    verdict: {
      type: "choice",
      instructions: "Given this geometric clash report from a just-built IFC building model, how severe is the situation overall? Note: a bounding-box check flags many expected overlaps between diagonal/radial structural members (bracing, diagrids, trusses) even when the members themselves don't truly intersect - if clash_types shows one class-pair accounting for most of clashes_found at a similar depth, that is very likely this pattern, not real problems, and should weigh toward PASS. Weigh toward MAJOR_REGENERATE only when the report shows real structural-type clashes (e.g. a beam or column driven through a wall/slab) that aren't explained by one repeated diagonal-member pattern.",
      criteria: {
        PASS: "No clashes worth caring about at this modelling scale - trivial/shallow overlaps, or dominated by one repeated diagonal-member bounding-box pattern",
        MINOR_AUTO_FIX: "A handful of real, distinct clashes outside any repeated pattern - worth noting, not worth rejecting the model",
        MAJOR_REGENERATE: "Deep structural clashes (e.g. a beam or column driven through a wall/slab) that are NOT explained by a single repeated diagonal-member class-pair, suggesting a genuine modelling error",
      },
    },
  });
  if (!answers || answers.verdict.type !== "choice") return undefined;
  const a = answers.verdict as ChoiceAnswer;
  return { action: a.choice, confidence: a.confidence };
}

/**
 * One-shot status check - does not block/sleep internally (unlike
 * pollOpenHandsBuild). Callers loop this from outside (e.g. the frontend's
 * own continuation loop, or a short server-side delay before returning) so
 * progress can be surfaced on every round-trip rather than only once per
 * multi-minute Lambda invocation.
 *
 * Primary source is this build's own S3 status.json (see fetchBuildStatus) -
 * the only channel that works while the build is still queued (SSM hasn't
 * even acquired a slot yet) and regardless of which of the 3 slots it lands
 * in (only slot 1's MCP port is public). Falls through to the original
 * SSM-invocation/marker-parsing logic only when status.json hasn't appeared
 * yet or the on-box script crashed before ever writing to it - so a genuinely
 * wedged build still surfaces a real error instead of polling forever.
 */
export async function pollAntigravityBuild(commandId: string, jobId?: string): Promise<AntigravityPollResult> {
  if (jobId) {
    const s3Status = await fetchBuildStatus(jobId);
    if (s3Status?.status === "queued") {
      const position = s3Status.position ?? 1;
      // Same ~8s pacing the old SSM-fallback path always had - status.json
      // reads are fast (a plain HTTPS GET, no SSM round trip), so without
      // this delay the frontend's poll loop races through its whole pass
      // budget in well under a minute instead of the ~30min+ it's sized
      // for, and gives up on a build that's still perfectly healthy
      // (confirmed live: a real user's build finished successfully on the
      // box, but the frontend had already reported "still running in the
      // background" and stopped polling before that happened).
      await new Promise((r) => setTimeout(r, 8000));
      return {
        done: false,
        queuePosition: position,
        progressMessage: `🕒 High demand — you're #${position} in line. Your build starts automatically; feel free to close this tab and check back later.`,
      };
    }
    if (s3Status?.status === "building") {
      const count = s3Status.elementCount;
      // typeof check, not truthy - a genuine 0 (agy has grabbed its slot and
      // is running, just hasn't created anything yet) must still say
      // "Building...", not fall back to "Build starting..." as if no slot
      // had been claimed at all.
      await new Promise((r) => setTimeout(r, 8000));
      return {
        done: false,
        elementCount: count,
        progressMessage: typeof count === "number" ? `Building... ${count.toLocaleString()} elements created so far` : "Build starting...",
      };
    }
    if (s3Status?.status === "done" && s3Status.ifcUrl) {
      const clashVerdict = s3Status.clashReport ? await triageClashReport(s3Status.clashReport) : undefined;
      return {
        done: true,
        ifcUrl: s3Status.ifcUrl,
        fileSize: s3Status.fileSize,
        elementCount: s3Status.elementCount,
        clashReport: s3Status.clashReport,
        clashVerdict,
      };
    }
    if (s3Status?.status === "error") {
      return { done: true, error: (s3Status.error || "Build failed.").slice(0, 500) };
    }
    // No status.json yet - command may still be propagating to the instance,
    // or (rarely) this is an older continuation from before this channel
    // existed. Fall through to the SSM-based check below.
  }

  try {
    const res = await ssmClient.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: INSTANCE_ID }));
    const status = res.Status;
    const out = res.StandardOutputContent || "";

    if (status === "Success") {
      const urlMatch = out.match(/IFC_URL:(\S+)/);
      if (urlMatch) {
        const sizeMatch = out.match(/FILE_SIZE:(\d+)/);
        const countMatch = out.match(/ELEMENT_COUNT:(\d+)/);
        const clashReport = extractClashReport(out) ?? undefined;
        // This poll always returns done:true here regardless of the verdict -
        // acting on MAJOR_REGENERATE (starting a repair pass) is the caller's
        // job (agent-bim/index.ts), since that's where build briefs already
        // live and where the one-attempt cap is tracked via the continuation.
        const clashVerdict = clashReport ? await triageClashReport(clashReport) : undefined;
        if (clashReport) {
          console.log(`[jev] clash triage: ${clashReport.clashes_found} clash(es) among ${clashReport.elements_checked} checked -> ${clashVerdict ? `${clashVerdict.action} (${clashVerdict.confidence.toFixed(2)})` : "no verdict (Jev unavailable)"}`);
        }
        return {
          done: true,
          ifcUrl: urlMatch[1],
          fileSize: sizeMatch ? Number(sizeMatch[1]) : undefined,
          elementCount: countMatch ? Number(countMatch[1]) : undefined,
          clashReport,
          clashVerdict,
        };
      }
      const errMatch = out.match(/BUILD_ERROR:([\s\S]*)/);
      return { done: true, error: errMatch ? errMatch[1].trim().slice(0, 500) : "Build finished but produced no IFC URL and no error marker." };
    }

    if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
      const errText = res.StandardErrorContent || out || `Build process ended with status ${status}`;
      return { done: true, error: `Build ${status}: ${errText.slice(0, 500)}` };
    }

    // Pending / InProgress / Delayed - SSM gives us nothing usable here (see
    // buildScript's comment), so read the live element count straight from
    // the MCP server's own public endpoint instead. Best-effort: a failed
    // fetch (e.g. Blender still booting) just means no count this round, not
    // an error worth surfacing.
    const elementCount = await fetchLiveElementCount();
    // Without a delay here, a caller that loops this with no pacing of its
    // own (e.g. the frontend's continuation loop, which has a fixed
    // max-passes budget) burns through that whole budget in seconds against
    // a build that runs for minutes.
    await new Promise((r) => setTimeout(r, 8000));
    return {
      done: false,
      elementCount,
      progressMessage: elementCount !== undefined
        ? `Building... ${elementCount.toLocaleString()} elements created so far`
        : "Build starting...",
    };
  } catch (err: any) {
    const msg = String(err?.name || err?.message || err);
    if (msg.includes("InvocationDoesNotExist")) {
      // A freshly-sent command can briefly 404 before it propagates to the instance.
      await new Promise((r) => setTimeout(r, 8000));
      return { done: false, progressMessage: "Build starting..." };
    }
    await new Promise((r) => setTimeout(r, 8000));
    return { done: false, progressMessage: `Build status check warning: ${msg.slice(0, 200)}` };
  }
}
