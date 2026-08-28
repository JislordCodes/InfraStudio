Implement a spatial clash detection and clearance analysis engine in `frontend/src/spatial` with public exports in `frontend/src/spatial/index.ts`.

Export `createAxisAlignedBoundingBox(min, max)` returning `{ min, max, size, center }` using 3D `[x, y, z]` coordinates, throwing an Error with message matching `Invalid bounding box coordinates` if any min coordinate exceeds max.

Implement `detectClashes(elements, options?)` accepting `SpatialElement` items (`{ id, name, discipline, boundingBox, properties? }`) across disciplines (`architectural`, `structural`, `mechanical`, `electrical`, `plumbing`, `generic`). Return `ClashResult` containing `clashes` and `summary` (`{ total, hard, clearance, processedElements }`). Each `ClashRecord` contains `{ id, elementA, elementB, type, severity, distance, penetrationDepth?, intersectionBox? }`:
- Hard clashes: overlapping boxes, `type: 'hard'`, `severity: 'critical'`, `distance: 0`, setting `penetrationDepth` and `intersectionBox`.
- Clearance clashes: distance within `options.tolerance`, `type: 'clearance'`, `severity: 'high'` if distance < tolerance * 0.5, else `'medium'`.
- Support `options.includeTouching`, `options.minSeverity` (`critical` > `high` > `medium` > `low`), and pairwise `options.filterDisciplines`.

Implement `calculateClearance(elemA, elemB, requiredClearance)` returning `{ distance, hasConflict, closestPoints: { pointA, pointB } }` clamping box centers to bounding extents.

Implement `buildClearanceMatrix(elements, requiredClearance, maxDistanceCutoff?)` returning `{ elementIds, matrix, violations }` with symmetric pairwise distances and violation items (`{ elementA, elementB, distance, requiredClearance }`). Distances beyond cutoff must equal `Infinity`.

Implement `groupClashes(clashes, groupBy)` grouping records by `'severity'`, `'element'` (keyed by element IDs), or `'discipline'` (keyed by sorted hyphenated pair, e.g. `'mechanical-structural'`).

Implement `exportClashReport(result, format)` returning 2-space indented JSON string for `'json'`, or structured text containing the header `SPATIAL CLASH DETECTION REPORT` and lines formatted with `Total Clashes: <count>` and `Hard Clashes: <count>` for `'summary_text'`.

IMPORTANT: Please work on this in a new branch from main and commit everything when you are done.