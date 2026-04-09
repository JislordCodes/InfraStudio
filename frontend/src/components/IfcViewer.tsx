import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import Stats from 'stats.js';
import { ZoomIn, ZoomOut, Maximize, RotateCcw, Box } from 'lucide-react';

export interface IfcViewerHandle {
  loadIfc: (file: File) => Promise<void>;
  loadIfcFromUrl: (url: string) => Promise<void>;
}

export const IfcViewer = forwardRef<IfcViewerHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const ifcLoaderRef = useRef<OBC.IfcLoader | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const modelBboxRef = useRef<THREE.Box3 | null>(null);
  const cameraRef = useRef<OBC.OrthoPerspectiveCamera | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (!containerRef.current) return;
    const container = containerRef.current;

    // ── 1. Core setup ─────────────────────────────────────────────────────────
    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);

    const world = worlds.create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBC.SimpleRenderer
    >();

    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = null;

    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    cameraRef.current = world.camera;

    // ── 2. Init engine BEFORE accessing any component APIs ──────────────────
    components.init();

    // Set camera after init (controls are now ready)
    world.camera.controls.setLookAt(78, 20, -2.2, 26, -4, 25);

    // Don't dolly toward cursor — keeps zoom constant while orbiting
    world.camera.controls.dollyToCursor = false;

    // ── 3. Grid ──────────────────────────────────────────────────────────────
    components.get(OBC.Grids).create(world);

    // ── 4. Stats panel ───────────────────────────────────────────────────────
    const stats = new Stats();
    stats.showPanel(0);
    stats.dom.style.position = 'absolute';
    stats.dom.style.top = '16px';
    stats.dom.style.left = '16px';
    container.appendChild(stats.dom);

    world.renderer.onBeforeUpdate.add(() => stats.begin());
    world.renderer.onAfterUpdate.add(() => stats.end());

    // ── 5. Resize observer ───────────────────────────────────────────────────
    const resizeObserver = new ResizeObserver(() => {
      if (world.renderer) world.renderer.resize();
      if (world.camera) world.camera.updateAspect();
    });
    resizeObserver.observe(container);

    // ── 6. FragmentsManager + IfcLoader — async init ─────────────────────────
    const fragments = components.get(OBC.FragmentsManager);
    const ifcLoader = components.get(OBC.IfcLoader);
    ifcLoaderRef.current = ifcLoader;

    const initAsync = async () => {
      // Point directly to the Fragments Web Worker script placed into our Vite public/ folder
      fragments.init('/fragments-worker.mjs');

      // Camera update loop
      world.camera.controls.addEventListener('update', () => {
        if (isMounted) fragments.core.update();
      });

      // When a model is loaded → add it to the scene + center the camera orbit on it
      fragments.list.onItemSet.add(({ value: model }) => {
        console.log('FragmentsModel received in onItemSet, adding to scene...');
        model.useCamera(world.camera!.three);
        world.scene!.three.add(model.object);
        fragments.core.update(true);
        console.log('FragmentsModel added to scene and updated core.');

        // --- Center camera on loaded model ---
        const bbox = new THREE.Box3();
        bbox.setFromObject(model.object, true);
        console.log('Model Bounding Box (computed):', bbox.isEmpty() ? 'EMPTY' : JSON.stringify(bbox));

        if (!bbox.isEmpty()) {
          const center = new THREE.Vector3();
          bbox.getCenter(center);
          
          modelBboxRef.current = bbox;

          if (isMounted && world.camera) {
            world.camera.controls.setTarget(center.x, center.y, center.z, false);
            world.camera.controls.fitToBox(bbox, true, {
              paddingTop: 0.1, paddingBottom: 0.1, paddingLeft: 0.1, paddingRight: 0.1,
            });
          }
        } else {
          console.warn('Manual bbox still empty — using scene fallback camera position');
          if (isMounted && world.camera) {
            world.camera.controls.setLookAt(30, 30, 30, 0, 0, 0, true);
          }
        }
      });

      // Remove z-fighting on new materials
      fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
        if (!isMounted) return;
        if (!('isLodMaterial' in material && material.isLodMaterial)) {
          material.polygonOffset = true;
          material.polygonOffsetUnits = 1;
          material.polygonOffsetFactor = Math.random();
        }
      });

      if (!isMounted) return;

      console.log('Setting up web-ifc WASM defaults...');
      await ifcLoader.setup();
      console.log('Finished setting up ifcLoader WASM');

      if (isMounted) setIsLoaded(true);
    };

    initPromiseRef.current = initAsync().catch((e) => {
      if (!isMounted) return; // Ignore errors caused naturally by dismounting
      console.error('IFC Viewer init failed:', e);
      setInitError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      isMounted = false;
      resizeObserver.disconnect();
      components.dispose();
      stats.dom.remove();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    loadIfc: async (file: File) => {
      if (!ifcLoaderRef.current) return;
      setIsLoadingFile(true);
      try {
        if (initPromiseRef.current) await initPromiseRef.current;
        
        // Anti-crash failsafe: If fragments lost initialization, forcibly re-initialize
        const fragments = ifcLoaderRef.current.components.get(OBC.FragmentsManager);
        if (!fragments.initialized) {
          console.warn('Fragments were uninitialized before load. Forcing FragmentsManager init.');
          fragments.init('/fragments-worker.mjs');
        }

        const data = new Uint8Array(await file.arrayBuffer());
        console.log('Starting IFC load, file size:', data.byteLength, 'bytes');
        const model = await ifcLoaderRef.current.load(data, true, file.name);
        console.log('IFC load() resolved successfully', !!model);
      } catch (error) {
        console.error('Error loading IFC file:', error);
        alert(`Failed to load IFC file. Error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsLoadingFile(false);
      }
    },

    loadIfcFromUrl: async (url: string) => {
      if (!ifcLoaderRef.current) return;
      setIsLoadingFile(true);
      try {
        if (initPromiseRef.current) await initPromiseRef.current;

        // Anti-crash failsafe: If fragments lost initialization, forcibly re-initialize
        const fragments = ifcLoaderRef.current.components.get(OBC.FragmentsManager);
        if (!fragments.initialized) {
          console.warn('Fragments were uninitialized before loadFromUrl. Forcing FragmentsManager init.');
          fragments.init('/fragments-worker.mjs');
        }

        console.log(`Fetching IFC from URL: ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

        const data = new Uint8Array(await response.arrayBuffer());
        console.log(`Fetched ${data.byteLength} bytes, loading into viewer...`);

        const modelId = `supabase-model-${Date.now()}`;
        const model = await ifcLoaderRef.current.load(data, true, modelId);
        console.log('IFC model loaded from URL successfully', !!model);
      } catch (error) {
        console.error('Error loading IFC from URL:', error);
        alert(`Failed to load IFC URL. Error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsLoadingFile(false);
      }
    },
  }));

  return (
    <div className="relative w-full h-full bg-neutral-900 overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full"
      />

      {/* Loading overlay */}
      {isLoadingFile && (
        <div className="absolute inset-0 z-20 flex flex-col justify-center items-center bg-black/50 backdrop-blur-sm">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="mt-4 text-white font-medium drop-shadow-md">Converting IFC to Fragments...</p>
        </div>
      )}

      {/* Engine status badge */}
      <div className="absolute top-4 right-4 z-10 text-white font-mono text-xs pointer-events-none bg-black/50 px-2 py-1 rounded">
        <div className={isLoaded ? 'opacity-50' : 'text-yellow-400'}>
          {isLoaded ? 'Engine Ready' : 'Initializing Engine...'}
        </div>
        {initError && (
          <div className="text-red-400 mt-1 max-w-xs break-words">
            Error: {initError}
          </div>
        )}
      </div>

      {/* Action Toolbar - Vertical, right side */}
      <div className="absolute top-1/2 right-3 -translate-y-1/2 z-50 flex flex-col items-center gap-1.5 px-1.5 py-2.5 bg-neutral-900/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-[0_8px_30px_rgba(0,0,0,0.5)] pointer-events-auto">
        <button 
          onClick={() => cameraRef.current?.controls.dolly(5, true)}
          className="p-2 text-white/80 hover:text-white hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center bg-white/5 active:scale-90"
          title="Zoom In"
        >
          <ZoomIn size={18} strokeWidth={2.5} />
        </button>
        
        <button 
          onClick={() => cameraRef.current?.controls.dolly(-5, true)}
          className="p-2 text-white/80 hover:text-white hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center bg-white/5 active:scale-90"
          title="Zoom Out"
        >
          <ZoomOut size={18} strokeWidth={2.5} />
        </button>

        <div className="h-px w-6 bg-white/15 my-0.5 rounded-full" />

        <button 
          onClick={() => {
            if (cameraRef.current && modelBboxRef.current) {
              cameraRef.current.controls.fitToBox(modelBboxRef.current, true, {
                paddingTop: 0.1, paddingBottom: 0.1, paddingLeft: 0.1, paddingRight: 0.1
              });
            }
          }}
          className="p-2 text-white/80 hover:text-white hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center bg-white/5 active:scale-90"
          title="Fit to View"
        >
          <Maximize size={18} strokeWidth={2.5} />
        </button>

        <button 
          onClick={() => {
            if (cameraRef.current && modelBboxRef.current) {
              const center = new THREE.Vector3();
              modelBboxRef.current.getCenter(center);
              cameraRef.current.controls.setLookAt(
                center.x + 20, center.y + 20, center.z + 20, 
                center.x, center.y, center.z, 
                true
              );
            }
          }}
          className="p-2 text-white/80 hover:text-white hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center bg-white/5 active:scale-90"
          title="Reset Orbit Angle"
        >
          <RotateCcw size={18} strokeWidth={2.5} />
        </button>

        <div className="h-px w-6 bg-white/15 my-0.5 rounded-full" />

        <button 
          onClick={() => {
            if (cameraRef.current) {
               const current = cameraRef.current.projection.current;
               const next = current === 'Perspective' ? 'Orthographic' : 'Perspective';
               cameraRef.current.projection.set(next);
               if (modelBboxRef.current) {
                  cameraRef.current.controls.fitToBox(modelBboxRef.current, false);
               }
            }
          }}
          className="p-2 text-white/80 hover:text-white hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center bg-white/5 active:scale-90"
          title="Toggle Perspective / Orthographic"
        >
          <Box size={18} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
});
