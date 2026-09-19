import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import Stats from 'stats.js';
import { ZoomIn, ZoomOut, Maximize, RotateCcw, Box, Sun, Moon } from 'lucide-react';

export interface IfcViewerHandle {
  loadIfc: (file: File) => Promise<void>;
  loadIfcFromUrl: (url: string) => Promise<void>;
}

/** Near/far planes on BOTH cameras — an ortho camera needs a negative near to keep
 *  geometry behind the target visible, so it can't share the perspective values. */
function applyClipRange(camera: OBC.OrthoPerspectiveCamera, near: number, far: number) {
  const persp = camera.threePersp;
  if (persp) {
    persp.near = near;
    persp.far = far;
    persp.updateProjectionMatrix();
  }
  const ortho = camera.threeOrtho;
  if (ortho) {
    ortho.near = -far;
    ortho.far = far;
    ortho.updateProjectionMatrix();
  }
}

/** Rescale travel limits, pan speed and clipping to the model actually loaded, so the
 *  same controls work for a handrail detail and for a 2.4 km city. */
function tuneNavigationToModel(camera: OBC.OrthoPerspectiveCamera, bbox: THREE.Box3) {
  const span = bbox.getSize(new THREE.Vector3()).length() || 60;
  const controls = camera.controls;
  controls.minDistance = Math.max(0.05, span / 100000);
  controls.maxDistance = Math.max(5000, span * 20);
  // Pan (truck) covers a consistent fraction of the model per drag instead of a
  // fixed number of metres — the reason panning across a city felt stuck.
  controls.truckSpeed = Math.max(2, span / 60);
  applyClipRange(camera, Math.max(0.05, span / 50000), Math.max(10000, span * 40));
}

/** Frame a box from a three-quarter aerial angle at a distance derived from its size.
 *  Done explicitly rather than via fitToBox, which reuses the current view direction
 *  and leaves wide sites viewed edge-on from near ground level. */
function frameBox(camera: OBC.OrthoPerspectiveCamera, bbox: THREE.Box3, transition = true) {
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const size = bbox.getSize(new THREE.Vector3());
  // Distance that comfortably fits the widest horizontal extent in view.
  const reach = Math.max(size.x, size.z, size.y) || 60;
  const d = reach * 0.25;
  camera.controls.setLookAt(
    center.x + d * 0.75, center.y + d * 0.60, center.z + d * 0.75,
    center.x, center.y, center.z,
    transition,
  );
}

/** One zoom click moves a PROPORTION of the current viewing distance, so the step
 *  stays useful at every scale. A fixed step is imperceptible on a large site. */
function zoomByStep(camera: OBC.OrthoPerspectiveCamera | null, direction: 1 | -1) {
  if (!camera) return;
  const controls = camera.controls;
  if (camera.projection.current === 'Orthographic') {
    const zoom = camera.threeOrtho?.zoom ?? 1;
    controls.zoom(direction > 0 ? zoom * 0.4 : -zoom * 0.3, true);
    return;
  }
  const distance = controls.distance || 10;
  controls.dolly(direction > 0 ? distance * 0.35 : -distance * 0.5, true);
}

type SceneTheme = 'dark' | 'light';
const THEME_KEY = 'infrastudio_scene_theme';
const THEMES: Record<SceneTheme, { bg: string; grid: string; panel: string; btn: string; text: string; divider: string }> = {
  dark: {
    bg: '#171717',
    grid: '#666666',
    panel: 'bg-neutral-900/90 border-white/10',
    btn: 'text-white/80 hover:text-white bg-white/5',
    text: 'text-white',
    divider: 'bg-white/15',
  },
  light: {
    bg: '#eef0f3',
    grid: '#b4bac2',
    panel: 'bg-white/90 border-black/10',
    btn: 'text-neutral-700 hover:text-white bg-black/5',
    text: 'text-neutral-800',
    divider: 'bg-black/15',
  },
};

