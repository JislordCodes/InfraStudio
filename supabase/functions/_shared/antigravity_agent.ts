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
mkdir -p /root/agy_jobs

${imageFetch}

echo "${briefB64}" | base64 -d > /root/agy_jobs/task_${safeId}.txt
BRIEF=$(cat /root/agy_jobs/task_${safeId}.txt)

# The MCP/Blender server behind every build holds exactly ONE global in-memory
# IFC scene (IfcStore) - there is no per-session isolation on that side at
# all. Killing whatever build was previously running (the old behavior here)
# could interrupt it mid tool-call, leaving its partial geometry in the scene
# for the NEXT build's initialize_project to (sometimes) fail to fully clear -
# this is what produced real reports of one session's model bleeding into
# another session's freshly-generated export. flock makes every build wait
# for the previous one to finish cleanly instead of interrupting it, so the
# shared scene only ever has one build's geometry in it at a time. The wait
# is bounded well past agy's own 30m print-timeout so a genuinely wedged
# build can't block every future request forever.
exec 200>/root/agy_jobs/build.lock
flock -w 2100 200 || { echo "BUILD_ERROR:Timed out waiting for another build already in progress to finish - the system is under heavy load, please try again shortly."; exit 1; }

setsid nohup agy --model ${AGY_MODEL} --effort high -p "$BRIEF" --dangerously-skip-permissions ${addDirFlag} --output-format json --print-timeout 30m > /root/agy_jobs/${safeId}.log 2>&1 < /dev/null &
AGY_PID=$!

# Nothing needs to run alongside agy here - live progress is read by the
# caller straight from the MCP server's public endpoint (see
# pollAntigravityBuild), not from this script's own output, because SSM does
# not surface a running command's stdout until it reaches a terminal state
# (confirmed directly: StandardOutputContent stays empty the whole time a
# command is InProgress, then appears all at once on Success) - a heartbeat
# echoing progress here would never actually reach the poller before the
# build was already done anyway.
wait $AGY_PID

cat > /root/agy_jobs/parse_${safeId}.py <<'PYEOF'
import json, re, subprocess, time
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
    # The MCP server exports every build to ONE shared S3 key (its path is
    # md5 of a constant session id), so a saved link would show whichever
    # build exported last - one user's model replacing another's. Copy this
    # build's file to a key unique to this job while still holding the build
    # lock (nobody else can have exported in between), and hand back that
    # link instead. Falls back to the shared link only if the copy fails.
    final_url = url
    m = re.match(r'https://([^.]+)\\.s3[.\\w-]*\\.amazonaws\\.com/([^?]+)', url)
    if m:
        bucket, shared_key = m.group(1), m.group(2)
        unique_key = 'models/${safeId}/model.ifc'
        r = subprocess.run(['aws', 's3', 'cp', f's3://{bucket}/{shared_key}', f's3://{bucket}/{unique_key}', '--region', 'us-east-1'], capture_output=True, text=True)
        if r.returncode == 0:
            final_url = f'https://{bucket}.s3.us-east-1.amazonaws.com/{unique_key}?t={int(time.time())}'
    print(f'IFC_URL:{final_url}')
    if size_match:
        print(f'FILE_SIZE:{size_match.group(1).replace(",", "")}')
    if count_match:
        print(f'ELEMENT_COUNT:{count_match.group(1).replace(",", "")}')
else:
    print(f'BUILD_ERROR:{resp[-500:]}')
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
 * this is what actually makes progress "stream" during a build, since the
 * SSM command itself reveals nothing until it finishes. Any failure (server
 * still booting, transient network blip) just yields "no count this round",
 * not a thrown error - this is a best-effort progress hint, not a critical path.
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

export interface AntigravityPollResult {
  done: boolean;
  ifcUrl?: string;
  fileSize?: number;
  elementCount?: number;
  error?: string;
  progressMessage?: string;
  /** Raw geometric clash report Antigravity printed before exporting, if the
   *  brief asked it to run one (see clash_check.ts). Undefined if it never
   *  ran or printed nothing parseable - never treated as a failure either way. */
  clashReport?: ClashReport;
  /** Jev's severity triage of clashReport, if JEV_API_KEY is configured.
   *  SHADOW MODE: purely informational right now, never blocks returning the
   *  model - see the "MAJOR_REGENERATE" note where this is read. */
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
 */
export async function pollAntigravityBuild(commandId: string): Promise<AntigravityPollResult> {
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
        // SHADOW MODE: the verdict is computed and logged so real-world severity
        // distributions can be observed before this is ever allowed to change
        // what gets returned to the user. To make MAJOR_REGENERATE actually
        // block/retry, branch on clashVerdict.action here instead of always
        // returning done:true.
        const clashVerdict = clashReport ? await triageClashReport(clashReport) : undefined;
        if (clashReport) {
          console.log(`[jev shadow] clash triage: ${clashReport.clashes_found} clash(es) among ${clashReport.elements_checked} checked -> ${clashVerdict ? `${clashVerdict.action} (${clashVerdict.confidence.toFixed(2)})` : "no verdict (Jev unavailable)"}`);
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
