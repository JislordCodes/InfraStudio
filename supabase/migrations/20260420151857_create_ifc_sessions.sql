CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE ifc_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL DEFAULT 'New Session',
    mcp_session_id TEXT,
    last_ifc_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE ifc_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES ifc_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls JSONB,
    tool_call_id TEXT,
    reasoning_details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE ifc_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ifc_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for all users" ON ifc_sessions FOR SELECT USING (true);
CREATE POLICY "Enable insert for all users" ON ifc_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable update for all users" ON ifc_sessions FOR UPDATE USING (true);
CREATE POLICY "Enable delete for all users" ON ifc_sessions FOR DELETE USING (true);

CREATE POLICY "Enable read access for all users" ON ifc_messages FOR SELECT USING (true);
CREATE POLICY "Enable insert for all users" ON ifc_messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable delete for all users" ON ifc_messages FOR DELETE USING (true);
