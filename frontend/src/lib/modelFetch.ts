// New builds store a gzip copy of the IFC next to the plain file
// (model.ifc.gz). IFC text shrinks about 10 times, which is most of the load
// time on a slow connection. The plain file stays as the fallback for older
// models and for every other consumer.

/** The gzip sibling of a model URL, or null when the URL is not a stored model. */
export function gzipSiblingUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/\.amazonaws\.com$/i.test(u.hostname)) return null
    // Only job-unique keys (a UUID folder). Shared slot keys such as models/c21f969b/ are
    // overwritten by later builds, so a gzip copy of them would go stale.
    if (!/\/models\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/model\.ifc$/i.test(u.pathname)) return null
    u.pathname = `${u.pathname}.gz`
    return u.toString()
  } catch {
    return null
  }
}

export async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The decompressed model bytes, or null when there is no usable gzip copy. */
export async function fetchGzippedModel(url: string): Promise<Uint8Array | null> {
  const gz = gzipSiblingUrl(url)
  if (!gz || typeof DecompressionStream === 'undefined') return null
  try {
    const res = await fetch(gz)
    if (!res.ok) return null
    const bytes = await gunzip(await res.arrayBuffer())
    // A real IFC file starts with ISO-10303-21.
    const head = new TextDecoder().decode(bytes.subarray(0, 12))
    return head.startsWith('ISO-10303') ? bytes : null
  } catch {
    return null
  }
}
