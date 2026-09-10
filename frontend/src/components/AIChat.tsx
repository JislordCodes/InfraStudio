import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, PanelLeftOpen, PanelLeftClose, Plus, MessageSquare, Loader2, Trash2, X, Download } from 'lucide-react';
import { runMultiAgentLoop } from '../hooks/useMultiAgentLoop';
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
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('infrastudio_preferred_model')) || 'qwen-max';
  });

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    try {
      localStorage.setItem('infrastudio_preferred_model', model);
    } catch {}
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Responsive window resize listener
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 640);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  // Expand when messages finish loading
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
    if (isMobile) setShowSidebar(false);
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

    const userContent = input.trim();
    const userMsg: ChatMessage = { role: 'user', content: userContent };

    setIsLoading(true);
    setExpanded(true);
    setInput('');
    setCurrentSteps(['🚀 Initializing session...']);

    let sid = activeSessionId;

    try {
      if (!sid) {
        try {
          const s = await createSession(userContent.slice(0, 40) || 'New Design');
          sid = s.id;
        } catch {
          sid = 'session_' + Date.now();
          setActiveSessionId(sid);
        }
      }

      setMessages(prev => [...prev, userMsg]);
      saveMessage(sid, userMsg).catch(err => console.warn('saveMessage non-fatal:', err));

      setCurrentSteps(['🤖 Agent starting...']);

      const sessionObj = sessions.find(s => s.id === sid);
      const clientMcpId = sessionObj?.mcp_session_id || localStorage.getItem(`infrastudio_mcp_${sid}`) || '';

      const history: any[] = [];
      for (const m of messages) {
        if (m.role === 'user') {
          history.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          if (m.tool_calls) {
            history.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
          } else if (m.content && m.content.trim()) {
            history.push({ role: 'assistant', content: m.content });
          }
        } else if (m.role === 'tool' && m.tool_call_id) {
          history.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
        }
      }

      const result = await runMultiAgentLoop(
        userContent,
        history,
        clientMcpId,
        (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
        async (assistantObj: any) => {
          await saveMessage(sid!, {
            role: 'assistant',
            content: assistantObj.content || '',
            tool_calls: assistantObj.tool_calls,
          });
        },
        async (toolMsg: any) => {
          await saveMessage(sid!, {
            role: 'tool',
            content: toolMsg.content || '',
            tool_call_id: toolMsg.tool_call_id,
          });
        },
        selectedModel
      );

      if (result.steps?.length) setCurrentSteps(result.steps.slice(-8));

      const reply: ChatMessage = { role: 'assistant', content: result.reply || 'Done.' };
      setMessages(prev => [...prev, reply]);
      await saveMessage(sid, reply);

      const activeMcpId = result.mcp_session_id || clientMcpId;
      if (activeMcpId) {
        localStorage.setItem(`infrastudio_mcp_${sid}`, activeMcpId);
      }
      if (activeMcpId || result.ifc_url) {
        await updateSessionData(sid, activeMcpId, result.ifc_url);
      }

      if (result.ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(result.ifc_url);
      }

      setCurrentSteps([]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const errMsg: ChatMessage = { role: 'assistant', content: `⚠️ Agent failed: ${detail.slice(0, 300)}` };
      setMessages(prev => [...prev, errMsg]);
      if (sid) {
        await saveMessage(sid, errMsg);
      }
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

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

      {/* ═══ Projects Sidebar (Desktop: floating side panel; Mobile: clean overlay drawer) ═══ */}
      <div
        className={`flex flex-col rounded-2xl overflow-hidden border border-white/10 z-30 transition-all duration-200 ${
          isMobile
            ? `fixed inset-x-3 bottom-16 top-16 bg-neutral-950/98 backdrop-blur-2xl ${showSidebar ? 'opacity-100 pointer-events-auto scale-100' : 'opacity-0 pointer-events-none scale-95'}`
            : `absolute bottom-0 left-0 ${showSidebar ? 'w-[220px] opacity-100 pointer-events-auto -translate-x-[228px]' : 'w-0 opacity-0 pointer-events-none translate-x-0'}`
        }`}
        style={{
          maxHeight: isMobile ? 'calc(100dvh - 120px)' : '420px',
          background: 'rgba(12, 12, 18, 0.98)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
        }}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between px-3.5 py-3 border-b border-white/10 shrink-0">
          <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">Projects</span>
          <div className="flex items-center gap-2">
            <button onClick={handleNewSession} title="New Project" className="px-2.5 py-1 flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-xs font-medium transition-all">
              <Plus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
            {isMobile && (
              <button onClick={() => setShowSidebar(false)} className="p-1 rounded-lg text-neutral-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Sidebar Project List */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-center text-neutral-500 text-xs mt-8 px-2 leading-relaxed">
              No projects yet.<br/>Send a message to start building.
            </p>
          ) : (
            sessions.map(s => {
              const isActive = s.id === activeSessionId;
              const isConfirming = confirmDeleteId === s.id;
              return (
                <div
                  key={s.id}
                  onClick={() => handleSelectSession(s.id)}
                  className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
                    isActive
                      ? 'bg-blue-600/25 text-white font-semibold border border-blue-500/30'
                      : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-60" />
                  <span className="text-xs truncate flex-1">{s.title || 'Untitled Project'}</span>
                  {isActive && s.last_ifc_url && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_8px_rgba(52,211,153,0.8)]" title="Has IFC 3D Model" />
                  )}
                  <button
                    onClick={(e) => handleDeleteClick(e, s.id)}
                    title={isConfirming ? 'Confirm delete' : 'Delete'}
                    className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-all ${
                      isConfirming
                        ? 'bg-red-500/30 text-red-300 opacity-100'
                        : 'opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400'
                    }`}
                  >
                    {isConfirming ? <X className="w-3.5 h-3.5" /> : <Trash2 className="w-3 h-3" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ═══ Main Chat Container ═══ */}
      <div
        className="flex-1 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10 w-full"
        style={{
          background: 'rgba(10, 10, 15, 0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        {/* Expanded Chat Messages Panel */}
        {expanded && (
          <div className="flex flex-col min-h-0">
            {/* Header Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => setShowSidebar(v => !v)}
                  className={`p-1.5 rounded-lg transition-colors shrink-0 ${showSidebar ? 'text-white bg-white/15' : 'text-neutral-400 hover:text-white'}`}
                  title="Toggle Projects"
                >
                  {showSidebar ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                </button>
                {activeSession && (
                  <span className="text-xs text-neutral-400 truncate font-medium max-w-[130px] sm:max-w-[200px]">
                    {activeSession.title}
                  </span>
                )}
                {activeSession?.last_ifc_url && (
                  <a
                    href={activeSession.last_ifc_url}
                    download={`model-${activeSession.title.toLowerCase().replace(/\s+/g, '-')}.ifc`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600/35 hover:bg-blue-600/60 text-blue-200 text-[10px] sm:text-xs font-bold transition-all border border-blue-400/30 shrink-0"
                    title="Download 3D IFC Model"
                  >
                    <Download className="w-3 h-3" />
                    <span className="hidden xs:inline">Download IFC</span>
                    <span className="xs:hidden">IFC</span>
                  </a>
                )}
                <select
                  value={selectedModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="bg-white/10 hover:bg-white/15 text-neutral-200 text-[10px] sm:text-xs font-medium px-2 py-1 rounded-lg border border-white/10 outline-none cursor-pointer transition-colors shrink-0"
                  title="Select AI Engine"
                >
                  <option value="qwen-max" className="bg-neutral-900 text-white">⚡ Qwen Max (Fast)</option>
                  <option value="kimi-k3" className="bg-neutral-900 text-white">🧠 Kimi K3 (Reasoning)</option>
                  <option value="gpt-6-astra" className="bg-neutral-900 text-white">✨ GPT-6 Astra</option>
                </select>
              </div>
              <button onClick={() => setExpanded(false)} className="p-1 text-neutral-400 hover:text-white transition-colors shrink-0">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>

            {/* Messages Scroll Area */}
            <div className="overflow-y-auto px-3 py-2.5 space-y-2.5 max-h-[35vh] sm:max-h-[280px] select-text">
              {loadingMessages ? (
                <div className="flex items-center justify-center gap-2 h-20">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-xs text-neutral-400">Loading conversation...</span>
                </div>
              ) : !hasContent && !isLoading ? (
                <div className="flex items-center justify-center h-16">
                  <span className="text-xs text-neutral-500">Send a message to generate your 3D BIM model.</span>
                </div>
              ) : (
                displayMsgs.map((msg, idx) => (
                  <div key={msg.id || `msg-${idx}`} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mb-0.5 shadow-sm">
                        <Bot className="w-3 h-3 text-white" />
                      </div>
                    )}
                    <div className={`max-w-[85%] sm:max-w-[78%] rounded-2xl px-3.5 py-2 text-xs sm:text-sm leading-relaxed select-text cursor-text ${
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-xs' : 'bg-white/10 text-neutral-100 rounded-bl-xs border border-white/5'
                    }`}>
                      {msg.role === 'assistant' ? (
                        <div className="space-y-1 select-text cursor-text">
                          {(msg.content || '').split('\n').map((line, i) => {
                            if (!line.trim()) return null;
                            if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono select-text">{line}</div>;
                            if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono select-text">{line}</div>;
                            if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono select-text">{line}</div>;
                            return <div key={i} className="select-text">{line}</div>;
                          })}
                        </div>
                      ) : (
                        <span className="select-text cursor-text">{msg.content}</span>
                      )}
                    </div>
                  </div>
                ))
              )}

              {isLoading && (
                <div className="flex justify-start items-end gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mb-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                  <div className="bg-white/10 rounded-2xl rounded-bl-xs px-3.5 py-2.5 flex flex-col gap-1.5 max-w-[85%] sm:max-w-[78%] border border-white/5 select-text cursor-text">
                    {currentSteps.slice(-4).map((line, i) => (
                      <div key={i} className="text-xs text-neutral-200 font-mono leading-tight select-text">{line}</div>
                    ))}
                    <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin mt-1" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Chat Input Bar (16px text-base on mobile prevents iOS auto-zoom) */}
        <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5 border-t border-white/5">
          {!expanded && (
            <button type="button" onClick={() => setShowSidebar(v => !v)} className="p-1 text-neutral-400 hover:text-white transition-colors shrink-0">
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => (hasContent || loadingMessages) && setExpanded(true)}
            placeholder={activeSession ? `Continue "${activeSession.title}"...` : 'Describe structure to build...'}
            className="flex-1 bg-transparent text-base sm:text-sm text-white placeholder-neutral-500 focus:outline-none py-1"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:opacity-30 rounded-full text-white transition-all shadow-md"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
