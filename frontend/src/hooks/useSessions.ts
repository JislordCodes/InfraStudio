import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

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
}

const ACTIVE_SESSION_KEY = 'infrastudio_active_session';

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => {
    // Restore from localStorage on mount
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Persist activeSessionId to localStorage
  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdState(id);
    if (id) {
      localStorage.setItem(ACTIVE_SESSION_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }, []);

  // Load session list on mount
  useEffect(() => {
    loadSessions();
  }, []);

  // Load messages whenever active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoadingMessages(true);

    supabase
      .from('ifc_messages')
      .select('*')
      .eq('session_id', activeSessionId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Error loading messages:', error);
          setMessages([]);
        } else {
          setMessages(data || []);
        }
        setLoadingMessages(false);
      });

    return () => { cancelled = true; };
  }, [activeSessionId]);

  async function loadSessions() {
    const { data, error } = await supabase
      .from('ifc_sessions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading sessions:', error);
      return;
    }
    if (data) {
      setSessions(data);
      // If we have an activeSessionId from localStorage, verify it still exists
      const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
      if (stored && !data.find(s => s.id === stored)) {
        // Session was deleted, clear it
        setActiveSessionId(null);
      }
    }
  }

  async function createSession(title: string = 'New Session'): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('ifc_sessions')
      .insert({ title, mcp_session_id: '' })
      .select()
      .single();

    if (error) {
      console.error('Error creating session:', error);
      throw error;
    }
    setSessions(prev => [data, ...prev]);
    setActiveSessionId(data.id);
    setMessages([]);
    return data;
  }

  async function deleteSession(sessionId: string) {
    // Messages cascade-delete automatically via FK
    const { error } = await supabase
      .from('ifc_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Error deleting session:', error);
      return;
    }
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }

  // Persist a message to DB. Awaitable so caller can guarantee it saved before refresh.
  const saveMessage = useCallback(async (sessionId: string, msg: ChatMessage) => {
    const { role, content, tool_calls, tool_call_id, reasoning_details } = msg;
    const { error } = await supabase.from('ifc_messages').insert({
      session_id: sessionId,
      role,
      content: content || '',
      tool_calls: tool_calls || null,
      tool_call_id: tool_call_id || null,
      reasoning_details: reasoning_details || null,
    });
    if (error) console.warn('Error saving message:', error);
  }, []);

  async function updateSessionData(sessionId: string, mcpSessionId?: string, lastIfcUrl?: string) {
    const updates: Record<string, string> = {};
    if (mcpSessionId) updates.mcp_session_id = mcpSessionId;
    if (lastIfcUrl) updates.last_ifc_url = lastIfcUrl;

    if (Object.keys(updates).length === 0) return;

    const { error } = await supabase
      .from('ifc_sessions')
      .update(updates)
      .eq('id', sessionId);

    if (error) {
      console.error('Error updating session:', error);
    } else {
      setSessions(prev =>
        prev.map(s => (s.id === sessionId ? { ...s, ...updates } : s))
      );
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
