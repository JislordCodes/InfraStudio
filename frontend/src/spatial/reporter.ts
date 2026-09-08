/**
 * Spatial clash grouping and text/JSON export formatting
 */

import type { ClashRecord, ClashResult } from './types';

/**
 * Groups an array of clash records by severity, element ID, or discipline pair.
 */
export function groupClashes(
  clashes: ClashRecord[],
  groupBy: 'severity' | 'element' | 'discipline'
): Record<string, ClashRecord[]> {
  const grouped: Record<string, ClashRecord[]> = {};

  for (const clash of clashes) {
    let keys: string[] = [];

    if (groupBy === 'severity') {
      keys = [clash.severity];
    } else if (groupBy === 'element') {
      keys = [clash.elementA.id, clash.elementB.id];
    } else if (groupBy === 'discipline') {
      const dA = clash.elementA.discipline;
      const dB = clash.elementB.discipline;
      const pairKey = [dA, dB].sort().join('-');
      keys = [pairKey];
    }

    for (const key of keys) {
      if (!grouped[key]) {
        grouped[key] = [];
      }
      if (!grouped[key].some(c => c.id === clash.id)) {
        grouped[key].push(clash);
      }
    }
  }

  return grouped;
}

/**
 * Exports clash detection results as JSON or formatted summary text.
 */
export function exportClashReport(
  result: ClashResult,
  format: 'json' | 'summary_text'
): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];
  lines.push('========================================');
  lines.push('   SPATIAL CLASH DETECTION REPORT');
  lines.push('========================================');
  lines.push(`Total Clashes: ${result.summary.total}`);
  lines.push(`Hard Clashes: ${result.summary.hard}`);
  lines.push(`Clearance Violations: ${result.summary.clearance}`);
  lines.push(`Processed Elements: ${result.summary.processedElements}`);
  lines.push('----------------------------------------');

  if (result.clashes.length === 0) {
    lines.push('No clashes detected across processed elements.');
  } else {
    for (let i = 0; i < result.clashes.length; i++) {
      const c = result.clashes[i];
      lines.push(
        `${i + 1}. [${c.type.toUpperCase()}] (${c.severity.toUpperCase()}) ${c.elementA.name} <-> ${c.elementB.name}`
      );
      if (c.penetrationDepth !== undefined && c.penetrationDepth > 0) {
        lines.push(`   Penetration Depth: ${c.penetrationDepth.toFixed(3)}m`);
      } else if (c.distance > 0) {
        lines.push(`   Separation Distance: ${c.distance.toFixed(3)}m`);
      }
    }
  }

  lines.push('========================================');
  return lines.join('\n');
}
