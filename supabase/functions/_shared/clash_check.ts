/**
 * Geometric clash detection, run INSIDE Antigravity's own build session before
 * it exports - not a separate pass the orchestrator drives. This is a Python
 * snippet spliced into the build brief as literal instructions; Antigravity
 * executes it itself via execute_ifc_code_tool, exactly like the existing
 * get_scene_info reviewer step, and prints one line the orchestrator later
 * parses out of the SSM stdout: CLASH_REPORT:{...json...}
 *
 * Why it runs inside Antigravity's session rather than as an orchestrator-side
 * MCP call: the geometry only exists in the MCP server's live IfcStore during
 * the build, and Antigravity already has a Python execution tool wired to it
 * (execute_ifc_code_tool) - reusing that is far less new surface than adding
 * a bespoke MCP tool. The MCP sandbox blacklists network modules (see
 * ifc-bonsai-mcp-main/blender_addon/api/code.py BLACKLISTED_MODULES), so this
 * code CANNOT call Jev itself even if it wanted to - Jev only ever sees the
 * short printed summary, from the orchestrator side, in jev_client.ts.
 *
 * Deliberately conservative about what counts as a "clash" worth reporting:
 * - broad-phase bucketing by (storey, tile) so this stays fast on a
 *   20,000+ element model instead of a naive O(n^2) pairwise scan
 * - only structural-ish classes (walls, slabs, beams, columns, footings,
 *   piles, roofs) are checked against each other; MEP/cable/fastener classes
 *   are excluded because in a dense model like this they are EXPECTED to
 *   touch constantly (a bracket against a bolt is not a clash)
 * - only penetrations deeper than CLASH_MIN_DEPTH_M are reported at all - two
 *   elements sharing a face (the normal way a wall meets a slab) is not a
 *   clash, it is how buildings are built
 * - capped to the worst CLASH_MAX_REPORTED by penetration depth, so the
 *   printed report - and what gets sent to Jev afterward - stays small
 */
export const CLASH_CHECK_PYTHON = `
import json as _json

def _run_clash_check():
    import ifcopenshell.geom as _geom
    CLASH_MIN_DEPTH_M = 0.05
    CLASH_MAX_REPORTED = 40
    STRUCTURAL_CLASSES = {
        "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn",
        "IfcFooting", "IfcPile", "IfcRoof", "IfcRamp", "IfcStair",
    }
    settings = _geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    def bbox_of(el):
        shape = _geom.create_shape(settings, el)
        v = shape.geometry.verts
        if len(v) < 9:
            return None
        xs, ys, zs = v[0::3], v[1::3], v[2::3]
        return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

    def overlap_depth(a, b):
        dx = min(a[3], b[3]) - max(a[0], b[0])
        dy = min(a[4], b[4]) - max(a[1], b[1])
        dz = min(a[5], b[5]) - max(a[2], b[2])
        if dx <= 0 or dy <= 0 or dz <= 0:
            return 0.0
        return min(dx, dy, dz)

    ifc = get_ifc_file()
    items = []
    for el in ifc.by_type("IfcElement"):
        if el.is_a() not in STRUCTURAL_CLASSES:
            continue
        try:
            bb = bbox_of(el)
        except Exception:
            bb = None
        if bb is None:
            continue
        tile = (round((bb[0] + bb[3]) / 2 / 8.0), round((bb[1] + bb[4]) / 2 / 8.0),
                round((bb[2] + bb[5]) / 2 / 4.0))
        items.append((el, bb, tile))

    buckets = {}
    for el, bb, tile in items:
        buckets.setdefault(tile, []).append((el, bb))

    seen = set()
    clashes = []
    for (tx, ty, tz), _ in buckets.items():
        neighbours = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    neighbours.extend(buckets.get((tx + dx, ty + dy, tz + dz), []))
        for i in range(len(neighbours)):
            el_a, bb_a = neighbours[i]
            for j in range(i + 1, len(neighbours)):
                el_b, bb_b = neighbours[j]
                if el_a is el_b:
                    continue
                pair_key = tuple(sorted((el_a.id(), el_b.id())))
                if pair_key in seen:
                    continue
                seen.add(pair_key)
                depth = overlap_depth(bb_a, bb_b)
                if depth >= CLASH_MIN_DEPTH_M:
                    clashes.append({
                        "a": el_a.Name or el_a.is_a(), "a_class": el_a.is_a(),
                        "b": el_b.Name or el_b.is_a(), "b_class": el_b.is_a(),
                        "depth_m": round(depth, 3),
                    })

    # A pure top-N-by-depth report gets swamped by one repeated shape - e.g.
    # radial/diagonal members converging near a shared point legitimately have
    # overlapping AXIS-ALIGNED bounding boxes even when the thin members
    # themselves don't actually intersect (confirmed against a real diagrid
    # structure: 1,560 "clashes", ~99% one class-pair, same ~3.5m depth,
    # around convergence points). Grouping by class-pair and capping each
    # group keeps that one pattern from burying a rare but real clash between
    # a different pair of classes, and the per-group counts tell Jev how much
    # of the total is one repeated pattern versus how spread out it is.
    clashes.sort(key=lambda c: -c["depth_m"])
    by_pair = {}
    for c in clashes:
        key = tuple(sorted((c["a_class"], c["b_class"])))
        by_pair.setdefault(key, []).append(c)
    PER_PAIR_CAP = 6
    worst = []
    for key in sorted(by_pair.keys(), key=lambda k: -max(c["depth_m"] for c in by_pair[k])):
        worst.extend(by_pair[key][:PER_PAIR_CAP])
    worst = worst[:CLASH_MAX_REPORTED]
    report = {
        "elements_checked": len(items),
        "clashes_found": len(clashes),
        "clash_types": [
            {"classes": list(key), "count": len(by_pair[key]), "max_depth_m": round(max(c["depth_m"] for c in by_pair[key]), 3)}
            for key in sorted(by_pair.keys(), key=lambda k: -len(by_pair[k]))
        ],
        "worst": worst,
    }
    print("CLASH_REPORT:" + _json.dumps(report))
    return report

try:
    _clash_report = _run_clash_check()
except Exception as _e:
    print("CLASH_REPORT:" + _json.dumps({"error": str(_e), "elements_checked": 0, "clashes_found": 0, "worst": []}))
`.trim();

/** Parsed shape of the CLASH_REPORT: line above. */
export interface ClashReport {
  elements_checked: number;
  clashes_found: number;
  /** Clash count grouped by the pair of IFC classes involved, worst depth first -
   *  lets a consumer see "1,540 of these are one Beam-vs-Beam pattern" instead of
   *  just a flat list dominated by whichever pattern happens to be deepest. */
  clash_types: Array<{ classes: [string, string]; count: number; max_depth_m: number }>;
  worst: Array<{ a: string; a_class: string; b: string; b_class: string; depth_m: number }>;
  error?: string;
}

/** Pulls the last CLASH_REPORT: line out of an SSM command's combined stdout,
 *  same technique already used for the PROGRESS:count=<n> lines. Returns null
 *  if Antigravity never got to running the check (e.g. it errored out earlier). */
export function extractClashReport(stdout: string): ClashReport | null {
  const lines = stdout.split("\n").filter((l) => l.startsWith("CLASH_REPORT:"));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice("CLASH_REPORT:".length));
  } catch {
    return null;
  }
}
