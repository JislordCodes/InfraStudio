-- The live RLS policies on ifc_sessions/ifc_messages (added outside any
-- tracked migration - confirmed via debug_list_policies, dropped below)
-- restrict every row to `device_id = x-device-id header`, completely
-- independent of the ip_hash column added for cross-browser chat sync.
-- No application-level .or(ip_hash...,device_id...) query can work around
-- that - RLS is enforced underneath the query. This adds ip_hash as a
-- second, equally-valid visibility key via a new x-ip-hash header,
-- alongside the existing device_id/x-device-id check (never replacing it).
--
-- Trust model note: x-ip-hash is a client-supplied header, same as
-- x-device-id already is - there is no login system, so both are
-- unauthenticated-but-effectively-unguessable identifiers (a 64-hex-char
-- SHA-256, same guessability class as a random UUID). This does not lower
-- the bar the app already accepts for device_id.

DROP POLICY IF EXISTS "device_select_sessions" ON ifc_sessions;
CREATE POLICY "device_select_sessions" ON ifc_sessions FOR SELECT USING (
  device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
  OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
);

DROP POLICY IF EXISTS "device_update_sessions" ON ifc_sessions;
CREATE POLICY "device_update_sessions" ON ifc_sessions FOR UPDATE USING (
  device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
  OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
);

DROP POLICY IF EXISTS "device_delete_sessions" ON ifc_sessions;
CREATE POLICY "device_delete_sessions" ON ifc_sessions FOR DELETE USING (
  device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
  OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
);

-- INSERT stays device_id-only - a browser only ever creates rows tagged
-- with its own device_id, never needs to insert "as" another device.

DROP POLICY IF EXISTS "device_select_messages" ON ifc_messages;
CREATE POLICY "device_select_messages" ON ifc_messages FOR SELECT USING (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);

DROP POLICY IF EXISTS "device_insert_messages" ON ifc_messages;
CREATE POLICY "device_insert_messages" ON ifc_messages FOR INSERT WITH CHECK (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);

DROP POLICY IF EXISTS "device_delete_messages" ON ifc_messages;
CREATE POLICY "device_delete_messages" ON ifc_messages FOR DELETE USING (
  session_id IN (
    SELECT id FROM ifc_sessions WHERE
      device_id = ((current_setting('request.headers', true))::json ->> 'x-device-id')
      OR (ip_hash IS NOT NULL AND ip_hash = ((current_setting('request.headers', true))::json ->> 'x-ip-hash'))
  )
);

DROP FUNCTION IF EXISTS debug_list_policies();
