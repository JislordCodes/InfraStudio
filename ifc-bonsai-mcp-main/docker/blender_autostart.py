"""
blender_autostart.py — runs inside Blender's Python interpreter at startup.
Applies ifcopenshell compatibility patches then starts the MCP socket server.
"""
import os
import sys
import time
import logging
import importlib
import importlib.util

# Standardize logs to stdout for CloudWatch
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] blender: %(message)s',
    force=True
)
logger = logging.getLogger('blender_mcp')

# ── Step 1: Determine paths ─────────────────────────────────────────────────
def get_addons_path():
    try:
        import bpy
        major_ver = f"{bpy.app.version[0]}.{bpy.app.version[1]}"
        blender_dir = os.environ.get('BLENDER_DIR', f"/opt/blender-{bpy.app.version[0]}.{bpy.app.version[1]}.{bpy.app.version[2]}-linux-x64")
        return os.path.join(blender_dir, major_ver, 'scripts', 'addons')
    except Exception:
        return "/opt/blender-4.3.2-linux-x64/4.3/scripts/addons"

addons_path = get_addons_path()

# Only inject blendermcp into sys.path (NOT bonsai — it lives in site-packages)
for p in [addons_path, os.path.join(addons_path, 'blendermcp')]:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)
        logger.info(f"Injected {p} into sys.path")

# ── Step 2: Apply ALL ifcopenshell C-extension patches BEFORE any bonsai import
try:
    import ifcopenshell.ifcopenshell_wrapper as _w

    # Geom element aliases
    _w.native_element = getattr(_w, 'Element', None)
    _w.triangulation_element = getattr(_w, 'TriangulationElement', None)
    _w.serialized_element = getattr(_w, 'SerializedElement', None)
    _w.brep_element = getattr(_w, 'BRepElement', None)
    _w.settings = getattr(_w, 'Settings', None)
    _w.iterator = getattr(_w, 'Iterator', None)
    _w.native = getattr(_w, 'Element', None)
    _w.triangulation = getattr(_w, 'TriangulationElement', None)
    _w.serialization = getattr(_w, 'SerializedElement', None)
    _w.brep = getattr(_w, 'BRepElement', None)

    # entity_instance attribute bridge (TemplateType etc.)
    _w.entity_instance.__getattr__ = lambda self, name: self.get_argument(self.get_argument_index(name))

    # Some bundled IfcOpenShell builds expose the low-level C++ `file` class
    # without the Python methods that Bonsai and ifcopenshell.api expect.
    # Install narrow compatibility shims before importing Bonsai. Without these,
    # `ifcopenshell.open()` fails with missing post_init and API creation fails
    # with `file object has no attribute create_entity`.
    import ifcopenshell
    _file_cls = getattr(ifcopenshell, "file", None)

    # The Blender-bundled IfcOpenShell build exposes the native C++ ``file``
    # class but omits the Python ``file_mixin`` methods that Bonsai/API code
    # relies on.  In particular, forwarding to ``createIfc*`` is not enough:
    # the native class does not expose dynamic creators for every IFC type
    # (for example IfcOwnerHistory).  Reattach the upstream mixin methods to
    # the native class so create_entity performs schema-aware attribute setup.
    _file_mixin = None
    try:
        _file_module = importlib.import_module("ifcopenshell.file")
        _file_mixin = getattr(_file_module, "file_mixin", None)
    except Exception as _mixin_err:
        logger.warning(f"Could not load IfcOpenShell file mixin: {_mixin_err}")

    if _file_cls is not None and _file_mixin is not None:
        for _name in ("post_init", "create_entity"):
            _method = getattr(_file_mixin, _name, None)
            if _method is not None:
                setattr(_file_cls, _name, _method)

    if _file_cls is not None and not hasattr(_file_cls, "post_init"):
        setattr(_file_cls, "post_init", lambda self: None)

    if _file_cls is not None and not hasattr(_file_cls, "create_entity"):
        def _create_entity(self, entity_type, *args, **kwargs):
            creator = getattr(self, f"create{entity_type}", None)
            if creator is None:
                raise AttributeError(f"file object cannot create {entity_type}")
            return creator(*args, **kwargs)
        setattr(_file_cls, "create_entity", _create_entity)

    logger.info("Successfully patched ifcopenshell compatibility (geom aliases + create_entity + post_init + entity_instance bridge).")
