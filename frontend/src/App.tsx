import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Lock } from 'lucide-react';
import { IfcViewer, type IfcViewerHandle } from './components/IfcViewer';
import { AIChat } from './components/AIChat';
import './index.css';

function App() {
  const viewerRef = useRef<IfcViewerHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The model currently shown in the viewer, tracked here (rather than read
  // back out of the chat's session state) so the download button works
  // regardless of how the model got loaded - a chat build, a local upload, or
  // the ?ifc_url= / codex-bridge paths below, none of which are "a session".
  const [currentIfcUrl, setCurrentIfcUrl] = useState<string | null>(null);
  // Owner/trusted-tester bypass for the public trial gate (see
  // agent-bim/_shared/trial_gate.ts) - the code itself is never in this
  // bundle, only whatever the person typed into the prompt, checked
  // server-side against a secret env var on every build call. Deliberately
  // a plain browser prompt rather than a built modal - this stays a small,
  // easy-to-miss affordance, not a feature to advertise.
  const [hasUnlockCode, setHasUnlockCode] = useState(
    () => !!localStorage.getItem('infrastudio_unlock_code')
  );
  const applyUnlockCode = (trimmed: string) => {
    if (trimmed) {
      localStorage.setItem('infrastudio_unlock_code', trimmed);
      setHasUnlockCode(true);
      // The button itself gives no visual confirmation on purpose - without
      // this, entering the code "does nothing" as far as anyone can see
      // unless they happen to already be gated, which is confusing even for
      // the owner. The code is still only actually checked server-side on
      // the next build.
      window.alert('Access code saved on this browser. It will be used automatically on your next build.');
    } else {
      localStorage.removeItem('infrastudio_unlock_code');
      setHasUnlockCode(false);
      window.alert('Access code cleared from this browser.');
    }
  };
  const handleUnlockClick = () => {
    const entered = window.prompt(hasUnlockCode ? 'Update access code (leave blank to clear):' : 'Access code:');
    if (entered === null) return; // cancelled
    applyUnlockCode(entered.trim());
  };

  const handleFileUpload = (file: File) => {
    viewerRef.current?.loadIfc(file);
    // A local upload has no URL to offer back for download - it's already on
    // the user's machine - so any previous model's download button goes away
    // rather than pointing at the wrong file.
    setCurrentIfcUrl(null);
  };

  const handleLoadIfcUrl = (url: string) => {
    viewerRef.current?.loadIfcFromUrl(url);
    setCurrentIfcUrl(url);
  };

  // Mirrors whatever the active chat session actually has (including "none"),
  // so switching to an empty project correctly hides the download button
  // instead of leaving the previous session's link showing.
  const handleActiveIfcUrlChange = (url: string | null) => {
    setCurrentIfcUrl(url);
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const ifcUrl = url.searchParams.get('ifc_url');
    if (ifcUrl) {
      handleLoadIfcUrl(ifcUrl);
    }
  }, []);

  useEffect(() => {
    // A more reliable path to the same unlock than hunting for the
    // deliberately near-invisible padlock button (see handleUnlockClick) -
    // for the owner's own use, e.g. bookmarking
    // https://www.infrastudio.app/studios?unlock=<code>. Strips the param
    // from the visible URL immediately after so it isn't left sitting in
    // the address bar, browser history, or an accidentally-shared link.
    const url = new URL(window.location.href);
    const unlock = url.searchParams.get('unlock');
    if (unlock) {
      localStorage.setItem('infrastudio_unlock_code', unlock.trim());
      setHasUnlockCode(true);
      url.searchParams.delete('unlock');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  useEffect(() => {
    const lastRevision = { current: '' };
    const isEnabled =
      new URL(window.location.href).searchParams.get('codexBridge') === '1' ||
      localStorage.getItem('infrastudio_codex_bridge') === '1';

    if (!isEnabled) return;

    const poll = async () => {
      try {
        let res = await fetch(`/codex-bridge.local.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) {
          res = await fetch(`/codex-bridge.json?t=${Date.now()}`, { cache: 'no-store' });
        }
        if (!res.ok) return;
        const data = await res.json();
        const revision = String(data.revision || '');
        const ifcUrl = String(data.ifc_url || '');
        if (ifcUrl && revision && revision !== lastRevision.current) {
          lastRevision.current = revision;
          handleLoadIfcUrl(ifcUrl);
        }
      } catch {
        // Optional local test bridge; ignore when the file is unavailable.
      }
    };

    poll();
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden bg-neutral-950">
      {/* No chrome bar - the scene fills the entire viewport, everything else floats on top. */}
      <IfcViewer ref={viewerRef} />

      <input
        ref={fileInputRef}
        type="file"
        accept=".ifc"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            if (file.name.toLowerCase().endsWith('.ifc')) {
              handleFileUpload(file);
            } else {
              alert('Please select a valid .ifc file');
            }
          }
          e.target.value = '';
        }}
      />

      {/* Brand mark + local upload - bottom-left, out of the way of the FPS/engine
          overlays IfcViewer already renders in the top corners. */}
      <div className="absolute bottom-3 left-3 sm:bottom-4 sm:left-4 z-20 flex items-center gap-1.5 pointer-events-auto">
        <div
          className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-full border border-white/10 shadow-lg backdrop-blur-xl bg-neutral-900/80"
          title="InfraStudio"
        >
          <div className="w-4 h-4 bg-blue-600 rounded-sm shadow-sm shrink-0" />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-full text-neutral-300 hover:text-white hover:bg-blue-600 active:scale-90 transition-all"
            title="Load a local IFC file"
          >
            <Upload size={15} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Owner/trusted-tester unlock - deliberately bare (no pill, no border,
          no shadow) and flush with the very bottom edge, away from every
          other control, so it reads as empty space rather than a button. */}
      <button
        onClick={handleUnlockClick}
        className={`absolute bottom-0 right-1.5 z-20 p-2 pointer-events-auto active:scale-90 transition-all ${
          hasUnlockCode ? 'text-blue-500/50 hover:text-blue-400' : 'text-neutral-900 hover:text-neutral-700'
        }`}
        title=" "
      >
        <Lock size={11} strokeWidth={2.5} />
      </button>

      {/* Download - the one CTA that should never be easy to miss once a model exists. */}
      {currentIfcUrl && (
        <a
          href={currentIfcUrl}
          download="model.ifc"
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-3 right-3 sm:top-4 sm:right-4 z-20 flex items-center gap-1.5 sm:gap-2 pl-3 pr-3.5 sm:pl-4 sm:pr-5 py-2 sm:py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-xs sm:text-sm font-semibold shadow-lg shadow-blue-600/30 border border-blue-400/30 transition-all pointer-events-auto"
          title="Download the generated IFC model"
        >
          <Download size={16} strokeWidth={2.5} />
          <span>Download IFC</span>
        </a>
      )}

      {/* Floating chat - collapses to a single button, see AIChat's own `expanded` state. */}
      <div className="absolute bottom-2 sm:bottom-6 left-1/2 -translate-x-1/2 w-[95%] sm:w-full max-w-xl z-20 px-0 sm:px-4 pb-safe pointer-events-none flex justify-center">
        <div className="pointer-events-auto">
          <AIChat onLoadIfcUrl={handleLoadIfcUrl} onActiveIfcUrlChange={handleActiveIfcUrlChange} />
        </div>
      </div>
    </div>
  );
}

export default App;
