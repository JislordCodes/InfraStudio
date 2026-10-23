import { getScopedSupabase } from './supabase';

/** One saved state of a chat's model: every successful build, edit, design
 *  stage or import adds a version so users can compare and roll back. */
export interface IfcVersion {
  id: string;
  session_id: string;
  version: number;
  ifc_url: string;
  label: string | null;
  stage: string | null;
  element_count: number | null;
  file_size: number | null;
  created_at: string;
}

export async function listVersions(sessionId: string): Promise<IfcVersion[]> {
  try {
    const supabase = await getScopedSupabase();
    const { data, error } = await supabase
      .from('ifc_versions')
      .select('*')
      .eq('session_id', sessionId)
      .order('version', { ascending: true });
    if (error) {
      console.warn('[versions] list failed:', error.message);
      return [];
    }
    return (data || []) as IfcVersion[];
  } catch (e) {
    console.warn('[versions] list error:', e);
    return [];
  }
}

/** Appends a version (next number for this chat). Never throws - history is a
 *  convenience and must not break a build that already succeeded. */
export async function addVersion(
  sessionId: string,
  v: { ifc_url: string; label?: string; stage?: string; element_count?: number; file_size?: number },
): Promise<IfcVersion | null> {
  try {
    const supabase = await getScopedSupabase();
    // Already saved (e.g. a second tab resumed the same build): don't duplicate.
    const { data: existing } = await supabase
      .from('ifc_versions')
      .select('*')
      .eq('session_id', sessionId)
      .eq('ifc_url', v.ifc_url)
      .limit(1);
    if (existing && existing.length > 0 && !/^Restored /.test(v.label || '')) return existing[0] as IfcVersion;
    // Retry on a version-number race (two tabs saving at once).
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: last } = await supabase
        .from('ifc_versions')
        .select('version')
        .eq('session_id', sessionId)
        .order('version', { ascending: false })
        .limit(1);
      const next = (last && last[0]?.version ? last[0].version : 0) + 1;
      const { data, error } = await supabase
        .from('ifc_versions')
        .insert({
          session_id: sessionId,
          version: next,
          ifc_url: v.ifc_url,
          label: v.label?.slice(0, 200) ?? null,
          stage: v.stage ?? null,
          element_count: v.element_count ?? null,
          file_size: v.file_size ?? null,
        })
        .select()
        .single();
      if (!error && data) return data as IfcVersion;
      if (error && !/duplicate|unique/i.test(error.message)) {
        console.warn('[versions] add failed:', error.message);
        return null;
      }
    }
  } catch (e) {
    console.warn('[versions] add error:', e);
  }
  return null;
}
