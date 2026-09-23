-- Tracks which IPs (hashed, never stored raw) have already used their one
-- free build on the public landing-page trial. RLS is enabled with NO
-- policies for anon/authenticated - only the service_role key (held only by
-- the Lambda backend, never shipped to the frontend) can read or write this
-- table, so a client holding the public anon key cannot inspect or clear
-- their own gate the way they could with the openly-writable ifc_sessions
-- table.

CREATE TABLE ip_trial_usage (
    ip_hash TEXT PRIMARY KEY,
    job_id TEXT,
    used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE ip_trial_usage ENABLE ROW LEVEL SECURITY;
