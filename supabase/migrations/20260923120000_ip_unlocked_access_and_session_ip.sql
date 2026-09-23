-- Persistent, IP-scoped unlock status: once an IP supplies the correct
-- access code (see trial_gate.ts markIpUnlocked), it stays unlocked across
-- every browser/device on that IP, not just the one that visited the
-- ?unlock= link. RLS-locked to service_role only, same reasoning as
-- ip_trial_usage - a visitor holding the public anon key must never be able
-- to read or grant their own unlock.
CREATE TABLE ip_unlocked_access (
    ip_hash TEXT PRIMARY KEY,
    unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE ip_unlocked_access ENABLE ROW LEVEL SECURITY;

-- Chat session continuity by IP: sessions created from now on are tagged
-- with a hash of the creator's IP (in addition to the existing per-browser
-- device_id), so opening the same IP from a different browser/device can
-- find the same session history instead of starting from a blank slate.
ALTER TABLE ifc_sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT;
CREATE INDEX IF NOT EXISTS ifc_sessions_ip_hash_idx ON ifc_sessions (ip_hash);
