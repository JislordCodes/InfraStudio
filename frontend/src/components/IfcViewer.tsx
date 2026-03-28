import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import Stats from 'stats.js';

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

  useEffect(() => {
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
    //
    // Correct order from official docs:
    //   a) Call fragments.init(workerUrl)          ← synchronous call, no await needed
    //   b) Register camera update listener on core  ← after init
    //   c) Register fragments.list.onItemSet        ← NOT onFragmentsLoaded
    //   d) Register material z-fighting listener    ← after init
    //   e) await ifcLoader.setup(...)               ← must await, needs autoSetWasm: false
    //
    const fragments = components.get(OBC.FragmentsManager);
    const ifcLoader = components.get(OBC.IfcLoader);
    ifcLoaderRef.current = ifcLoader;

    const initAsync = async () => {
      // Fetch the fragments web-worker
      const githubUrl = 'https://thatopen.github.io/engine_fragment/resources/worker.mjs';
      const fetchedUrl = await fetch(githubUrl);
      const workerBlob = await fetchedUrl.blob();
      const workerFile = new File([workerBlob], 'worker.mjs', { type: 'text/javascript' });
      const workerUrl = URL.createObjectURL(workerFile);

      // Init fragments — this is NOT awaited in the official docs
      fragments.init(workerUrl);

      // Camera update loop
      world.camera.controls.addEventListener('update', () => fragments.core.update());

      // When a model is loaded → add it to the scene + center the camera orbit on it
      fragments.list.onItemSet.add(({ value: model }) => {
        model.useCamera(world.camera!.three);
        world.scene!.three.add(model.object);
        fragments.core.update(true);

        // --- Center camera on loaded model ---
        // Compute the bounding box of the model's 3D object in world space
        const bbox = new THREE.Box3().setFromObject(model.object);

        if (!bbox.isEmpty()) {
          const center = new THREE.Vector3();
          bbox.getCenter(center);

          // Set the orbit pivot exactly to the model center so rotating
          // never changes apparent distance (zoom stays locked)
          world.camera!.controls.setTarget(center.x, center.y, center.z, false);

          // Fit camera so the whole model is visible, with a bit of padding
          world.camera!.controls.fitToBox(bbox, true, {
            paddingTop:    0.1,
            paddingBottom: 0.1,
            paddingLeft:   0.1,
            paddingRight:  0.1,
          });
        }
      });

      // Remove z-fighting on new materials
      fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
        if (!('isLodMaterial' in material && material.isLodMaterial)) {
          material.polygonOffset = true;
          material.polygonOffsetUnits = 1;
          material.polygonOffsetFactor = Math.random();
        }
      });

      // Configure web-ifc wasm — must await, autoSetWasm: false, version must match installed web-ifc
      await ifcLoader.setup({
        autoSetWasm: false,
        wasm: {
          path: 'https://unpkg.com/web-ifc@0.0.66/',
          absolute: true,
        },
      });

      setIsLoaded(true);
    };

    initPromiseRef.current = initAsync().catch((e) => {
      console.error('IFC Viewer init failed:', e);
    });

    return () => {
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
        // Wait for the async init (worker + wasm setup) to fully complete first
        if (initPromiseRef.current) {
          await initPromiseRef.current;
        }

        const data = new Uint8Array(await file.arrayBuffer());

        // Correct signature: load(buffer, useWorker, modelId, options?)
        await ifcLoaderRef.current.load(data, false, file.name, {
          processData: {
            progressCallback: (progress: number) =>
              console.log(`IFC loading progress: ${Math.round(progress * 100)}%`),
          },
        });
      } catch (error) {
        console.error('Error loading IFC file:', error);
        alert('Failed to load IFC file. Check the console for details.');
      } finally {
        setIsLoadingFile(false);
      }
    },

    loadIfcFromUrl: async (url: string) => {
      if (!ifcLoaderRef.current) return;
      setIsLoadingFile(true);
      try {
        if (initPromiseRef.current) {
          await initPromiseRef.current;
        }

        console.log(`Fetching IFC from URL: ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

        const data = new Uint8Array(await response.arrayBuffer());
        console.log(`Fetched ${data.byteLength} bytes, loading into viewer...`);

        const modelId = `supabase-model-${Date.now()}`;
        await ifcLoaderRef.current.load(data, false, modelId, {
          processData: {
            progressCallback: (progress: number) =>
              console.log(`IFC loading progress: ${Math.round(progress * 100)}%`),
          },
        });
        console.log('IFC model loaded from URL successfully');
      } catch (error) {
        console.error('Error loading IFC from URL:', error);
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
      <div className="absolute top-4 right-4 z-10 text-white font-mono text-xs opacity-50 pointer-events-none bg-black/50 px-2 py-1 rounded">
        {isLoaded ? 'Engine Ready' : 'Initializing Engine...'}
      </div>
    </div>
  );
});
