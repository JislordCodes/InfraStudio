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
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-neutral-900">

      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between px-6 py-3 bg-neutral-950 border-b border-neutral-800 z-30">
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <div className="w-5 h-5 bg-blue-600 rounded-sm" />
          BIM<span className="text-neutral-500 font-light">Viewer</span>
        </h1>
        <button onClick={() => handleLoadIfcUrl('/test.ifc')} className="bg-red-500 text-white px-4 py-2 font-bold z-50 rounded">TEST LOAD</button>
        <Uploader onFileUpload={handleFileUpload} />
      </div>

      {/* Full-screen 3D viewer with floating chat overlay */}
      <div className="flex-1 relative overflow-hidden">
        <IfcViewer ref={viewerRef} />

        {/* Floating chat — bottom-center, small message-box style */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-xl z-20 px-4">
          <AIChat onLoadIfcUrl={handleLoadIfcUrl} />
        </div>
      </div>
    </div>
  );
}

export default App;
