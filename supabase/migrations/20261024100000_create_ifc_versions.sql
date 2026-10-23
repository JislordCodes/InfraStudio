-- Version history for each chat's model: every successful build, edit, stage or
-- import adds a row so users can compare versions and roll back. Visibility
-- follows the owning chat (same device_id / ip_hash rule as ifc_messages).

CREATE TABLE IF NOT EXISTS ifc_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES ifc_sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    ifc_url TEXT NOT NULL,
    label TEXT,
    stage TEXT,
    element_count INTEGER,
    file_size BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (session_id, version)
);

CREATE INDEX IF NOT EXISTS ifc_versions_session_idx ON ifc_versions (session_id, version);

ALTER TABLE ifc_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "device_select_versions" ON ifc_versions;
CREATE POLICY "device_select_versions" ON ifc_versions FOR SELECT USING (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);

DROP POLICY IF EXISTS "device_insert_versions" ON ifc_versions;
CREATE POLICY "device_insert_versions" ON ifc_versions FOR INSERT WITH CHECK (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);

DROP POLICY IF EXISTS "device_delete_versions" ON ifc_versions;
CREATE POLICY "device_delete_versions" ON ifc_versions FOR DELETE USING (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);
