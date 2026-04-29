import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, PanelLeftOpen, PanelLeftClose, Plus, MessageSquare, Loader2, Trash2, X } from 'lucide-react';
import { runQwenAgentLoop } from '../hooks/useAgentLoop';
import { useSessions, type ChatMessage } from '../hooks/useSessions';

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl }) => {
  const {
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
  } = useSessions();

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (expanded) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, expanded, currentSteps]);

  // When active session changes — load IFC into viewer & expand chat
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (session?.last_ifc_url && onLoadIfcUrl) {
      onLoadIfcUrl(session.last_ifc_url);
    }
    if (messages.length > 0 || loadingMessages) {
      setExpanded(true);
    }
  }, [activeSessionId, sessions.length, loadingMessages]);

  // Also expand when messages finish loading
  useEffect(() => {
    if (!loadingMessages && messages.length > 0 && activeSessionId) {
      setExpanded(true);
    }
  }, [loadingMessages, messages.length, activeSessionId]);

  // ── Session Actions ──

  const handleSelectSession = (id: string) => {
    if (id === activeSessionId) return;
    setActiveSessionId(id);
    setConfirmDeleteId(null);
  };

  const handleNewSession = async () => {
    try {
      await createSession('Design ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
      setExpanded(true);
      setShowSidebar(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirmDeleteId === id) {
      deleteSession(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
    }
  };

  // ── Send ──

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    let sid = activeSessionId;

    // Auto-create session on first message
    if (!sid) {
      try {
        const s = await createSession(input.trim().slice(0, 40) || 'New Design');
        sid = s.id;
      } catch {
        return;
      }
    }

    const userContent = input.trim();
    const userMsg: ChatMessage = { role: 'user', content: userContent };

    // Optimistic UI update
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    setExpanded(true);
    setCurrentSteps([]);

    // Save user message — await so it's persisted before any refresh
    await saveMessage(sid, userMsg);

    try {
      setCurrentSteps(['🤖 Agent starting...']);

      const sessionObj = sessions.find(s => s.id === sid);
      const clientMcpId = sessionObj?.mcp_session_id || '';

      // Build history for LLM context
      const history = messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
        .map(m => ({ role: m.role, content: m.content }));

      const result = await runQwenAgentLoop(
        userContent,
        history,
        clientMcpId,
        (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
        async (assistantObj: any) => {
          // Save intermediate assistant messages (tool-call thoughts) silently
          await saveMessage(sid!, {
            role: 'assistant',
            content: assistantObj.content || '',
            tool_calls: assistantObj.tool_calls,
          });
        }
      );

      if (result.steps?.length) setCurrentSteps(result.steps.slice(-8));

      // Save & show final reply
      const reply: ChatMessage = { role: 'assistant', content: result.reply || 'Done.' };
      setMessages(prev => [...prev, reply]);
      await saveMessage(sid, reply);

      // Update session metadata
      if (result.mcp_session_id || result.ifc_url) {
        await updateSessionData(sid, result.mcp_session_id || clientMcpId, result.ifc_url);
      }

      // Load IFC into viewer
      if (result.ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(result.ifc_url);
      }

      setCurrentSteps([]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const errMsg: ChatMessage = { role: 'assistant', content: `⚠️ Agent failed: ${detail.slice(0, 300)}` };
      setMessages(prev => [...prev, errMsg]);
      await saveMessage(sid, errMsg);
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Display filtering ──

  const displayMsgs = messages.filter(m => {
    if (m.role === 'user') return true;
    if (m.role === 'assistant') {
      if (m.tool_calls) return false;
      if (!m.content || m.content.trim() === '') return false;
      return true;
    }
    return false;
  });

  const hasContent = displayMsgs.length > 0;
  const activeSession = sessions.find(s => s.id === activeSessionId);

  // ── Render ──

  return (
    <div className="flex z-10 max-w-2xl w-full relative" style={{ isolation: 'isolate' }}>

      {/* ═══ Sidebar ═══ */}
      <div
        className="absolute bottom-0 left-0 flex flex-col rounded-2xl overflow-hidden border border-white/10 z-20"
        style={{
          width: showSidebar ? '220px' : '0px',
          maxHeight: '420px',
          opacity: showSidebar ? 1 : 0,
          transform: showSidebar ? 'translateX(-228px)' : 'translateX(0)',
          transition: 'transform 0.25s ease, opacity 0.2s ease, width 0.25s ease',
          background: 'rgba(12, 12, 18, 0.96)',
          backdropFilter: 'blur(24px)',
          pointerEvents: showSidebar ? 'auto' : 'none',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-white/8">
          <span className="text-[11px] font-bold text-neutral-400 uppercase tracking-widest">Projects</span>
          <button onClick={handleNewSession} title="New" className="w-6 h-6 flex items-center justify-center rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors">
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-1.5 px-1.5 space-y-0.5" style={{ maxHeight: '360px' }}>
          {sessions.length === 0 ? (
            <p className="text-center text-neutral-600 text-[11px] mt-8 px-2 leading-relaxed">
              No projects yet.<br/>Send a message to start.
            </p>
          ) : (
            sessions.map(s => {
              const isActive = s.id === activeSessionId;
              const isConfirming = confirmDeleteId === s.id;
              return (
                <div
                  key={s.id}
                  onClick={() => handleSelectSession(s.id)}
                  className={`group relative flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
                    isActive
                      ? 'bg-blue-600/20 text-white'
                      : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                  }`}
                >
                  <MessageSquare className="w-3 h-3 flex-shrink-0 opacity-50" />
                  <span className="text-[11px] truncate flex-1 font-medium">{s.title || 'Untitled'}</span>
                  {isActive && s.last_ifc_url && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Has IFC model" />
                  )}
                  <button
                    onClick={(e) => handleDeleteClick(e, s.id)}
                    title={isConfirming ? 'Click again to delete' : 'Delete'}
                    className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded transition-all ${
                      isConfirming
                        ? 'bg-red-500/20 text-red-400 opacity-100'
                        : 'opacity-0 group-hover:opacity-70 text-neutral-500 hover:text-red-400'
                    }`}
                  >
                    {isConfirming ? <X className="w-3 h-3" /> : <Trash2 className="w-2.5 h-2.5" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ═══ Main Chat ═══ */}
      <div
        className="flex-1 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10"
        style={{
          background: 'rgba(10, 10, 15, 0.88)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        {/* Messages area */}
        {expanded && (
          <div className="flex flex-col min-h-0">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setShowSidebar(v => !v)}
                  className={`p-1 rounded-md transition-colors ${showSidebar ? 'text-white bg-white/10' : 'text-neutral-500 hover:text-white'}`}
                  title="Toggle sidebar"
                >
                  {showSidebar ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                </button>
                {activeSession && (
                  <span className="text-[11px] text-neutral-500 truncate max-w-[160px] font-medium">
                    {activeSession.title}
                  </span>
                )}
              </div>
              <button onClick={() => setExpanded(false)} className="p-1 text-neutral-500 hover:text-white transition-colors">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>

            {/* Messages */}
            <div className="overflow-y-auto px-3 py-2 space-y-2" style={{ maxHeight: '300px' }}>
              {loadingMessages ? (
                <div className="flex items-center justify-center gap-2 h-20">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-xs text-neutral-500">Loading conversation...</span>
                </div>
              ) : !hasContent && !isLoading ? (
                <div className="flex items-center justify-center h-16">
                  <span className="text-xs text-neutral-600">Send a message to start building.</span>
                </div>
              ) : (
                displayMsgs.map((msg, idx) => (
                  <div key={msg.id || `msg-${idx}`} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                        <Bot className="w-3 h-3 text-white" />
                      </div>
                    )}
                    <div className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white/10 text-neutral-100 rounded-bl-sm'
                    }`}>
                      {msg.role === 'assistant' ? (
                        <div className="space-y-0.5">
                          {(msg.content || '').split('\n').map((line, i) => {
                            if (!line.trim()) return null;
                            if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono">{line}</div>;
                            if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono">{line}</div>;
                            if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono">{line}</div>;
                            return <div key={i}>{line}</div>;
                          })}
                        </div>
                      ) : msg.content}
                    </div>
                  </div>
                ))
              )}

              {isLoading && (
                <div className="flex justify-start items-end gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                  <div className="bg-white/10 rounded-2xl rounded-bl-sm px-3 py-2 flex flex-col gap-1 max-w-[78%]">
                    {currentSteps.slice(-4).map((line, i) => (
                      <div key={i} className="text-xs text-neutral-300 font-mono">{line}</div>
                    ))}
                    <Loader2 className="w-3 h-3 text-neutral-400 animate-spin mt-1" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* ── Input ── */}
        <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5 border-t border-white/5">
          {!expanded && (
            <button type="button" onClick={() => setShowSidebar(v => !v)} className="p-1 text-neutral-500 hover:text-white transition-colors">
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => (hasContent || loadingMessages) && setExpanded(true)}
            placeholder={activeSession ? `Continue "${activeSession.title}"...` : 'Describe what to build...'}
            className="flex-1 bg-transparent text-sm text-white placeholder-neutral-500 focus:outline-none"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:opacity-30 rounded-full text-white transition-colors"
          >
            <Send className="w-3.5 h-3.5 ml-0.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