function loadTheme(): SceneTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export const IfcViewer = forwardRef<IfcViewerHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const ifcLoaderRef = useRef<OBC.IfcLoader | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [theme, setTheme] = useState<SceneTheme>(loadTheme);
  const themeRef = useRef<SceneTheme>(theme);
  const gridRef = useRef<OBC.SimpleGrid | null>(null);
  const modelBboxRef = useRef<THREE.Box3 | null>(null);
  const cameraRef = useRef<OBC.OrthoPerspectiveCamera | null>(null);
  // Fragments render through their own streaming/LOD pipeline, so the THREE object
  // graph holds no measurable meshes — THREE.Box3().setFromObject() returns EMPTY.
  // The model itself exposes the real bounds, so keep the models and ask them.
  const modelsRef = useRef<{ box?: THREE.Box3; object?: THREE.Object3D }[]>([]);

  /** Live bounds of everything loaded. Falls back to the object graph if needed. */
  const currentModelBbox = (): THREE.Box3 | null => {
    const box = new THREE.Box3();
    for (const model of modelsRef.current) {
      const b = model?.box;
      if (b && !b.isEmpty()) box.union(b);
      else if (model?.object) box.union(new THREE.Box3().setFromObject(model.object, true));
    }
    if (box.isEmpty()) return modelBboxRef.current;
    modelBboxRef.current = box;
    return box;
  };

  // The scene background is transparent, so the theme is the container colour plus the
  // grid line colour. Persisted per device; storage can throw in private windows.
  useEffect(() => {
    themeRef.current = theme;
    const grid = gridRef.current;
    if (grid) grid.config.color = new THREE.Color(THEMES[theme].grid);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable — theme just won't persist */
    }
  }, [theme]);

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

    // Baseline navigation range. The defaults are tuned for a single building;
    // a city-scale model needs orders of magnitude more travel, and a far plane
    // that doesn't clip the whole scene away as soon as you pull back.
    world.camera.controls.minDistance = 0.1;
    world.camera.controls.maxDistance = 100000;
    applyClipRange(world.camera, 0.1, 200000);

    // ── 3. Grid ──────────────────────────────────────────────────────────────
    const grid = components.get(OBC.Grids).create(world);
    gridRef.current = grid;
    grid.config.color = new THREE.Color(THEMES[themeRef.current].grid);

    // ── 4. Stats panel ───────────────────────────────────────────────────────
    const stats = new Stats();
    stats.showPanel(0);
    if (window.innerWidth < 640) {
      stats.dom.style.display = 'none';
    } else {
      stats.dom.style.position = 'absolute';
      stats.dom.style.top = '16px';
      stats.dom.style.left = '16px';
      container.appendChild(stats.dom);
    }

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

      // Streaming only advances while the camera is moving, so a view that ends far
      // from where it started settles with most geometry still unloaded. Forcing a
      // refresh once motion stops fills in the rest — this is what makes a big
      // zoom-out or pan actually show the model instead of an empty site.
      world.camera.controls.addEventListener('rest', () => {
        if (isMounted) fragments.core.update(true);
      });

      // When a model is loaded → add it to the scene + center the camera orbit on it
      fragments.list.onItemSet.add(({ value: model }) => {
        console.log('FragmentsModel received in onItemSet, adding to scene...');
        model.useCamera(world.camera!.three);
        world.scene!.three.add(model.object);
        if (!modelsRef.current.includes(model)) modelsRef.current.push(model);
        // By default distant items are culled/LOD'd by screen size, which leaves a
        // city-scale model looking empty when you pull back far enough to see it all.
        try {
          model.graphicsQuality = 1;
          model.setLodMode?.(2 /* LodMode.ALL_GEOMETRY */);
        } catch (e) {
          console.warn('Could not raise LOD mode:', e);
        }
        fragments.core.update(true);
        console.log('FragmentsModel added to scene and updated core.');

        // --- Frame the model once its geometry has actually streamed in ---
        // model.box is the authoritative extent; it can still be empty on the first
        // tick, so retry briefly rather than falling back to a fixed near camera.
        const frameModel = (attempt = 0) => {
          if (!isMounted || !world.camera) return;
          const bbox = currentModelBbox();
          if (!bbox || bbox.isEmpty()) {
            if (attempt < 20) {
              setTimeout(() => frameModel(attempt + 1), 250);
            } else if (world.camera) {
              console.warn('Model bounds unavailable — using fallback camera position');
              world.camera.controls.setLookAt(30, 30, 30, 0, 0, 0, true);
            }
            return;
          }
          const size = bbox.getSize(new THREE.Vector3());
          console.log(`Model bounds: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} m`);
          tuneNavigationToModel(world.camera, bbox);
          frameBox(world.camera, bbox, true);
          // A large camera jump outruns the streamer's incremental updates, so force
          // a refresh once the move has settled or the site renders empty.
          window.setTimeout(() => { if (isMounted) fragments.core.update(true); }, 700);
          window.setTimeout(() => { if (isMounted) fragments.core.update(true); }, 1800);
        };
        frameModel();
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
    <div
      className="relative w-full h-full overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: THEMES[theme].bg }}
    >
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
      <div className="absolute top-4 right-4 z-10 text-white font-mono text-xs pointer-events-none bg-black/60 px-2 py-1 rounded">
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
      <div className={`absolute top-1/3 sm:top-1/2 right-2 sm:right-3 -translate-y-1/2 z-20 flex flex-col items-center gap-1 sm:gap-1.5 px-1 sm:px-1.5 py-2 sm:py-2.5 backdrop-blur-xl rounded-xl sm:rounded-2xl border shadow-lg pointer-events-auto ${THEMES[theme].panel}`}>
        <button
          onClick={() => zoomByStep(cameraRef.current, 1)}
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title="Zoom In"
        >
          <ZoomIn size={18} strokeWidth={2.5} />
        </button>

        <button
          onClick={() => zoomByStep(cameraRef.current, -1)}
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title="Zoom Out"
        >
          <ZoomOut size={18} strokeWidth={2.5} />
        </button>

        <div className={`h-px w-6 my-0.5 rounded-full ${THEMES[theme].divider}`} />

        <button 
          onClick={() => {
            const bbox = currentModelBbox();
            if (cameraRef.current && bbox) {
              // Re-tune first: a streamed-in model can be far bigger than it was at
              // load time, and the travel limits have to grow with it.
              tuneNavigationToModel(cameraRef.current, bbox);
              frameBox(cameraRef.current, bbox, true);
            }
          }}
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title="Fit to View"
        >
          <Maximize size={18} strokeWidth={2.5} />
        </button>

        <button 
          onClick={() => {
            const bbox = currentModelBbox();
            if (cameraRef.current && bbox) {
              const center = new THREE.Vector3();
              bbox.getCenter(center);
              // Stand off by a fraction of the model, not a fixed 20 m — on a city
              // that put the camera underground in the middle of the site.
              const span = bbox.getSize(new THREE.Vector3()).length() || 60;
              const d = span * 0.55;
              cameraRef.current.controls.setLookAt(
                center.x + d, center.y + d * 0.8, center.z + d,
                center.x, center.y, center.z,
                true
              );
            }
          }}
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title="Reset Orbit Angle"
        >
          <RotateCcw size={18} strokeWidth={2.5} />
        </button>

        <div className={`h-px w-6 my-0.5 rounded-full ${THEMES[theme].divider}`} />

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
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title="Toggle Perspective / Orthographic"
        >
          <Box size={18} strokeWidth={2.5} />
        </button>

        <button
          onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
          className={`p-2 hover:bg-blue-600 rounded-xl transition-all flex items-center justify-center active:scale-90 ${THEMES[theme].btn}`}
          title={theme === 'dark' ? 'Switch to light scene' : 'Switch to dark scene'}
        >
          {theme === 'dark' ? <Sun size={18} strokeWidth={2.5} /> : <Moon size={18} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
});
