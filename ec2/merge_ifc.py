"""Merge several IFC section files into one model (parallel builds).

usage: merge_ifc.py OUT.ifc BASE.ifc SECTION2.ifc [SECTION3.ifc ...]

Each section was built by its own agent in its own empty scene, all from one
shared spec (same origin, grid and storey names/elevations). The first file is
the base (its project, site, building and storeys are kept); every product
from the other files is copied into it with its geometry, materials, styles
and property sets, then placed in the base storey with the same name (or the
nearest elevation, or a newly created storey).

Prints one JSON line with counts so the caller can verify nothing was lost.
Runs in /root/merge_venv (ifcopenshell), on the host - it needs no build slot.
"""
import json
import sys

import ifcopenshell
import ifcopenshell.api
import numpy
import ifcopenshell.guid
import ifcopenshell.util.element as E

SKIP_CLASSES = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcOpeningElement")


def skip(p):
    return any(p.is_a(c) for c in SKIP_CLASSES)


def elevation(storey):
    try:
        return float(storey.Elevation or 0.0)
    except Exception:
        return 0.0


def pick_storey(base, src_storey, cache):
    """Base storey matching a source storey: same name, else nearest elevation, else a new one."""
    key = (src_storey.Name or "", elevation(src_storey)) if src_storey is not None else None
    if key in cache:
        return cache[key]
    storeys = base.by_type("IfcBuildingStorey")
    chosen = None
    if src_storey is not None:
        name = (src_storey.Name or "").strip().lower()
        for st in storeys:
            if (st.Name or "").strip().lower() == name:
                chosen = st
                break
        if chosen is None and storeys:
            chosen = min(storeys, key=lambda st: abs(elevation(st) - elevation(src_storey)))
            # Far from any existing level (> 0.5 m): it is a different level, create it.
            if abs(elevation(chosen) - elevation(src_storey)) > 0.5:
                chosen = None
        if chosen is None:
            building = base.by_type("IfcBuilding")[0]
            chosen = ifcopenshell.api.run("root.create_entity", base, ifc_class="IfcBuildingStorey", name=src_storey.Name or "Level")
            chosen.Elevation = elevation(src_storey)
            # A storey without an object placement can crash the native writer.
            matrix = numpy.eye(4)
            matrix[2][3] = elevation(src_storey)
            ifcopenshell.api.run("geometry.edit_object_placement", base, product=chosen, matrix=matrix, is_si=False)
            ifcopenshell.api.run("aggregate.assign_object", base, products=[chosen], relating_object=building)
    elif storeys:
        chosen = min(storeys, key=elevation)
    cache[key] = chosen
    return chosen


def main():
    out_path, base_path, *others = sys.argv[1:]
    base = ifcopenshell.open(base_path)

    def count(f):
        return len([p for p in f.by_type("IfcProduct") if not skip(p)])

    report = {"base_products": count(base), "sections": []}
    storey_cache = {}
    # Keep every source file alive until the merged file is written: copied entities
    # can still point into their source file, and freeing it early corrupted memory
    # (native segfault in write).
    keep_alive = []
    for path in others:
        src = ifcopenshell.open(path)
        keep_alive.append(src)
        products = [p for p in src.by_type("IfcProduct") if not skip(p)]
        by_storey = {}
        copied = failed = 0
        for el in products:
            try:
                new = ifcopenshell.api.run("project.append_asset", base, library=src, element=el)
            except Exception as exc:  # keep going; report at the end
                failed += 1
                report.setdefault("errors", []).append("%s %s: %s" % (el.is_a(), el.GlobalId, str(exc)[:120]))
                continue
            if new is None:
                failed += 1
                continue
            copied += 1
            container = E.get_container(el)
            storey = container if container is not None and container.is_a("IfcBuildingStorey") else None
            if storey is None and container is not None:
                # inside a space/other container: use the storey that contains it
                parent = E.get_aggregate(container)
                while parent is not None and not parent.is_a("IfcBuildingStorey"):
                    parent = E.get_aggregate(parent)
                storey = parent
            target = pick_storey(base, storey, storey_cache)
            by_storey.setdefault(target.id() if target else 0, (target, []))[1].append(new)
        for target, new_products in by_storey.values():
            if target is None:
                continue
            # A plain containment relation: the copied placements already carry the right
            # absolute position, and assign_container re-parents placements (slow, and it
            # crashed IfcOpenShell natively on ~1000 products).
            for i in range(0, len(new_products), 500):
                base.create_entity("IfcRelContainedInSpatialStructure", GlobalId=ifcopenshell.guid.new(), RelatedElements=new_products[i:i + 500], RelatingStructure=target)
        report["sections"].append({"file": path.split("/")[-1], "products": len(products), "copied": copied, "failed": failed})

    base.write(out_path)
    report["merged_products"] = count(ifcopenshell.open(out_path))
    report["expected_products"] = report["base_products"] + sum(s["copied"] for s in report["sections"])
    report["storeys"] = [(s.Name, elevation(s)) for s in ifcopenshell.open(out_path).by_type("IfcBuildingStorey")]
    print(json.dumps(report))


if __name__ == "__main__":
    main()
