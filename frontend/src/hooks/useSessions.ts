import { useState, useEffect, useCallback } from 'react';
import { getScopedSupabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { getIdentity } from '../lib/identity';

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
      const { ipHash } = await getIdentity();
      const deviceId = getDeviceId();
      const supabase = await getScopedSupabase();

      // One-time backfill: sessions created before the ip_hash column
      // existed (or by a visitor whose IP couldn't be resolved at the time)
      // are permanently invisible to another browser's IP-based lookup
      // below, since they only ever match on device_id - confirmed this was
      // actually happening (every session in the DB still had ip_hash:
      // null, including ones created after the column was added, because
      // an EXISTING session is only ever inserted once and never patched
      // afterwards). Tag this device's own null-ip_hash sessions with its
      // current ip_hash on every load so they become findable cross-browser
      // going forward. Fire-and-forget - a failure here just means one more
      // load without the backfill, not a broken session list.
      if (ipHash) {
        supabase.from('ifc_sessions').update({ ip_hash: ipHash }).eq('device_id', deviceId).is('ip_hash', null)
          .then(({ error: backfillError }) => {
            if (backfillError) console.warn('ip_hash backfill failed (non-fatal):', backfillError);
          });
      }

      // IP-based lookup (see lib/identity.ts) finds sessions from ANY
      // browser/device on this IP, not just this one - OR'd with the
      // legacy per-browser device_id filter so sessions created before
      // ip_hash existed (or from a visitor whose IP couldn't be resolved)
      // still show up on the browser that made them. Requires the scoped
      // client (x-ip-hash header) - RLS enforces device_id/ip_hash
      // visibility independent of this query's own filter, so the plain
      // `supabase` client (x-device-id only) would silently return nothing
      // for another browser's sessions even with this exact same query.
      let query = supabase.from('ifc_sessions').select('*');
      query = ipHash
        ? query.or(`ip_hash.eq.${ipHash},device_id.eq.${deviceId}`)
        : query.eq('device_id', deviceId);
      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        console.warn('Error loading sessions:', error);
        return;
      }
      if (data) {
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
      const { data, error } = await supabase
        .from('ifc_sessions')
        .insert({ title, mcp_session_id: '', device_id: getDeviceId(), ip_hash: ipHash })
        .select()
        .single();

      if (!error && data) {
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
    try {
      const { role, content, tool_calls, tool_call_id, reasoning_details } = msg;
      const supabase = await getScopedSupabase();
      const { error } = await supabase.from('ifc_messages').insert({
        session_id: sessionId,
        role,
        content: content || '',
        tool_calls: tool_calls || null,
        tool_call_id: tool_call_id || null,
        reasoning_details: reasoning_details || null,
      });
      if (error) console.warn('Error saving message to DB:', error);
    } catch (e) {
      console.warn('saveMessage DB insert error (non-fatal):', e);
    }
  }, []);

  async function updateSessionData(sessionId: string, mcpSessionId?: string, lastIfcUrl?: string) {
    const updates: Record<string, string> = {};
    if (mcpSessionId) updates.mcp_session_id = mcpSessionId;
    if (lastIfcUrl) updates.last_ifc_url = lastIfcUrl;

    if (Object.keys(updates).length === 0) return;

    setSessions(prev =>
      prev.map(s => (s.id === sessionId ? { ...s, ...updates } : s))
    );

    try {
      const supabase = await getScopedSupabase();
      const { error } = await supabase
        .from('ifc_sessions')
        .update(updates)
        .eq('id', sessionId);

      if (error) console.warn('Error updating session in DB:', error);
    } catch (e) {
      console.warn('updateSessionData DB error (non-fatal):', e);
    }
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
