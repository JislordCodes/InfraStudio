import { useRef } from 'react';
import { IfcViewer, type IfcViewerHandle } from './components/IfcViewer';
import { AIChat } from './components/AIChat';
import { Uploader } from './components/Uploader';
import './index.css';

function App() {
  const viewerRef = useRef<IfcViewerHandle | null>(null);

  const handleFileUpload = (file: File) => {
    viewerRef.current?.loadIfc(file);
  };

  const handleLoadIfcUrl = (url: string) => {
    viewerRef.current?.loadIfcFromUrl(url);
  };

  return (
    <div className="flex flex-col w-full h-[100dvh] overflow-hidden bg-neutral-950">

      {/* Header bar — mobile-ready with safe margins */}
      <header className="flex shrink-0 items-center justify-between px-3 sm:px-6 py-2.5 sm:py-3 bg-neutral-950/95 border-b border-neutral-800/80 z-30 backdrop-blur-md">
        <h1 className="text-base sm:text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <div className="w-4 h-4 sm:w-5 sm:h-5 bg-blue-600 rounded-sm shadow-sm shrink-0" />
          InfraStudio<span className="text-neutral-500 font-light hidden xs:inline text-xs sm:text-base">BIM</span>
        </h1>
        <div className="flex items-center gap-2">
          <Uploader onFileUpload={handleFileUpload} />
        </div>
      </header>

      {/* Full-screen 3D viewer container */}
      <main className="flex-1 relative w-full h-full overflow-hidden">
        <IfcViewer ref={viewerRef} />

        {/* Floating chat — responsive bottom overlay with safe-area spacing */}
        <div className="absolute bottom-2 sm:bottom-6 left-1/2 -translate-x-1/2 w-[95%] sm:w-full max-w-xl z-20 px-0 sm:px-4 pb-safe pointer-events-none">
          <div className="pointer-events-auto">
            <AIChat onLoadIfcUrl={handleLoadIfcUrl} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
