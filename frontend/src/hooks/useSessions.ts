import { useState, useEffect, useCallback } from 'react';
import { getScopedSupabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { getIdentity } from '../lib/identity';
import { enqueue, flushOutbox, pendingSessionUpdates, retrying, type OutboxJob } from '../lib/outbox';

export interface ChatSession {
  id: string;
  title: string;
  mcp_session_id: string | null;
  last_ifc_url: string | null;
  created_at: string;
}

export interface ChatMessage {
  id?: string;
  role: string;
  content: string;
  tool_calls?: any;
  tool_call_id?: string;
  reasoning_details?: string;
  /** Client-only, not persisted (saveMessage only writes the fields above) -
   *  an optional call-to-action rendered under this one message, e.g. the
   *  "Join the Waitlist" link shown when the public trial gate blocks a
   *  build. Reloading the page loses the button but keeps the message text,
   *  which already explains the situation on its own. */
  cta?: { label: string; url: string };
}

const ACTIVE_SESSION_KEY = 'infrastudio_active_session';

/** A session that exists in the database. Local fallback sessions start with "session_". */
const isDbSessionId = (id: string) => !id.startsWith('session_');

/** Writes one saved job to the database. True when it went through. */
async function sendJob(job: OutboxJob): Promise<boolean> {
  const supabase = await getScopedSupabase();
  if (job.kind === 'message') {
    const { error } = await supabase.from('ifc_messages').insert({ session_id: job.sessionId, ...job.msg });
    if (error) console.warn('Error saving message to DB:', error);
    return !error;
  }
  const { error } = await supabase.from('ifc_sessions').update(job.updates).eq('id', job.sessionId);
  if (error) console.warn('Error updating session in DB:', error);
  return !error;
}

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdState(id);
    if (id) {
      localStorage.setItem(ACTIVE_SESSION_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    // Send saved-but-unsent chat data again as soon as the connection is back.
    const retry = () => { void flushOutbox(sendJob); };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 60000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoadingMessages(true);

    getScopedSupabase().then((supabase) =>
      supabase
        .from('ifc_messages')
        .select('*')
        .eq('session_id', activeSessionId)
        .order('created_at', { ascending: true })
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.warn('Error loading messages from DB:', error);
            setMessages([]);
          } else {
            setMessages(data || []);
          }
          setLoadingMessages(false);
        }, (err: unknown) => {
          if (cancelled) return;
          console.warn('DB load error (fallback empty messages):', err);
          setMessages([]);
          setLoadingMessages(false);
        })
    );

    return () => { cancelled = true; };
  }, [activeSessionId]);

  async function loadSessions() {
    try {
      const deviceId = getDeviceId();
      const supabase = await getScopedSupabase();

      // Send again anything that failed to save last time, before reading.
      await flushOutbox(sendJob);

      // Chats are private to this browser. They used to be shared with every
      // browser on the same public IP address (an office or campus network),
      // which let other people see each other's chats and models.
      const { data, error } = await supabase
        .from('ifc_sessions')
        .select('*')
        .eq('device_id', deviceId)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Error loading sessions:', error);
        return;
      }
      if (data) {
        // A model link that could not be saved yet still belongs to its chat.
        for (const s of data) Object.assign(s, pendingSessionUpdates(s.id));
        setSessions(data);
        const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (stored && !data.find(s => s.id === stored)) {
          setActiveSessionId(null);
        }
      }
    } catch (e) {
      console.warn('loadSessions DB error:', e);
    }
  }

  async function createSession(title: string = 'New Session'): Promise<ChatSession> {
    try {
      const { ipHash } = await getIdentity();
      const supabase = await getScopedSupabase();
      let created: ChatSession | null = null;
      await retrying(async () => {
        const { data, error } = await supabase
          .from('ifc_sessions')
          .insert({ title, mcp_session_id: '', device_id: getDeviceId(), ip_hash: ipHash })
          .select()
          .single();
        if (!error && data) created = data as ChatSession;
        return !!created;
      });
      if (created) {
        const data = created as ChatSession;
        setSessions(prev => [data, ...prev]);
        setActiveSessionId(data.id);
        setMessages([]);
        return data;
      }
    } catch (err) {
      console.warn('Supabase createSession error, using local session fallback:', err);
    }

    // Fallback local session if Supabase is offline/unreachable
    const localSession: ChatSession = {
      id: 'session_' + Date.now(),
      title,
      mcp_session_id: '',
      last_ifc_url: null,
      created_at: new Date().toISOString()
    };
    setSessions(prev => [localSession, ...prev]);
    setActiveSessionId(localSession.id);
    setMessages([]);
    return localSession;
  }

  async function deleteSession(sessionId: string) {
    try {
      const supabase = await getScopedSupabase();
      const { error } = await supabase
        .from('ifc_sessions')
        .delete()
        .eq('id', sessionId);

      if (error) console.warn('Error deleting session in DB:', error);
    } catch (e) {
      console.warn('deleteSession DB error:', e);
    }
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }

  const saveMessage = useCallback(async (sessionId: string, msg: ChatMessage) => {
    const { role, content, tool_calls, tool_call_id, reasoning_details } = msg;
    const row = {
      role,
      content: content || '',
      tool_calls: tool_calls || null,
      tool_call_id: tool_call_id || null,
      reasoning_details: reasoning_details || null,
    };
    // A local fallback session has no database row to attach messages to.
    if (!isDbSessionId(sessionId)) return;
    const ok = await retrying(() => sendJob({ kind: 'message', sessionId, msg: row }));
    if (!ok) enqueue({ kind: 'message', sessionId, msg: row });
  }, []);

  async function updateSessionData(sessionId: string, mcpSessionId?: string, lastIfcUrl?: string) {
    const updates: Record<string, string> = {};
    if (mcpSessionId) updates.mcp_session_id = mcpSessionId;
    if (lastIfcUrl) updates.last_ifc_url = lastIfcUrl;

    if (Object.keys(updates).length === 0) return;

    setSessions(prev =>
      prev.map(s => (s.id === sessionId ? { ...s, ...updates } : s))
    );

    if (!isDbSessionId(sessionId)) return;
    // The link to a chat's model must never be lost: retry, then keep it in this browser.
    const ok = await retrying(() => sendJob({ kind: 'session', sessionId, updates }));
    if (!ok) enqueue({ kind: 'session', sessionId, updates });
  }

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    setMessages,
    loadingMessages,
    createSession,
    deleteSession,
    saveMessage,
    updateSessionData,
    loadSessions,
  };
}
