import { useState, useEffect } from 'react';
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

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    const { data, error } = await supabase
      .from('ifc_sessions')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error("Error loading sessions:", error);
      return;
    }
    if (data) setSessions(data);
  }

  async function createSession(title: string = "New Session"): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('ifc_sessions')
      .insert({ title, mcp_session_id: '' })
      .select()
      .single();
      
    if (error) {
      console.error("Error creating session:", error);
      throw error;
    }
    if (data) {
      setSessions(prev => [data, ...prev]);
      setActiveSessionId(data.id);
      return data;
    }
    throw new Error("Failed to create session");
  }

  async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const { data, error } = await supabase
      .from('ifc_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
      
    if (error) {
      console.error("Error loading messages:", error);
      return [];
    }
    return data || [];
  }

  async function saveMessage(sessionId: string, msg: ChatMessage) {
    // Exclude 'id' so Supabase auto-generates it
    const { role, content, tool_calls, tool_call_id, reasoning_details } = msg;
    const { error } = await supabase.from('ifc_messages').insert({
      session_id: sessionId,
      role,
      content: content || '',
      tool_calls,
      tool_call_id,
      reasoning_details
    });
    if (error) console.error("Error saving message:", error);
  }

  async function updateSessionData(sessionId: string, mcpSessionId: string, lastIfcUrl?: string) {
    const updates: any = {};
    if (mcpSessionId) updates.mcp_session_id = mcpSessionId;
    if (lastIfcUrl) updates.last_ifc_url = lastIfcUrl;
    
    if (Object.keys(updates).length > 0) {
      const { error } = await supabase
        .from('ifc_sessions')
        .update(updates)
        .eq('id', sessionId);
        
      if (error) console.error("Error updating session:", error);
      else {
          setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, ...updates } : s));
      }
    }
  }

  return { sessions, activeSessionId, setActiveSessionId, createSession, loadMessages, saveMessage, updateSessionData, loadSessions };
}
