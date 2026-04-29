import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, List, Plus, MessageSquare, Loader2 } from 'lucide-react';
import { runQwenAgentLoop } from '../hooks/useAgentLoop';
import { useSessions, type ChatMessage } from '../hooks/useSessions';

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl }) => {
  const { 
    sessions, activeSessionId, setActiveSessionId, 
    createSession, loadMessages, saveMessage, updateSessionData 
  } = useSessions();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load message history when session changes
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId).then(msgs => {
        if (msgs.length === 0) {
          setMessages([{ role: 'assistant', content: "Hello! I'm your BIM Assistant. Ask me to build anything — rooms, houses, offices." }]);
        } else {
          setMessages(msgs);
        }
      });
      const session = sessions.find(s => s.id === activeSessionId);
      if (session?.last_ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(session.last_ifc_url);
      }
    } else {
      setMessages([{ role: 'assistant', content: "Hello! I'm your BIM Assistant. Ask me to build anything — rooms, houses, offices." }]);
    }
  }, [activeSessionId, sessions, onLoadIfcUrl]); // Note: loadMessages is stable from useSessions

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, expanded, currentSteps]);

  const handleNewSession = async () => {
    try {
      if (!expanded) setExpanded(true);
      const session = await createSession("Design Session " + (sessions.length + 1));
      setActiveSessionId(session.id);
      setMessages([{ role: 'assistant', content: "New session started! What shall we build?" }]);
      if (window) window.dispatchEvent(new CustomEvent('clear_viewer'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    let targetSessionId = activeSessionId;
    
    // Auto-create session if none exists on first message
    if (!targetSessionId) {
      try {
        const session = await createSession(input.slice(0, 30) + '...');
        targetSessionId = session.id;
      } catch (e) {
        console.error("Failed to create session", e);
        return;
      }
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: input.trim(),
    };

    let currentMessages = [...messages, userMsg];
    setMessages(currentMessages);
    setInput('');
    setIsLoading(true);
    setExpanded(true);
    setCurrentSteps([]);

    // Save user message
    await saveMessage(targetSessionId, userMsg);

    try {
      setCurrentSteps(['🤖 Agent starting...']);
      
      const sessionObj = sessions.find(s => s.id === targetSessionId);
      const clientSessionId = sessionObj?.mcp_session_id || '';

      const result = await runQwenAgentLoop(
        userMsg.content,
        // Pass strictly formatted previous messages
        currentMessages.filter(m => m.role !== "system").map(m => ({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id
        })),
        clientSessionId,
        (step: string) => {
          setCurrentSteps(prev => [...prev.slice(-15), step]);
        },
        async (assistantMsgObj: any) => {
           // Callback hook to save reasoning details incrementally
           const amMsg: ChatMessage = {
             role: 'assistant',
             content: assistantMsgObj.content || '',
             tool_calls: assistantMsgObj.tool_calls,
             tool_call_id: assistantMsgObj.tool_call_id
           };
           await saveMessage(targetSessionId!, amMsg);
        }
      );

      // Show final steps
      if (result.steps?.length > 0) setCurrentSteps(result.steps.slice(-10));

      const replyText = result.reply || 'I have completed your request.';
      const finalMsg: ChatMessage = { role: 'assistant', content: replyText };
      currentMessages = [...currentMessages, finalMsg];
      setMessages(currentMessages);
      
      await saveMessage(targetSessionId, finalMsg);

      // Update session with potentially new AWS App Runner MCP Session ID
      if (result.mcp_session_id || result.ifc_url) {
        await updateSessionData(targetSessionId, result.mcp_session_id || clientSessionId, result.ifc_url);
        // Load the new IFC model if one was generated
        if (result.ifc_url && onLoadIfcUrl) {
          console.log('Auto-loading Iterated IFC model:', result.ifc_url);
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
      await saveMessage(targetSessionId, errorMsg);
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  const hasMessages = messages.length > 1;

  const displayableMessages = messages.filter(m => {
    if (m.role === 'user') return true;
    if (m.role === 'assistant') {
       if (m.tool_calls) return false;
       if (typeof m.content === 'string' && m.content.includes('[INFRASTUDIO_RAG_DONE]')) return false;
       return true;
    }
    return false;
  });

  return (
    <div className="flex z-10 max-w-2xl w-full h-full relative" style={{ isolation: 'isolate' }}>
      
      {/* Sidebar Panel */}
      <div 
        className={`absolute bottom-0 left-0 bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl transition-all duration-300 flex flex-col overflow-hidden z-20`}
        style={{ 
          width: showSidebar ? '240px' : '0px', 
          height: expanded ? '400px' : '52px',
          opacity: showSidebar ? 1 : 0,
          transform: showSidebar ? 'translateX(-252px)' : 'translateX(0px)',
          backdropFilter: 'blur(16px)',
          pointerEvents: showSidebar ? 'auto' : 'none'
        }}
      >
        <div className="p-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-white text-sm font-semibold">Sessions</h3>
          <button onClick={handleNewSession} title="New Chat" className="p-1 hover:bg-white/10 rounded-md text-white transition">
             <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(s => (
            <button 
              key={s.id}
              onClick={() => { setActiveSessionId(s.id); setExpanded(true); }}
              className={`w-full text-left p-2 rounded-lg text-xs flex items-center gap-2 truncate transition-colors ${activeSessionId === s.id ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'}`}
            >
              <MessageSquare className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{s.title || "Untitled Session"}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className="text-xs text-neutral-500 text-center mt-4">No sessions yet</div>}
        </div>
      </div>

      {/* Main Chat Box */}
      <div
        className="flex-1 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10 transition-all"
        style={{
          background: 'rgba(10, 10, 15, 0.82)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        {expanded && hasMessages && (
          <div className="flex flex-col">
            <div className="flex justify-between px-3 pt-2">
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                title="Toggle Sessions"
                className={`text-neutral-500 hover:text-white transition-colors p-1 rounded-md ${showSidebar ? 'bg-white/10 text-white' : ''}`}
              >
                <List className="w-4 h-4" />
              </button>
              <button
                onClick={() => setExpanded(false)}
                title="Collapse chat"
                className="text-neutral-500 hover:text-white transition-colors p-1"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
            <div className="h-64 overflow-y-auto px-4 pb-1 space-y-2 flex flex-col pt-2">
              {displayableMessages.map((msg, idx) => (
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
                        {msg.content.split('\n').map((line, i) => {
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
              ))}

              {isLoading && (
                <div className="flex justify-start items-end gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                  <div className="bg-white/10 rounded-2xl rounded-bl-sm px-3 py-2 flex flex-col gap-2">
                    {currentSteps.length > 0 && (
                      <div className="space-y-1">
                        {currentSteps.map((line, i) => {
                          if (line.startsWith('✓')) return <div key={`step-${i}`} className="text-emerald-400 text-xs font-mono">{line}</div>;
                          if (line.startsWith('⚠')) return <div key={`step-${i}`} className="text-amber-400 text-xs font-mono">{line}</div>;
                          if (line.startsWith('✗')) return <div key={`step-${i}`} className="text-red-400 text-xs font-mono">{line}</div>;
                          if (line.trim() === '') return null;
                          return <div key={`step-${i}`} className="text-xs text-neutral-300 font-mono">{line}</div>;
                        })}
                      </div>
                    )}
                    <div className="flex gap-1 items-center py-1">
                       <Loader2 className="w-3 h-3 text-neutral-400 animate-spin" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Input bar */}
        <form
          onSubmit={handleSend}
          className="flex items-center gap-2 px-3 py-2.5"
        >
          {!expanded && (
             <button
             type="button"
             onClick={() => setShowSidebar(!showSidebar)}
             className="text-neutral-500 hover:text-white transition-colors p-1"
             title="Sessions"
           >
             <List className="w-4 h-4" />
           </button>
          )}

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => hasMessages && setExpanded(true)}
            placeholder="Ask about the IFC model..."
            className="flex-1 bg-transparent text-sm text-white placeholder-neutral-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-full text-white transition-colors"
          >
            <Send className="w-3.5 h-3.5 ml-0.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