except Exception as _w_err:
    logger.warning(f"ifcopenshell patch notice: {_w_err}")

# ── Step 3: Enable Bonsai addon ─────────────────────────────────────────────
logger.info("Enabling Bonsai addon...")
try:
    import addon_utils
    res = addon_utils.enable("bonsai", default_set=True)
    if res:
        logger.info(f"Bonsai addon enabled: {res}")
    else:
        logger.warning("Bonsai addon enable returned None (non-fatal, direct import may still work)")
except Exception as e:
    logger.warning(f"Bonsai addon enable exception (non-fatal): {e}")

# Verify bonsai.tool.Ifc is accessible
try:
    import bonsai.tool as tool
    logger.info(f"bonsai.tool.Ifc verified: {tool.Ifc}")
except Exception as e:
    logger.error(f"bonsai.tool.Ifc NOT available: {e}")

# ── Step 4: Intercept bpy.app.timers for headless operation ──────────────────
import queue
import bpy

_mcp_queue = queue.Queue()
_original_register = bpy.app.timers.register

def custom_register(func, first_interval=0.0, persistent=False):
    """Intercept timer registrations so we can process them in our blocking loop."""
    _mcp_queue.put((func, time.time() + first_interval))
    return first_interval

bpy.app.timers.register = custom_register
logger.info("Intercepted bpy.app.timers.register for headless execution.")

# ── Step 5: Start socket server by loading core.py DIRECTLY ──────────────────
# We load core.py via importlib to BYPASS blendermcp/__init__.py which
# triggers `from . import commands` → `from bonsai import tool` circular import.
# core.py only needs bpy, json, threading, socket — no bonsai at import time.
try:
    core_path = os.path.join(addons_path, 'blendermcp', 'core.py')
    spec = importlib.util.spec_from_file_location("blendermcp.core", core_path)
    _core = importlib.util.module_from_spec(spec)
    sys.modules["blendermcp.core"] = _core
    spec.loader.exec_module(_core)

    port = int(os.environ.get("BLENDER_MCP_PORT", "9876"))
    srv = _core.create_server_instance(port=port)
    srv.start()
    logger.info(f"BlenderMCP socket server started on port {port}.")
except Exception as e:
    logger.error(f"Could not start socket server: {e}", exc_info=True)

# ── Step 6: Pre-initialize IFC project ───────────────────────────────────────
try:
    logger.info("Pre-initializing IFC project context...")
    from blendermcp.api.project import initialize_project
    init_res = initialize_project(project_name="Cloud Default Project")
    if init_res.get("success"):
        logger.info(f"IFC Context ready: {init_res.get('project_guid')}")
    else:
        logger.warning(f"IFC Context init returned: {init_res.get('error')}")
except Exception as e:
    logger.warning(f"IFC Context pre-init failed (will fallback on first call): {e}")

# ── Step 7: Headless event pump ──────────────────────────────────────────────
logger.info("Blender is now running headless event pump for MCP requests.")
try:
    while True:
        try:
            func, exec_time = _mcp_queue.get(timeout=0.1)
            if time.time() >= exec_time:
                try:
                    res = func()
                    if isinstance(res, (int, float)) and res > 0:
                        _mcp_queue.put((func, time.time() + res))
                except Exception as e:
                    logger.error(f"Timer execution failed: {e}", exc_info=True)
            else:
                _mcp_queue.put((func, exec_time))
                time.sleep(0.05)
        except queue.Empty:
            time.sleep(0.02)
except KeyboardInterrupt:
    logger.info("Blender process received shutdown signal.")
