import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, List, Plus, MessageSquare, Loader2, Trash2, X } from 'lucide-react';
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, expanded, currentSteps]);

  // Auto load IFC from session when switching sessions
  useEffect(() => {
    if (activeSessionId) {
      const session = sessions.find(s => s.id === activeSessionId);
      if (session?.last_ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(session.last_ifc_url);
      }
      setExpanded(true);
      inputRef.current?.focus();
    }
  }, [activeSessionId]);

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setShowSidebar(false); // close sidebar on mobile after selection
    setConfirmDelete(null);
  };

  const handleNewSession = async () => {
    try {
      await createSession('New Design ' + new Date().toLocaleDateString());
      setExpanded(true);
      setShowSidebar(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (confirmDelete === sessionId) {
      await deleteSession(sessionId);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(sessionId);
      // Auto-cancel confirm after 3s
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    let targetSessionId = activeSessionId;

    // Auto-create session if none exists
    if (!targetSessionId) {
      try {
        const session = await createSession(input.slice(0, 40) + (input.length > 40 ? '...' : ''));
        targetSessionId = session.id;
      } catch (e) {
        console.error('Failed to create session', e);
        return;
      }
    }

    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    const userInput = input.trim();
    setInput('');
    setIsLoading(true);
    setExpanded(true);
    setCurrentSteps([]);

    // Persist user message silently — never let DB errors block the agent
    saveMessage(targetSessionId, userMsg).catch(console.warn);

    try {
      setCurrentSteps(['🤖 Agent starting...']);

      const sessionObj = sessions.find(s => s.id === targetSessionId);
      const clientSessionId = sessionObj?.mcp_session_id || '';

      // Get all messages as LLM history (filter system/tool internals)
      const historyForLLM = messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
        .map(m => ({ role: m.role, content: m.content }));

      const result = await runQwenAgentLoop(
        userInput,
        historyForLLM,
        clientSessionId,
        (step: string) => {
          setCurrentSteps(prev => [...prev.slice(-15), step]);
        },
        async (assistantMsgObj: any) => {
          const amMsg: ChatMessage = {
            role: 'assistant',
            content: assistantMsgObj.content || '',
            tool_calls: assistantMsgObj.tool_calls,
            tool_call_id: assistantMsgObj.tool_call_id,
          };
          await saveMessage(targetSessionId!, amMsg);
        }
      );

      if (result.steps?.length > 0) setCurrentSteps(result.steps.slice(-10));

      const replyText = result.reply || 'I have completed your request.';
      const finalMsg: ChatMessage = { role: 'assistant', content: replyText };
      setMessages(prev => [...prev, finalMsg]);
      saveMessage(targetSessionId, finalMsg).catch(console.warn);

      if (result.mcp_session_id || result.ifc_url) {
        updateSessionData(targetSessionId, result.mcp_session_id || clientSessionId, result.ifc_url).catch(console.warn);
        if (result.ifc_url && onLoadIfcUrl) {
          onLoadIfcUrl(result.ifc_url);
        }
      }

      setCurrentSteps([]);
    } catch (err) {
      console.error('Agent error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: `⚠️ Agent failed: ${detail.slice(0, 300)}`,
      };
      setMessages(prev => [...prev, errorMsg]);
      saveMessage(targetSessionId, errorMsg).catch(console.warn);
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  const displayableMessages = messages.filter(m => {
    if (m.role === 'user') return true;
    if (m.role === 'assistant') {
      if (m.tool_calls) return false;
      if (typeof m.content === 'string' && m.content.includes('[INFRASTUDIO_RAG_DONE]')) return false;
      return true;
    }
    return false;
  });

  const hasMessages = displayableMessages.length > 0;
  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div className="flex z-10 max-w-2xl w-full relative" style={{ isolation: 'isolate' }}>

      {/* ── Sidebar ── */}
      <div
        className="absolute bottom-0 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10 transition-all duration-300 ease-in-out z-20"
        style={{
          width: showSidebar ? '240px' : '0px',
          height: expanded ? '420px' : '52px',
          opacity: showSidebar ? 1 : 0,
          transform: showSidebar ? 'translateX(-248px)' : 'translateX(0px)',
          background: 'rgba(8, 8, 12, 0.95)',
          backdropFilter: 'blur(20px)',
          pointerEvents: showSidebar ? 'auto' : 'none',
          left: 0,
        }}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10 flex-shrink-0">
          <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Projects</span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNewSession}
              title="New Project"
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowSidebar(false)}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto py-1">
          {sessions.length === 0 ? (
            <div className="text-center text-neutral-600 text-xs mt-6 px-4">
              No sessions yet.<br />Start a conversation!
            </div>
          ) : (
            sessions.map(s => (
              <div
                key={s.id}
                onClick={() => handleSelectSession(s.id)}
                className={`group relative mx-1.5 my-0.5 px-3 py-2.5 rounded-xl cursor-pointer flex items-center gap-2 transition-all ${
                  activeSessionId === s.id
                    ? 'bg-blue-600/30 border border-blue-500/40 text-white'
                    : 'hover:bg-white/5 text-neutral-400 hover:text-white border border-transparent'
                }`}
              >
                <MessageSquare className="w-3 h-3 flex-shrink-0 opacity-60" />
                <span className="text-xs truncate flex-1 leading-snug">{s.title || 'Untitled'}</span>
                
                {/* Delete button */}
                <button
                  onClick={(e) => handleDeleteSession(e, s.id)}
                  title={confirmDelete === s.id ? 'Click again to confirm' : 'Delete session'}
                  className={`flex-shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all ${
                    confirmDelete === s.id
                      ? 'opacity-100 text-red-400 bg-red-400/10'
                      : 'text-neutral-500 hover:text-red-400 hover:bg-red-400/10'
                  }`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Main Chat Box ── */}
      <div
        className="flex-1 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10 transition-all duration-200"
        style={{
          background: 'rgba(10, 10, 15, 0.88)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        {/* Messages area */}
        {expanded && (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Top bar */}
            <div className="flex items-center justify-between px-3 pt-2 pb-1 border-b border-white/5">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSidebar(!showSidebar)}
                  title="Sessions"
                  className={`p-1.5 rounded-lg transition-colors ${showSidebar ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-white hover:bg-white/10'}`}
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                {activeSession && (
                  <span className="text-xs text-neutral-500 truncate max-w-[140px]">{activeSession.title}</span>
                )}
              </div>
              <button
                onClick={() => setExpanded(false)}
                title="Collapse"
                className="p-1.5 text-neutral-500 hover:text-white transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ maxHeight: '300px' }}>
              {loadingMessages ? (
                <div className="flex justify-center items-center h-16">
                  <Loader2 className="w-4 h-4 text-neutral-500 animate-spin" />
                  <span className="text-xs text-neutral-500 ml-2">Loading messages...</span>
                </div>
              ) : (
                displayableMessages.map((msg, idx) => (
                  <div key={msg.id || idx} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                        <Bot className="w-3 h-3 text-white" />
                      </div>
                    )}
                    <div
                      className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white rounded-br-sm'
                          : 'bg-white/10 text-neutral-100 rounded-bl-sm'
                      }`}
                    >
                      {msg.role === 'assistant' ? (
                        <div className="space-y-1">
                          {msg.reasoning_details && (
                            <details className="mb-2 text-xs text-neutral-400 bg-black/20 rounded p-2">
                              <summary className="cursor-pointer font-semibold text-neutral-300">Model Reasoning</summary>
                              <div className="mt-1 whitespace-pre-wrap">{msg.reasoning_details}</div>
                            </details>
                          )}
                          {(msg.content || '').split('\n').map((line, i) => {
                            if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono">{line}</div>;
                            if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono">{line}</div>;
                            if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono">{line}</div>;
                            if (line.trim() === '') return null;
                            return <div key={i}>{line}</div>;
                          })}
                        </div>
                      ) : msg.content}
                    </div>
                  </div>
                ))
              )}

              {/* Loading / step indicator */}
              {isLoading && (
                <div className="flex justify-start items-end gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                  <div className="bg-white/10 rounded-2xl rounded-bl-sm px-3 py-2 flex flex-col gap-1 max-w-[78%]">
                    {currentSteps.length > 0 && currentSteps.slice(-5).map((line, i) => {
                      if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono">{line}</div>;
                      if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono">{line}</div>;
                      if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono">{line}</div>;
                      return <div key={i} className="text-xs text-neutral-300 font-mono">{line}</div>;
                    })}
                    <div className="flex gap-1 items-center pt-1">
                      <Loader2 className="w-3 h-3 text-neutral-400 animate-spin" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* ── Input bar ── */}
        <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5 border-t border-white/5">
          {!expanded && (
            <button
              type="button"
              onClick={() => setShowSidebar(!showSidebar)}
              className={`p-1.5 rounded-lg transition-colors ${showSidebar ? 'text-white bg-white/10' : 'text-neutral-500 hover:text-white'}`}
              title="Sessions"
            >
              <List className="w-4 h-4" />
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => hasMessages && setExpanded(true)}
            placeholder={activeSession ? `Continue "${activeSession.title}"...` : 'Ask me to build something...'}
            className="flex-1 bg-transparent text-sm text-white placeholder-neutral-500 focus:outline-none"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-full text-white transition-colors"
          >
            <Send className="w-3.5 h-3.5 ml-0.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
