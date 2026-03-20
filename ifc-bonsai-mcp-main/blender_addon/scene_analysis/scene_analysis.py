"""Blender scene analysis and viewport utilities.

Provides tools for scene manipulation, viewport control, screenshot capture,
and render pass extraction in Blender. Supports multiple image formats with
optimization and base64 encoding for data URIs.
"""

from __future__ import annotations
import bpy
import math
import mathutils
import tempfile
import os
import base64
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

try:
    from PIL import Image
    PIL_AVAILABLE = True
    RESAMPLE = getattr(Image, 'Resampling', Image).LANCZOS
except ImportError:
    Image = None
    PIL_AVAILABLE = False
    RESAMPLE = None

from bpy_extras import view3d_utils
from mathutils import Vector, Euler
from ..api import register_command

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}


def cleanup_temp_files(*file_paths) -> None:
    """Safely clean up temporary files."""
    for path in file_paths:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass


def validate_screenshot_params(format: str, quality: int, max_size: Optional[int]) -> Optional[str]:
    """Validate common screenshot parameters.
    
    Returns:
        Error message if validation fails, None if successful
    """
    if format.upper() not in ALLOWED_FORMATS:
        return "Format must be 'PNG', 'JPEG', or 'WEBP'"
    if not (1 <= quality <= 100):
        return "Quality must be between 1 and 100"
    if max_size is not None and max_size <= 0:
        return "max_size must be positive if specified"
    return None


def encode_image(data: bytes) -> str:
    """Encode image bytes to base64 string."""
    return base64.b64encode(data).decode("utf-8")


def build_data_uri(fmt: str, b64_data: str) -> str:
    """Build a data URI from image format and base64-encoded data.
    
    Args:
        fmt: Image format (PNG, JPEG, WEBP)
        b64_data: Base64-encoded image data
        
    Returns:
        Complete data URI string
    """
    mime_map = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
    mime = mime_map.get(fmt.upper(), "application/octet-stream")
    return f"data:{mime};base64,{b64_data}"


def get_largest_3d_viewport():
    """Find and return the largest 3D viewport area in the current screen.
    
    Returns:
        Tuple of (window, area, region) or None if no 3D viewport found
    """
    window = bpy.context.window
    if not window or not bpy.context.screen:
        return None
    
    best = None
    best_size = -1
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
        if not region:
            continue
        size = region.width * region.height
        if size > best_size:
            best = (window, area, region)
            best_size = size
    return best


def get_3d_viewport(area_index: Optional[int] = None):
    """Get 3D viewport by index or return the largest available viewport.
    
    Args:
        area_index: Optional index of specific viewport to get
        
    Returns:
        Tuple of (window, area, region) or None if no 3D viewport found
    """
    try:
        window = bpy.context.window
        if not window or not bpy.context.screen:
            return None
        
        areas = [a for a in bpy.context.screen.areas if a.type == "VIEW_3D"]
        if not areas:
            return None
        
        if area_index is not None:
            if not isinstance(area_index, int):
                return None
            if 0 <= area_index < len(areas):
                area = areas[area_index]
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region:
                    return (window, area, region)
        
        return get_largest_3d_viewport()
    except Exception:
        return None


def get_viewport_info(space, region_3d) -> Dict[str, Any]:
    """Extract viewport information from space and region_3d objects.
    
    Args:
        space: 3D viewport space data
        region_3d: 3D region data
        
    Returns:
        Dictionary containing viewport configuration details
    """
    return {
        "shading_type": getattr(space.shading, "type", None),
        "view_perspective": "PERSP" if region_3d.is_perspective else "ORTHO",
        "view_location": list(region_3d.view_location),
        "view_distance": region_3d.view_distance,
        "view_rotation_degrees": [math.degrees(a) for a in region_3d.view_rotation.to_euler()],
        "show_overlays": getattr(space.overlay, "show_overlays", None),
        "show_gizmo": getattr(space, "show_gizmo", None),
    }


def resize_image(img, max_size: Optional[int]):
    """Resize image if it exceeds the maximum size constraint.
    
    Args:
        img: PIL Image object to resize
        max_size: Maximum dimension in pixels, or None to skip resizing
        
    Returns:
        Tuple of (resized_image, was_resized_bool)
    """
    if not PIL_AVAILABLE or not max_size or not img:
        return img, False
    
    try:
        width, height = img.size
        if max(width, height) <= max_size:
            return img, False
        
        if max_size <= 0:
            return img, False
            
        scale = max_size / max(width, height)
        new_w, new_h = max(1, int(width * scale)), max(1, int(height * scale))
        
        if scale < 0.5:
            intermediate = 0.7
            w1, h1 = max(1, int(width * intermediate)), max(1, int(height * intermediate))
            img = img.resize((w1, h1), RESAMPLE)
        
        return img.resize((new_w, new_h), RESAMPLE), True
    except Exception as e:
        print(f"Warning: Image resize failed: {e}")
        return img, False


def save_image(img, fmt: str, quality: int, temp_dir: str, prefix: str):
    """Save PIL image in the specified format with appropriate settings.
    
    Args:
        img: PIL Image object to save
        fmt: Target format (PNG, JPEG, WEBP)
        quality: JPEG/WEBP quality setting (1-100)
        temp_dir: Directory to save the file in
        prefix: Filename prefix
        
    Returns:
        Tuple of (file_path, actual_format_used)
    """
    if not img:
        raise ValueError("No image provided")
    
    fmt = fmt.upper()
    if fmt not in ALLOWED_FORMATS:
        fmt = "PNG"
    
    quality = max(1, min(100, quality))
    
    try:
        if fmt == "JPEG":
            if img.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode == "P":
                    img = img.convert("RGBA")
                if img.mode in ("RGBA", "LA"):
                    bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                else:
                    bg.paste(img)
                img = bg
            path = os.path.join(temp_dir, f"{prefix}.jpg")
            img.save(path, format="JPEG", quality=quality, optimize=True)
            return path, "JPEG"
        
        if fmt == "WEBP":
            path = os.path.join(temp_dir, f"{prefix}.webp")
            try:
                img.save(path, format="WEBP", quality=quality, method=6)
                return path, "WEBP"
            except Exception:
                path = os.path.join(temp_dir, f"{prefix}.png")
                img.save(path, format="PNG", optimize=True)
                return path, "PNG"
        
        path = os.path.join(temp_dir, f"{prefix}.png")
        img.save(path, format="PNG", optimize=True)
        return path, "PNG"
        
    except Exception as e:
        try:
            path = os.path.join(temp_dir, f"{prefix}_fallback.png")
            img.save(path, format="PNG")
            return path, "PNG"
        except Exception as final_error:
            raise RuntimeError(f"Failed to save image: {e}, fallback also failed: {final_error}")

@register_command('capture_blender_window_screenshot', description="Capture the entire Blender application window")
def capture_blender_window_screenshot(
    max_size: Optional[int] = None,
    format: str = 'PNG',
    quality: int = 95,
    return_image_data: bool = True,
    include_data_uri: bool = False,
    keep_file: bool = False,
) -> Dict[str, Any]:
    """Capture a screenshot of the entire Blender application window.
    
    Args:
        max_size: Maximum dimension in pixels for resizing
        format: Output format (PNG, JPEG, WEBP)
        quality: JPEG/WEBP quality (1-100)
        return_image_data: Include base64-encoded image data
        include_data_uri: Include data URI string
        keep_file: Preserve temporary files on disk
        
    Returns:
        Dictionary with success status, image data, and metadata
    """
    validation_error = validate_screenshot_params(format, quality, max_size)
    if validation_error:
        return {"success": False, "error": validation_error}

    temp_dir = tempfile.gettempdir()
    ts = int(time.time() * 1000)
    pid = os.getpid()
    initial = os.path.join(temp_dir, f"blender_screenshot_{pid}_{ts}_initial.png")

    try:
        bpy.ops.screen.screenshot(filepath=initial, check_existing=False)
        if not os.path.exists(initial):
            return {"success": False, "error": "Screenshot file was not created"}

        if PIL_AVAILABLE and Image:
            with Image.open(initial) as im:
                original_w, original_h = im.size
                im, resized = resize_image(im, max_size)
                width, height = im.size
                final_path, used_format = save_image(im, format, quality, temp_dir, f"blender_screenshot_{pid}_{ts}")
        else:
            original_w = original_h = width = height = None
            resized = False
            final_path = initial
            used_format = "PNG"

        with open(final_path, 'rb') as f:
            image_bytes = f.read()

        original_size_kb = os.path.getsize(initial) / 1024.0
        final_size_kb = len(image_bytes) / 1024.0
        compression_ratio = original_size_kb / final_size_kb if final_size_kb > 0 else 1.0

        img_b64 = encode_image(image_bytes) if return_image_data else None
        data_uri = build_data_uri(used_format, img_b64) if include_data_uri and img_b64 else None

        if not keep_file:
            cleanup_temp_files(final_path, initial if initial != final_path else None)

        return {
            "success": True,
            "data": {
                "dimensions": {
                    "width": width,
                    "height": height,
                    "original_width": original_w,
                    "original_height": original_h,
                },
                "encoding": {
                    "format": used_format,
                    "quality": quality if used_format in {"JPEG", "WEBP"} else None,
                    "file_size_kb": round(final_size_kb, 2),
                    "original_file_size_kb": round(original_size_kb, 2),
                    "compression_ratio": round(compression_ratio, 2),
                    "resized": resized,
                },
                "image": {
                    "path": final_path if keep_file else None,
                    "data": img_b64,
                    "data_uri": data_uri,
                },
                "metadata": {"type": "window_screenshot"}
            }
        }
    except Exception as e:
        return {"success": False, "error": f"Screenshot capture failed: {str(e)}"}
        
@register_command('capture_blender_3dviewport_screenshot', description="Capture only the Blender 3D viewport")
def capture_blender_3dviewport_screenshot(
    max_size: Optional[int] = None,
    format: str = 'PNG',
    quality: int = 95,
    return_image_data: bool = True,
    include_data_uri: bool = False,
    keep_file: bool = False,
    area_index: Optional[int] = None,
    shading_type: Optional[str] = None,
    show_overlays: Optional[bool] = None,
    show_gizmo: Optional[bool] = None,
    deterministic: bool = False,
) -> Dict[str, Any]:
    """Capture a screenshot of only the 3D viewport region.
    
    Args:
        max_size: Maximum dimension in pixels for resizing
        format: Output format (PNG, JPEG, WEBP)
        quality: JPEG/WEBP quality (1-100)
        return_image_data: Include base64-encoded image data
        include_data_uri: Include data URI string
        keep_file: Preserve temporary files on disk
        area_index: Specific viewport index, or None for largest
        shading_type: Override viewport shading mode
        show_overlays: Override overlay visibility
        show_gizmo: Override gizmo visibility
        deterministic: Use consistent viewport settings for reproducible results
        
    Returns:
        Dictionary with success status, image data, viewport info, and metadata
    """
    validation_error = validate_screenshot_params(format, quality, max_size)
    if validation_error:
        return {"success": False, "error": validation_error}

    viewport = get_3d_viewport(area_index)
    if not viewport:
        return {"success": False, "error": "No 3D viewport found"}
    
    window, area, region = viewport
    space = area.spaces.active
    region_3d = space.region_3d

    prev_values = {}
    if deterministic or shading_type:
        apply_type = 'SOLID' if deterministic else shading_type
        apply_overlays = False if deterministic else show_overlays
        apply_gizmo = False if deterministic else show_gizmo
        
        prev_values = {
            'shading_type': getattr(space.shading, "type", None),
            'overlays': getattr(space.overlay, "show_overlays", None),
            'gizmo': getattr(space, "show_gizmo", None)
        }
        
        try:
            if apply_type and hasattr(space.shading, "type"):
                space.shading.type = apply_type
            if apply_overlays is not None and hasattr(space.overlay, "show_overlays"):
                space.overlay.show_overlays = apply_overlays
            if apply_gizmo is not None and hasattr(space, "show_gizmo"):
                space.show_gizmo = apply_gizmo
        except Exception:
            pass

    temp_dir = tempfile.gettempdir()
    ts = int(time.time() * 1000)
    pid = os.getpid()
    initial = os.path.join(temp_dir, f"blender_viewport_{pid}_{ts}_initial.png")

    try:
        with bpy.context.temp_override(window=window, area=area, region=region):
            bpy.ops.screen.screenshot_area(filepath=initial)
        
        if not os.path.exists(initial):
            return {"success": False, "error": "Viewport screenshot was not created"}

        if PIL_AVAILABLE and Image:
            with Image.open(initial) as im:
                original_w, original_h = im.size
                im, resized = resize_image(im, max_size)
                width, height = im.size
                final_path, used_format = save_image(im, format, quality, temp_dir, f"blender_viewport_{pid}_{ts}")
        else:
            original_w = original_h = width = height = None
            resized = False
            final_path = initial
            used_format = "PNG"

        with open(final_path, 'rb') as f:
            image_bytes = f.read()

        original_size_kb = os.path.getsize(initial) / 1024.0
        final_size_kb = len(image_bytes) / 1024.0
        compression_ratio = original_size_kb / final_size_kb if final_size_kb > 0 else 1.0

        img_b64 = encode_image(image_bytes) if return_image_data else None
        data_uri = build_data_uri(used_format, img_b64) if include_data_uri and img_b64 else None

        if not keep_file:
            try:
                if os.path.exists(final_path):
                    os.remove(final_path)
                if os.path.exists(initial) and initial != final_path:
                    os.remove(initial)
            except Exception:
                pass

        return {
            "success": True,
            "data": {
                "dimensions": {
                    "width": width,
                    "height": height,
                    "original_width": original_w,
                    "original_height": original_h,
                },
                "encoding": {
                    "format": used_format,
                    "quality": quality if used_format in {"JPEG", "WEBP"} else None,
                    "file_size_kb": round(final_size_kb, 2),
                    "original_file_size_kb": round(original_size_kb, 2),
                    "compression_ratio": round(compression_ratio, 2),
                    "resized": resized,
                },
                "image": {
                    "path": final_path if keep_file else None,
                    "data": img_b64,
                    "data_uri": data_uri,
                },
                "viewport_info": get_viewport_info(space, region_3d),
                "metadata": {"type": "viewport_screenshot"}
            }
        }

    except Exception as e:
        return {"success": False, "error": f"Viewport screenshot failed: {str(e)}"}
    finally:
        try:
            if 'shading_type' in prev_values and prev_values['shading_type'] and hasattr(space.shading, "type"):
                space.shading.type = prev_values['shading_type']
            if 'overlays' in prev_values and prev_values['overlays'] is not None and hasattr(space.overlay, "show_overlays"):
                space.overlay.show_overlays = prev_values['overlays']
            if 'gizmo' in prev_values and prev_values['gizmo'] is not None and hasattr(space, "show_gizmo"):
                space.show_gizmo = prev_values['gizmo']
        except Exception:
            pass


@register_command('get_viewport_description', description="Generate a natural language description of the current 3D viewport")
def get_viewport_description(area_index: Optional[int] = None) -> Dict[str, Any]:
    """Generate a natural language description of the current 3D viewport for LLM context.
    
    This function provides a textual summary of the viewport's appearance, including
    perspective mode, shading, overlays, and current view orientation, to help an LLM
    understand the visual state of the scene.
    
    Args:
        area_index: Specific viewport index, or None for largest
        
    Returns:
        Dictionary with success status and descriptive text
    """
    try:
        viewport = get_3d_viewport(area_index)
        if not viewport:
            return {"success": False, "error": "No 3D viewport found"}

        window, area, region = viewport
        space = area.spaces.active
        r3d = space.region_3d

        view_info = _gather_view_info(space)

        description_parts = []

        if view_info["view_perspective"] == "CAMERA":
            description_parts.append("The viewport is in camera view mode, showing the scene from the active camera's perspective.")
        elif view_info["is_perspective"]:
            description_parts.append("The viewport is in perspective mode.")
        else:
            description_parts.append("The viewport is in orthographic mode.")

        shading = getattr(space.shading, "type", None)
        if shading:
            shading_desc = {
                "WIREFRAME": "wireframe",
                "SOLID": "solid shading",
                "MATERIAL": "material preview",
                "RENDERED": "rendered preview"
            }.get(shading, f"{shading.lower()} shading")
            description_parts.append(f"Objects are displayed with {shading_desc}.")

        overlays = getattr(space.overlay, "show_overlays", None)
        gizmos = getattr(space, "show_gizmo", None)
        if overlays is False:
            description_parts.append("Overlays are hidden.")
        if gizmos is False:
            description_parts.append("Gizmos are hidden.")

        rot_deg = view_info["rotation_degrees"]
        description_parts.append(f"The view is oriented with rotation (X: {rot_deg[0]:.1f}°, Y: {rot_deg[1]:.1f}°, Z: {rot_deg[2]:.1f}°).")

        description_parts.append(f"View distance is {view_info['view_distance']:.2f} units, centered at location ({view_info['view_location'][0]:.2f}, {view_info['view_location'][1]:.2f}, {view_info['view_location'][2]:.2f}).")

        locks = []
        if view_info["lock_rotation"]:
            locks.append("rotation")
        if view_info["lock_object"]:
            locks.append("object")
        if view_info["lock_camera"]:
            locks.append("camera")
        if locks:
            description_parts.append(f"The following are locked: {', '.join(locks)}.")

        description = " ".join(description_parts)
        
        return {
            "success": True,
            "description": description,
            "view_info": view_info,
            "metadata": {"type": "viewport_description"}
        }
    except Exception as e:
        return {"success": False, "error": f"Viewport description failed: {e}"}

def _get_view3d(area_index: Optional[int] = None) -> Tuple[
    bpy.types.Window, bpy.types.Area, bpy.types.Region, bpy.types.SpaceView3D
]:
    """Return (window, area, region[WINDOW], space) for a VIEW_3D editor."""
    win = bpy.context.window or bpy.context.window_manager.windows[0]
    screen = win.screen
    areas = [a for a in screen.areas if a.type == 'VIEW_3D']
    if not areas:
        raise RuntimeError("No VIEW_3D area found")

    area = (sorted(areas, key=lambda a: a.width * a.height, reverse=True)[0]
            if area_index is None else areas[area_index])
    region = next((r for r in area.regions if r.type == 'WINDOW'), None)
    if region is None:
        raise RuntimeError("VIEW_3D WINDOW region not found")

    space = area.spaces.active
    if space.type != 'VIEW_3D':
        raise RuntimeError("Active space is not SpaceView3D")

    return win, area, region, space


def _gather_view_info(space: bpy.types.SpaceView3D) -> Dict[str, Any]:
    """Extract and package current view information."""
    r3d = space.region_3d
    e = r3d.view_rotation.to_euler()
    return {
        "rotation_degrees": [math.degrees(e.x), math.degrees(e.y), math.degrees(e.z)],
        "view_distance": r3d.view_distance,
        "is_perspective": r3d.is_perspective,
        "view_perspective": r3d.view_perspective,
        "view_location": list(r3d.view_location),
        "lock_rotation": getattr(r3d, "lock_rotation", False),
        "lock_object": bool(getattr(space, "lock_object", None)),
        "lock_camera": getattr(space, "lock_camera", False),
    }
    

@register_command('rotate_viewport', description="Rotate the 3D viewport by Euler degrees (incremental)")
def rotate_viewport(rotation_x: float = 0,
                    rotation_y: float = 0,
                    rotation_z: float = 0,
                    area_index: Optional[int] = None) -> Dict[str, Any]:
    """
    Incrementally rotate the viewport by the given Euler angles (degrees).
    X = orbit up/down, Y = orbit left/right, Z = roll.
    """
    try:
        win, area, region, space = _get_view3d(area_index)
        r3d = space.region_3d

        was_cam = (r3d.view_perspective == 'CAMERA')
        was_lock_rot = bool(getattr(r3d, "lock_rotation", False))
        old_lock_obj = getattr(space, "lock_object", None)

        if was_cam:
            with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
                bpy.ops.view3d.view_persportho()

        if was_lock_rot:
            r3d.lock_rotation = False
        if old_lock_obj is not None:
            space.lock_object = None

        rx, ry, rz = map(math.radians, (rotation_x, rotation_y, rotation_z))
        ok = True
        with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
            if abs(rx) > 1e-8:
                t = 'ORBITUP' if rx > 0 else 'ORBITDOWN'
                ok &= (bpy.ops.view3d.view_orbit(angle=abs(rx), type=t) == {'FINISHED'})
            if abs(ry) > 1e-8:
                t = 'ORBITRIGHT' if ry > 0 else 'ORBITLEFT'
                ok &= (bpy.ops.view3d.view_orbit(angle=abs(ry), type=t) == {'FINISHED'})
            if abs(rz) > 1e-8:
                ok &= (bpy.ops.view3d.view_roll(angle=rz) == {'FINISHED'})

        if not ok:
            rot_q = Euler((rx, ry, rz), 'XYZ').to_quaternion()
            r3d.view_rotation = rot_q @ r3d.view_rotation

        if was_cam:
            with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
                bpy.ops.view3d.view_camera()
        if was_lock_rot:
            r3d.lock_rotation = True
        if old_lock_obj is not None:
            space.lock_object = old_lock_obj

        return {
            "success": True,
            "message": "Viewport rotated",
            "view_info": _gather_view_info(space),
        }
    except Exception as e:
        return {"success": False, "error": f"Viewport rotation failed: {e}"}


@register_command('set_viewport_view', description="Set viewport view axis (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM/USER/CAMERA)")
def set_viewport_view(view_type: str = "USER",
                      area_index: Optional[int] = None,
                      align_active: bool = False,
                      relative: bool = False,
                      frame: str = "none"  # 'none' | 'selected' | 'all' | 'all_center'
                      ) -> Dict[str, Any]:
    """
    Set the viewport to a predefined orientation. Supports 'CAMERA'.
    Optionally recenter the view via `frame`:
      - 'selected': view_selected()
      - 'all': view_all(center=False)
      - 'all_center': view_all(center=True)
    """
    try:
        view = view_type.upper()
        valid = {"FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "USER", "CAMERA"}
        if view not in valid:
            return {"success": False, "error": f"Invalid view type: {view_type}"}

        win, area, region, space = _get_view3d(area_index)
        r3d = space.region_3d

        was_cam = (r3d.view_perspective == 'CAMERA')
        was_lock_rot = bool(getattr(r3d, "lock_rotation", False))
        old_lock_obj = getattr(space, "lock_object", None)

        if was_cam and view != "CAMERA":
            with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
                bpy.ops.view3d.view_persportho()

        if was_lock_rot:
            r3d.lock_rotation = False
        if old_lock_obj is not None:
            space.lock_object = None

        with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
            if view == "CAMERA":
                bpy.ops.view3d.view_camera()
            elif view == "USER":
                pass
            else:
                bpy.ops.view3d.view_axis(type=view, align_active=align_active, relative=relative)

            if frame == "selected":
                bpy.ops.view3d.view_selected(use_all_regions=False)
            elif frame == "all":
                bpy.ops.view3d.view_all(use_all_regions=False, center=False)
            elif frame == "all_center":
                bpy.ops.view3d.view_all(use_all_regions=False, center=True)

        if was_cam and view != "CAMERA":
            with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
                bpy.ops.view3d.view_camera()
        if was_lock_rot:
            r3d.lock_rotation = True
        if old_lock_obj is not None:
            space.lock_object = old_lock_obj

        return {
            "success": True,
            "message": f"Viewport set to {view}",
            "view_info": _gather_view_info(space),
        }
    except Exception as e:
        return {"success": False, "error": f"Set viewport view failed: {e}"}

@register_command('zoom_viewport', description="Zoom the 3D viewport by a factor")
def zoom_viewport(zoom_factor: float = 1.1,
                  area_index: Optional[int] = None,
                  method: str = "auto"  # 'auto' | 'operator' | 'distance'
                  ) -> Dict[str, Any]:
    """
    Zoom the 3D viewport by the specified factor.
      - zoom_factor > 1.0 -> zoom in
      - zoom_factor < 1.0 -> zoom out
    In 'auto' mode we try the zoom operator first (nice UX), and
    fall back to adjusting RegionView3D.view_distance.
    """
    try:
        win, area, region, space = _get_view3d(area_index)
        r3d = space.region_3d

        try:
            zoom_factor = float(zoom_factor)
        except Exception:
            return {"success": False, "error": f"Invalid zoom_factor: {zoom_factor!r}"}
        zoom_factor = max(0.01, zoom_factor)
        if abs(zoom_factor - 1.0) < 1e-9:
            return {"success": True, "message": "No zoom (factor ~ 1.0)", "view_info": _gather_view_info(space)}

        op_tried = op_ok = False
        if method in ("auto", "operator"):
            steps = int(round(math.log(zoom_factor, 1.1)))
            if steps != 0:
                op_tried = True
                with bpy.context.temp_override(window=win, area=area, region=region, space_data=space):
                    res = bpy.ops.view3d.zoom(delta=steps)
                    op_ok = (res == {'FINISHED'})

        if not op_ok and method in ("auto", "distance"):
            r3d.view_distance = max(1e-6, r3d.view_distance / zoom_factor)
            op_ok = True

        if not op_ok:
            msg = "Zoom operator was cancelled" if op_tried else "Zoom not attempted"
            return {"success": False, "error": msg}

        return {
            "success": True,
            "message": f"Viewport zoomed by factor {zoom_factor}",
            "view_info": _gather_view_info(space),
        }
    except Exception as e:
        return {"success": False, "error": f"Zoom viewport failed: {e}"}
    

@register_command('execute_keyboard_shortcut', description="Execute Blender keyboard shortcuts")
def execute_keyboard_shortcut(shortcut: str,
                              context_area: str = "VIEW_3D",
                              area_index: int | None = None,
                              prefer_mode: str = "AUTO") -> dict[str, object]:
    """
    Execute Blender keyboard shortcuts with robust, mode-aware handling.
    Keeps the same external behavior and return shape as your original.
    """
    import bpy
    from functools import lru_cache
    from math import radians

    EVENT_VALUES = {"PRESS", "RELEASE", "CLICK", "DOUBLE_CLICK", "ANY"}

    MOD_SYNONYMS = {
        "CTRL": "CTRL", "CONTROL": "CTRL",
        "ALT": "ALT",
        "SHIFT": "SHIFT",
        "CMD": "OSKEY", "COMMAND": "OSKEY", "META": "OSKEY", "WIN": "OSKEY", "OSKEY": "OSKEY",
    }

    DISALLOWED_PREFIXES_3DVIEW = {
        "paint.", "marker.", "view2d.", "clip.", "graph.", "sequencer.", "nla.", "uv.",
        "wm.context_",
    }

    KEYMAP_NAMES_BY_AREA = {
        "VIEW_3D": {
            "3D View", "Object Mode", "Mesh", "Curve", "Armature", "Sculpt",
            "Vertex Paint", "Weight Paint", "Texture Paint", "Grease Pencil",
            "Screen", "Window"
        },
        "TEXT_EDITOR": {"Text", "Screen", "Window"},
        "IMAGE_EDITOR": {"Image", "UV Editor", "Screen", "Window"},
        "OUTLINER": {"Outliner", "Screen", "Window"},
        "PROPERTIES": {"Property Editor", "Screen", "Window"},
        "DOPESHEET_EDITOR": {"Dopesheet", "Screen", "Window"},
        "NLA_EDITOR": {"NLA Channels", "NLA Editor", "Screen", "Window"},
    }

    @lru_cache(maxsize=256)
    def _normalize_shortcut(s: str):
        """Parse shortcut string into (mods, key, event_value).

        Returns:
            Tuple of (modifiers_dict, key_string, event_value_string)
        """
        t = s.upper().replace("-", "+").replace(" ", "+")
        parts = [p for p in t.split("+") if p]
        if not parts:
            raise ValueError("Empty shortcut")

        event_value = "PRESS"
        if parts[-1] in EVENT_VALUES:
            event_value = parts[-1]
            parts = parts[:-1]
            if not parts:
                raise ValueError("No key before event value")

        key = parts[-1]
        norm = {
            "NUM0": "NUMPAD_0", "NUMPAD0": "NUMPAD_0", "PAD0": "NUMPAD_0",
            "NUM1": "NUMPAD_1", "NUMPAD1": "NUMPAD_1", "PAD1": "NUMPAD_1",
            "NUM2": "NUMPAD_2", "NUMPAD2": "NUMPAD_2", "PAD2": "NUMPAD_2",
            "NUM3": "NUMPAD_3", "NUMPAD3": "NUMPAD_3", "PAD3": "NUMPAD_3",
            "NUM4": "NUMPAD_4", "NUMPAD4": "NUMPAD_4", "PAD4": "NUMPAD_4",
            "NUM5": "NUMPAD_5", "NUMPAD5": "NUMPAD_5", "PAD5": "NUMPAD_5",
            "NUM6": "NUMPAD_6", "NUMPAD6": "NUMPAD_6", "PAD6": "NUMPAD_6",
            "NUM7": "NUMPAD_7", "NUMPAD7": "NUMPAD_7", "PAD7": "NUMPAD_7",
            "NUM8": "NUMPAD_8", "NUMPAD8": "NUMPAD_8", "PAD8": "NUMPAD_8",
            "NUM9": "NUMPAD_9", "NUMPAD9": "NUMPAD_9", "PAD9": "NUMPAD_9",
            "NUMPERIOD": "NUMPAD_PERIOD", "NUMPAD_PERIOD": "NUMPAD_PERIOD", "PAD_PERIOD": "NUMPAD_PERIOD",
            "NUMPLUS": "NUMPAD_PLUS", "NUMPAD_PLUS": "NUMPAD_PLUS", "PAD_PLUS": "NUMPAD_PLUS",
            "NUMMINUS": "NUMPAD_MINUS", "NUMPAD_MINUS": "NUMPAD_MINUS", "PAD_MINUS": "NUMPAD_MINUS",
            "NUMSLASH": "NUMPAD_SLASH", "NUMPAD_SLASH": "NUMPAD_SLASH", "PAD_SLASH": "NUMPAD_SLASH",
            "NUMASTERISK": "NUMPAD_ASTERIX", "NUMPAD_ASTERISK": "NUMPAD_ASTERIX", "PAD_ASTERISK": "NUMPAD_ASTERIX", 
            "NUMENTER": "NUMPAD_ENTER", "NUMPAD_ENTER": "NUMPAD_ENTER", "PAD_ENTER": "NUMPAD_ENTER",
            **{f"F{i}": f"F{i}" for i in range(1, 13)},
            "SPACEBAR": "SPACE", "SPACE": "SPACE",
            "ESCAPE": "ESC", "ESC": "ESC",
            "RETURN": "RET", "ENTER": "RET",
            "DELETE": "DEL", "BACKSPACE": "BACK_SPACE",
            "PAGEUP": "PAGE_UP", "PAGEDOWN": "PAGE_DOWN",
            "UPARROW": "UP_ARROW", "DOWNARROW": "DOWN_ARROW",
            "LEFTARROW": "LEFT_ARROW", "RIGHTARROW": "RIGHT_ARROW",
            "UP": "UP_ARROW", "DOWN": "DOWN_ARROW", "LEFT": "LEFT_ARROW", "RIGHT": "RIGHT_ARROW",
            "HOME": "HOME", "END": "END", "TAB": "TAB",
        }
        key = norm.get(key, key)

        mods = {"ctrl": False, "alt": False, "shift": False, "oskey": False}
        for m in parts[:-1]:
            mm = MOD_SYNONYMS.get(m)
            if mm == "CTRL": mods["ctrl"] = True
            elif mm == "ALT": mods["alt"] = True
            elif mm == "SHIFT": mods["shift"] = True
            elif mm == "OSKEY": mods["oskey"] = True

        return mods, key, event_value

    def _get_area_bundle(area_type: str = "VIEW_3D", index: int | None = None):
        win = bpy.context.window
        if not win or not win.screen:
            return None
        areas = [a for a in win.screen.areas if a.type == area_type]
        if not areas:
            return None
        area = areas[index if (index is not None and 0 <= index < len(areas)) else 0]
        region = next((r for r in area.regions if r.type == 'WINDOW'), None)
        if not region:
            return None
        space = area.spaces.active if hasattr(area, "spaces") else None
        override = {
            "window": win,
            "screen": win.screen,
            "area": area,
            "region": region,
            "scene": bpy.context.scene,
            "view_layer": bpy.context.view_layer,
        }
        if space:
            override["space_data"] = space
            if getattr(space, "region_3d", None):
                override["region_3d"] = space.region_3d
        return win, area, region, override

    def _resolve_operator(idname: str):
        if "." not in idname:
            return None
        mod, op = idname.split(".", 1)
        mod_obj = getattr(bpy.ops, mod, None)
        return getattr(mod_obj, op, None) if mod_obj else None

    def _extract_non_default_props(kmi):
        props = {}
        try:
            kp = getattr(kmi, "properties", None)
            if not kp:
                return props
            for prop in kp.bl_rna.properties:
                if getattr(prop, "is_readonly", False):
                    continue
                pid = prop.identifier
                if pid in {"rna_type", "bl_rna"}:
                    continue
                if hasattr(kp, pid):
                    val = getattr(kp, pid)
                    if isinstance(val, (str, int, float, bool, tuple, list)):
                        try:
                            if hasattr(prop, "default"):
                                if val != prop.default:
                                    props[pid] = val
                            else:
                                props[pid] = val
                        except Exception:
                            props[pid] = val
        except Exception:
            return {}
        return props

    def _handle_view3d(mods, key, event_value, current_mode, override):
        """Return (operator_name, result_str) or None to fall back."""
        if event_value not in {"PRESS", "ANY"}:
            return None

        with bpy.context.temp_override(**override):
            if key == "H":
                try:
                    if current_mode.startswith("EDIT_"):
                        if mods["alt"]:
                            r = bpy.ops.mesh.reveal(select=False)
                            return "mesh.reveal", str(r)
                        else:
                            r = bpy.ops.mesh.hide(unselected=mods["shift"])
                            return "mesh.hide", str(r)
                    else:
                        if mods["alt"]:
                            r = bpy.ops.object.hide_view_clear()
                            return "object.hide_view_clear", str(r)
                        else:
                            r = bpy.ops.object.hide_view_set(unselected=mods["shift"])
                            return "object.hide_view_set", str(r)
                except Exception:
                    pass

            if key == "A" and not any(mods.values()):
                try:
                    if current_mode.startswith("EDIT_"):
                        r = bpy.ops.mesh.select_all(action='TOGGLE')
                        return "mesh.select_all", str(r)
                    else:
                        r = bpy.ops.object.select_all(action='TOGGLE')
                        return "object.select_all", str(r)
                except Exception:
                    pass

            if key == "HOME" and not any(mods.values()):
                try:
                    try:
                        r = bpy.ops.view3d.view_all(center=False)
                    except TypeError:
                        r = bpy.ops.view3d.view_all()
                    return "view3d.view_all", str(r)
                except Exception:
                    pass

            if key.startswith("NUMPAD_"):
                try:
                    num_map = {
                        "NUMPAD_1": ("FRONT", False),
                        "NUMPAD_3": ("RIGHT", False),
                        "NUMPAD_7": ("TOP", False),
                        "NUMPAD_2": ("FRONT", True),
                        "NUMPAD_4": ("LEFT", True),
                        "NUMPAD_6": ("RIGHT", True),
                        "NUMPAD_8": ("TOP", True),
                        "NUMPAD_5": (None, None),
                        "NUMPAD_0": (None, None),
                        "NUMPAD_PERIOD": (None, None),
                    }
                    if key in num_map:
                        view_type, is_orbit = num_map[key]
                        if mods["ctrl"] and view_type:
                            view_type = {"FRONT": "BACK", "RIGHT": "LEFT", "TOP": "BOTTOM"}[view_type]

                        if key == "NUMPAD_5":
                            try:
                                r = bpy.ops.view3d.view_persportho()
                                return "view3d.view_persportho", str(r)
                            except Exception:
                                area = override["area"]
                                space = area.spaces.active
                                if getattr(space, "region_3d", None):
                                    space.region_3d.is_perspective = not space.region_3d.is_perspective
                                    return "manual_perspective_toggle", "{'FINISHED'}"
                                return "view3d.view_persportho", "{'CANCELLED'}"

                        if key == "NUMPAD_0":
                            r = bpy.ops.view3d.view_camera()
                            return "view3d.view_camera", str(r)

                        if key == "NUMPAD_PERIOD":
                            r = bpy.ops.view3d.view_selected()
                            return "view3d.view_selected", str(r)

                        if view_type and not is_orbit:
                            r = bpy.ops.view3d.view_axis(type=view_type)
                            return "view3d.view_axis", str(r)

                        if view_type and is_orbit:
                            typ = {
                                "NUMPAD_2": 'ORBITDOWN',
                                "NUMPAD_8": 'ORBITUP',
                                "NUMPAD_4": 'ORBITLEFT',
                                "NUMPAD_6": 'ORBITRIGHT',
                            }[key]
                            r = bpy.ops.view3d.view_orbit(angle=radians(15 if key in {"NUMPAD_2", "NUMPAD_6"} else -15), type=typ)
                            return "view3d.view_orbit", str(r)
                except Exception:
                    pass

            if key in {"G", "R", "S"} and not any(mods.values()):
                try:
                    op = {"G": "transform.translate", "R": "transform.rotate", "S": "transform.resize"}[key]
                    r = getattr(bpy.ops.transform, op.split(".")[1])('INVOKE_DEFAULT')
                    return op, str(r)
                except Exception:
                    pass

            if key == "TAB" and not any(mods.values()):
                try:
                    if current_mode == "OBJECT":
                        r = bpy.ops.object.mode_set(mode='EDIT')
                    elif current_mode.startswith("EDIT_"):
                        r = bpy.ops.object.mode_set(mode='OBJECT')
                    else:
                        r = bpy.ops.object.mode_set(mode='OBJECT')
                    return "object.mode_set", str(r)
                except Exception:
                    pass

            if key == "F12" and not any(mods.values()):
                try:
                    r = bpy.ops.render.render('INVOKE_DEFAULT')
                    return "render.render", str(r)
                except Exception:
                    pass

            if key == "X" and not any(mods.values()):
                try:
                    if current_mode.startswith("EDIT_"):
                        r = bpy.ops.mesh.delete('INVOKE_DEFAULT')
                        return "mesh.delete", str(r)
                    else:
                        r = bpy.ops.object.delete('INVOKE_DEFAULT')
                        return "object.delete", str(r)
                except Exception:
                    pass

        return None

    try:
        if not isinstance(shortcut, str) or not shortcut.strip():
            return {"success": False, "error": "Invalid shortcut string"}

        mods, key, event_value = _normalize_shortcut(shortcut)
        bundle = _get_area_bundle(context_area, area_index)
        if not bundle:
            return {"success": False, "error": f"No {context_area} area/region found"}
        _, area, _, override = bundle

        current_mode = bpy.context.mode
        if prefer_mode != "AUTO" and prefer_mode != current_mode:
            try:
                bpy.ops.object.mode_set(mode=prefer_mode)
                current_mode = bpy.context.mode
            except Exception:
                pass

        if context_area == "VIEW_3D":
            handled = _handle_view3d(mods, key, event_value, current_mode, override)
            if handled is not None:
                op_name, res = handled
                return {
                    "success": True,
                    "shortcut": shortcut,
                    "operator": op_name,
                    "result": res,
                    "keymap": "Explicit",
                    "properties_used": [],
                    "context_area": context_area,
                    "event_value": event_value,
                    "mode": bpy.context.mode,
                }

        kc = bpy.context.window_manager.keyconfigs.active
        if not kc:
            return {"success": False, "error": "No active keyconfig"}

        allowed_names = KEYMAP_NAMES_BY_AREA.get(context_area, {"Screen", "Window"})
        candidates = []
        for km in kc.keymaps:
            try:
                if getattr(km, "name", "") not in allowed_names:
                    continue

                st = getattr(km, "space_type", "EMPTY")
                rt = getattr(km, "region_type", "EMPTY")
                if st not in {"EMPTY", context_area}:
                    continue
                if rt not in {"EMPTY", "", "WINDOW", "TEMPORARY"}:
                    continue

                for kmi in km.keymap_items:
                    if not kmi.active or kmi.type != key:
                        continue
                    if not (kmi.value == event_value or kmi.value == "ANY" or event_value == "ANY"):
                        continue
                    if (bool(kmi.ctrl)  != mods["ctrl"] or
                        bool(kmi.shift) != mods["shift"] or
                        bool(kmi.alt)   != mods["alt"]   or
                        bool(kmi.oskey) != mods["oskey"]):
                        continue

                    idname = kmi.idname.lower()
                    if context_area == "VIEW_3D" and any(idname.startswith(p) for p in DISALLOWED_PREFIXES_3DVIEW):
                        continue

                    op = _resolve_operator(kmi.idname)
                    if not op:
                        continue

                    score = 0
                    if context_area == "VIEW_3D":
                        if idname.startswith(("object.", "view3d.", "transform.", "mesh.", "screen.")):
                            score += 150
                        elif idname.startswith(("curve.", "surface.", "armature.")):
                            score += 100
                        elif idname.startswith(("paint.", "marker.", "uv.")):
                            score -= 200  
                    elif context_area == "TEXT_EDITOR":
                        if idname.startswith(("text.", "console.")):
                            score += 150
                    elif context_area == "IMAGE_EDITOR":
                        if idname.startswith(("image.", "uv.")):
                            score += 150

                    if current_mode == "OBJECT" and idname.startswith("object."):
                        score += 60
                    elif current_mode.startswith("EDIT_") and idname.startswith(("mesh.", "curve.", "surface.")):
                        score += 60
                    elif "PAINT" in current_mode and idname.startswith("paint."):
                        score += 30
                    elif "PAINT" not in current_mode and idname.startswith("paint."):
                        score -= 120

                    if rt == "WINDOW":
                        score += 10
                    if getattr(km, "space_type", "") == context_area:
                        score += 30

                    candidates.append((score, km, kmi, op))
            except Exception:
                continue

        if not candidates:
            return {"success": False, "error": f"No keymap entry for {shortcut} in {context_area} context"}

        candidates.sort(key=lambda x: x[0], reverse=True)

        picked = None
        for _, km, kmi, op in candidates[:6]:  
            try:
                with bpy.context.temp_override(**override):
                    if op.poll():
                        picked = (km, kmi, op)
                        break
            except Exception:
                continue
        if not picked:
            _, km, kmi, op = candidates[0]
        else:
            km, kmi, op = picked

        props = _extract_non_default_props(kmi)
        with bpy.context.temp_override(**override):
            try:
                res = op('INVOKE_DEFAULT', **props) if props else op('INVOKE_DEFAULT')
            except Exception:
                res = op('EXEC_DEFAULT', **props) if props else op('EXEC_DEFAULT')

        return {
            "success": True,
            "shortcut": shortcut,
            "operator": kmi.idname,
            "result": str(res),
            "keymap": getattr(km, "name", "Unknown"),
            "properties_used": sorted(list(props.keys())) if props else [],
            "context_area": context_area,
            "event_value": event_value,
            "mode": bpy.context.mode,
        }

    except Exception as e:
        return {"success": False, "error": f"Keyboard shortcut execution failed: {e}"}


@register_command('set_3d_cursor', description="Set the 3D cursor position")
def set_3d_cursor(location: List[float] = [0.0, 0.0, 0.0]) -> Dict[str, Any]:
    """Set the 3D cursor to a specific world coordinate location.
    
    Args:
        location: World coordinates [x, y, z] for the cursor position
        
    Returns:
        Dictionary with success status and cursor location
    """
    try:
        if not isinstance(location, (list, tuple)) or len(location) != 3:
            return {"success": False, "error": "Location must be a list/tuple of 3 numbers [x, y, z]"}
        
        try:
            location = [float(x) for x in location]
        except (ValueError, TypeError):
            return {"success": False, "error": "Location values must be numeric"}
        
        if not bpy.context.scene:
            return {"success": False, "error": "No active scene"}
            
        bpy.context.scene.cursor.location = location
        actual_location = list(bpy.context.scene.cursor.location)
        return {"success": True, "location": actual_location}
    except Exception as e:
        return {"success": False, "error": f"Set 3D cursor failed: {str(e)}"}


@register_command('capture_multiview_viewport', description="Capture multiple yaw angles of the viewport")
def capture_multiview_viewport(
    num_views: int = 6,
    yaw_degrees: float = 360.0,
    max_size: Optional[int] = None,
    format: str = 'PNG',
    quality: int = 95,
    area_index: Optional[int] = None,
    deterministic: bool = True,
    stitch: bool = False,
    return_image_data: bool = True,
    include_data_uri: bool = False,
    keep_file: bool = False
) -> Dict[str, Any]:
    """Capture multiple viewport screenshots at evenly spaced yaw rotations.
    
    Args:
        num_views: Number of rotation angles to capture
        yaw_degrees: Total rotation range in degrees
        max_size: Maximum dimension in pixels for resizing
        format: Output format (PNG, JPEG, WEBP)
        quality: JPEG/WEBP quality (1-100)
        area_index: Specific viewport index, or None for largest
        deterministic: Use consistent viewport settings
        stitch: Combine all views into a single grid image
        return_image_data: Include base64-encoded image data
        include_data_uri: Include data URI strings
        keep_file: Preserve temporary files on disk
        
    Returns:
        Dictionary with image array, angles, optional stitched result, and metadata
    """
    try:
        viewport = get_3d_viewport(area_index)
        if not viewport:
            return {"success": False, "error": "No 3D viewport found"}
        
        window, area, region = viewport
        space = area.spaces.active
        r3d = space.region_3d

        start_quat = r3d.view_rotation.copy()
        images: List[Dict[str, Any]] = []
        angles: List[float] = []
        step = (yaw_degrees / max(1, num_views)) if num_views > 0 else 0.0

        for i in range(num_views):
            yaw_angle = step * i
            yaw_rad = math.radians(yaw_angle)
            
            z_rotation = Euler((0.0, 0.0, yaw_rad), 'XYZ').to_quaternion()
            r3d.view_rotation = z_rotation @ start_quat
            bpy.context.view_layer.update()
            
            cap = capture_blender_3dviewport_screenshot(
                max_size=max_size,
                format=format,
                quality=quality,
                return_image_data=return_image_data,
                include_data_uri=include_data_uri,
                keep_file=keep_file,
                area_index=area_index,
                deterministic=deterministic,
            )
            if not cap.get("success"):
                return cap
            
            images.append(cap["data"]["image"])
            angles.append(yaw_angle)

        stitched = None
        if stitch and PIL_AVAILABLE and Image and images:
            cols = int(math.ceil(math.sqrt(len(images))))
            rows = int(math.ceil(len(images) / cols))
            
            b64 = images[0].get("data")
            if b64:
                first_bytes = base64.b64decode(b64)
                with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
                    tmp.write(first_bytes)
                    tmp.flush()
                    fp0 = tmp.name
                
                try:
                    with Image.open(fp0) as im0:
                        w0, h0 = im0.size
                    
                    grid = Image.new("RGB", (w0 * cols, h0 * rows), (0, 0, 0))
                    
                    for idx, img in enumerate(images):
                        b = img.get("data")
                        if not b:
                            continue
                        
                        bytes_i = base64.b64decode(b)
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as t2:
                            t2.write(bytes_i)
                            t2.flush()
                            path_i = t2.name
                        
                        try:
                            with Image.open(path_i) as imi:
                                col = idx % cols
                                row = idx // cols
                                grid.paste(imi.convert("RGB"), (col * w0, row * h0))
                        finally:
                            try:
                                os.remove(path_i)
                            except Exception:
                                pass
                    
                    temp_dir = tempfile.gettempdir()
                    ts = int(time.time() * 1000)
                    pid = os.getpid()
                    out_path, used_fmt = save_image(grid, format, quality, temp_dir, f"multiview_stitched_{pid}_{ts}")
                    
                    with open(out_path, 'rb') as f:
                        data_bytes = f.read()
                    
                    b64_data = encode_image(data_bytes) if return_image_data else None
                    
                    stitched = {
                        "path": out_path if keep_file else None,
                        "data": b64_data,
                        "data_uri": build_data_uri(used_fmt, b64_data) if include_data_uri and b64_data else None,
                    }
                    
                    if not keep_file:
                        try:
                            os.remove(out_path)
                        except Exception:
                            pass
                finally:
                    try:
                        os.remove(fp0)
                    except Exception:
                        pass

        r3d.view_rotation = start_quat

        return {
            "success": True,
            "data": {
                "images": images,
                "angles_degrees": angles,
                "stitched_image": stitched,
                "viewport_info": get_viewport_info(space, r3d),
                "metadata": {"type": "multiview_viewport"}
            }
        }
    except Exception as e:
        return {"success": False, "error": f"Multiview capture failed: {str(e)}"}


@register_command('project_objects_to_2d', description="Project object bounding boxes to 2D viewport coordinates")
def project_objects_to_2d(
    area_index: Optional[int] = None,
    only_visible: bool = True,
    include_types: Optional[List[str]] = None,
    exclude_types: Optional[List[str]] = None,
    include_objects: Optional[List[str]] = None,
    exclude_objects: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Project 3D object bounding boxes to 2D viewport pixel coordinates.
    
    Args:
        area_index: Specific viewport index, or None for largest
        only_visible: Only process visible objects in current layer
        include_types: Object types to include (MESH, CURVE, etc.)
        exclude_types: Object types to exclude
        include_objects: Specific object names to include
        exclude_objects: Specific object names to exclude
        
    Returns:
        Dictionary with 2D bounding boxes and visibility info for each object
    """
    try:
        viewport = get_3d_viewport(area_index)
        if not viewport:
            return {"success": False, "error": "No 3D viewport found"}
        
        window, area, region = viewport
        space = area.spaces.active
        r3d = space.region_3d
        scene = bpy.context.scene

        objs = bpy.context.visible_objects if only_visible else scene.objects

        include_types = [t.upper() for t in include_types] if include_types else None
        exclude_types = [t.upper() for t in exclude_types] if exclude_types else []
        include_set = set(include_objects) if include_objects else None
        exclude_set = set(exclude_objects) if exclude_objects else set()

        results: List[Dict[str, Any]] = []
        for obj in objs:
            if include_set is not None and obj.name not in include_set:
                continue
            if obj.name in exclude_set:
                continue
            
            t = obj.type.upper()
            if include_types is not None and t not in include_types:
                continue
            if t in exclude_types:
                continue
            
            try:
                corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
            except Exception:
                continue
            
            pts2d: List[Tuple[float, float]] = []
            for co in corners:
                v2 = view3d_utils.location_3d_to_region_2d(region, r3d, co)
                if v2 is not None:
                    pts2d.append((float(v2.x), float(v2.y)))
            
            if not pts2d:
                visible_2d = False
                bbox_px = None
            else:
                xs = [p[0] for p in pts2d]
                ys = [p[1] for p in pts2d]
                xmin, xmax = min(xs), max(xs)
                ymin, ymax = min(ys), max(ys)
                bbox_px = [xmin, ymin, xmax, ymax]
                rw, rh = region.width, region.height
                visible_2d = not (xmax < 0 or ymax < 0 or xmin > rw or ymin > rh)

            results.append({
                "name": obj.name,
                "object_type": t,
                "bbox_px": bbox_px,
                "visible_2d": bool(visible_2d),
                "dimensions": list(obj.dimensions) if hasattr(obj, 'dimensions') else None,
            })

        return {
            "success": True,
            "data": {
                "area_size": {"width": region.width, "height": region.height},
                "objects": results,
                "viewport_info": get_viewport_info(space, r3d),
                "metadata": {"type": "projection_2d"}
            }
        }
    except Exception as e:
        return {"success": False, "error": f"Projection failed: {str(e)}"}


@register_command('get_scene_summary', description="Get counts, extents, units, and camera info for the scene")
def get_scene_summary() -> Dict[str, Any]:
    """Generate a comprehensive summary of the current Blender scene.
    
    Returns:
        Dictionary containing object counts by type, bounding box extents,
        unit system settings, and active camera information
    """
    try:
        scene = bpy.context.scene
        counts: Dict[str, int] = {}
        min_v = Vector((float('inf'), float('inf'), float('inf')))
        max_v = Vector((float('-inf'), float('-inf'), float('-inf')))
        has_extents = False
        
        for obj in scene.objects:
            t = obj.type.upper()
            counts[t] = counts.get(t, 0) + 1
            try:
                corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
                for c in corners:
                    min_v.x = min(min_v.x, c.x)
                    min_v.y = min(min_v.y, c.y)
                    min_v.z = min(min_v.z, c.z)
                    max_v.x = max(max_v.x, c.x)
                    max_v.y = max(max_v.y, c.y)
                    max_v.z = max(max_v.z, c.z)
                has_extents = True
            except Exception:
                pass

        units = scene.unit_settings
        unit_info = {
            "system": units.system,
            "scale_length": units.scale_length,
            "length_unit": units.length_unit,
        }

        cam = scene.camera
        camera_info = None
        if cam and cam.type == 'CAMERA':
            cdata = cam.data
            camera_info = {
                "name": cam.name,
                "location": list(cam.location),
                "rotation_euler_degrees": [math.degrees(a) for a in cam.rotation_euler],
                "type": cdata.type,
                "lens_mm": getattr(cdata, 'lens', None),
                "sensor_width": getattr(cdata, 'sensor_width', None),
                "sensor_height": getattr(cdata, 'sensor_height', None),
            }

        return {
            "success": True,
            "data": {
                "counts": counts,
                "extents": {
                    "min": [min_v.x, min_v.y, min_v.z] if has_extents else None,
                    "max": [max_v.x, max_v.y, max_v.z] if has_extents else None,
                },
                "units": unit_info,
                "camera": camera_info,
                "metadata": {"type": "scene_summary"}
            }
        }
    except Exception as e:
        return {"success": False, "error": f"Scene summary failed: {str(e)}"}


def ensure_camera_exists() -> bool:
    """Ensure a camera exists in the scene, creating one if necessary.
    
    Checks for an active camera, then any camera in the scene, and finally
    creates a new camera positioned to view all scene objects if none exists.
    
    Returns:
        True if camera is available, False if creation failed
    """
    try:
        scene = bpy.context.scene
        if not scene:
            return False
        
        if scene.camera and scene.camera.type == 'CAMERA':
            return True
        
        for obj in scene.objects:
            if obj.type == 'CAMERA':
                scene.camera = obj
                return True
        
        try:
            bpy.ops.object.camera_add()
            cam_obj = bpy.context.active_object
            if not cam_obj or cam_obj.type != 'CAMERA':
                return False
                
            scene.camera = cam_obj
            
            if scene.objects:
                min_v = Vector((float('inf'), float('inf'), float('inf')))
                max_v = Vector((float('-inf'), float('-inf'), float('-inf')))
                has_objects = False
                
                for obj in scene.objects:
                    if obj.type in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT'} and obj != cam_obj:
                        try:
                            if hasattr(obj, 'bound_box') and hasattr(obj, 'matrix_world'):
                                corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
                                for c in corners:
                                    min_v.x = min(min_v.x, c.x)
                                    min_v.y = min(min_v.y, c.y)
                                    min_v.z = min(min_v.z, c.z)
                                    max_v.x = max(max_v.x, c.x)
                                    max_v.y = max(max_v.y, c.y)
                                    max_v.z = max(max_v.z, c.z)
                                has_objects = True
                        except Exception:
                            continue
                
                if has_objects and min_v.x != float('inf'):
                    center = (min_v + max_v) / 2
                    size = max_v - min_v
                    distance = max(size.x, size.y, size.z) * 2.5
                    
                    cam_obj.location = center + Vector((distance, -distance, distance * 0.7))
                    direction = center - cam_obj.location
                    if direction.length > 0:
                        cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
                else:
                    cam_obj.location = Vector((7.5, -7.5, 5.0))
                    cam_obj.rotation_euler = Euler((1.1, 0, 0.785), 'XYZ')
            
            return True
        except Exception as e:
            print(f"Camera creation failed: {e}")
            return False
            
    except Exception as e:
        print(f"Camera ensure failed: {e}")
        return False


@register_command('add_camera_to_scene', description="Add a camera to the scene positioned to view all objects")
def add_camera_to_scene() -> Dict[str, Any]:
    """Add a camera to the scene and position it to frame all visible objects.
    
    Returns:
        Dictionary with success status, confirmation message, and camera details
    """
    try:
        if ensure_camera_exists():
            scene = bpy.context.scene
            cam = scene.camera
            return {
                "success": True,
                "message": "Camera added and positioned successfully",
                "camera_info": {
                    "name": cam.name,
                    "location": list(cam.location),
                    "rotation_euler_degrees": [math.degrees(a) for a in cam.rotation_euler],
                }
            }
        else:
            return {"success": False, "error": "Failed to add camera to scene"}
    except Exception as e:
        return {"success": False, "error": f"Add camera failed: {str(e)}"}


@register_command('capture_render_with_passes', description="Render the scene and save multilayer EXR passes and a PNG preview")
def capture_render_with_passes(
    enable_depth: bool = True,
    enable_normal: bool = True,
    enable_object_index: bool = False,
    keep_files: bool = False,
    auto_add_camera: bool = True,
) -> Dict[str, Any]:
    """Render the scene with multiple render passes saved to EXR and PNG formats.
    
    Args:
        enable_depth: Include depth/Z-buffer pass in EXR
        enable_normal: Include normal vector pass in EXR  
        enable_object_index: Include object index pass in EXR
        keep_files: Preserve rendered files on disk
        auto_add_camera: Automatically create camera if none exists
        
    Returns:
        Dictionary with file paths, sizes, preview data, and render metadata
    """
    try:
        scene = bpy.context.scene
        view_layer = bpy.context.view_layer

        if auto_add_camera:
            if not ensure_camera_exists():
                return {"success": False, "error": "No camera available and failed to create one"}
        else:
            if not scene.camera or scene.camera.type != 'CAMERA':
                return {"success": False, "error": "No camera in scene. Add a camera or set auto_add_camera=True"}

        prev_depth = getattr(view_layer, 'use_pass_z', False)
        prev_normal = getattr(view_layer, 'use_pass_normal', False)
        prev_index = getattr(view_layer, 'use_pass_object_index', False)
        prev_format = scene.render.image_settings.file_format
        prev_filepath = scene.render.filepath
        prev_color_mode = scene.render.image_settings.color_mode

        temp_dir = tempfile.gettempdir()
        ts = int(time.time() * 1000)
        pid = os.getpid()
        exr_path = os.path.join(temp_dir, f"render_passes_{pid}_{ts}.exr")
        png_path = os.path.join(temp_dir, f"render_preview_{pid}_{ts}.png")

        try:
            if hasattr(view_layer, 'use_pass_z'):
                view_layer.use_pass_z = bool(enable_depth)
            if hasattr(view_layer, 'use_pass_normal'):
                view_layer.use_pass_normal = bool(enable_normal)
            if hasattr(view_layer, 'use_pass_object_index'):
                view_layer.use_pass_object_index = bool(enable_object_index)
        except Exception as e:
            return {"success": False, "error": f"Failed to set render passes: {str(e)}"}

        scene.render.image_settings.file_format = 'OPEN_EXR_MULTILAYER'
        scene.render.filepath = exr_path
        
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as e:
            return {"success": False, "error": f"Render operation failed: {str(e)}"}

        if not os.path.exists(exr_path):
            return {"success": False, "error": "EXR render file was not created"}

        try:
            prev_png_format = scene.render.image_settings.file_format
            prev_png_color_mode = scene.render.image_settings.color_mode
            prev_png_depth = scene.render.image_settings.color_depth
            
            scene.render.image_settings.file_format = 'PNG'
            scene.render.image_settings.color_mode = 'RGBA'
            scene.render.image_settings.color_depth = '8'
            
            rr = bpy.data.images.get('Render Result')
            if rr:
                rr.save_render(png_path)
                if not os.path.exists(png_path) or os.path.getsize(png_path) == 0:
                    return {"success": False, "error": "PNG file was not created properly"}
            else:
                return {"success": False, "error": "No render result available for PNG preview"}
            
            scene.render.image_settings.file_format = prev_png_format
            scene.render.image_settings.color_mode = prev_png_color_mode
            scene.render.image_settings.color_depth = prev_png_depth
            
        except Exception as e:
            return {"success": False, "error": f"Failed to save PNG preview: {str(e)}"}

        result: Dict[str, Any] = {
            "success": True,
            "data": {
                "exr_path": exr_path if keep_files else None,
                "png_path": png_path if keep_files else None,
                "exr_size_kb": round(os.path.getsize(exr_path) / 1024, 2) if os.path.exists(exr_path) else None,
                "png_size_kb": round(os.path.getsize(png_path) / 1024, 2) if os.path.exists(png_path) else None,
                "preview": None,
                "metadata": {"type": "render_with_passes"}
            }
        }

        if os.path.exists(png_path):
            try:
                with open(png_path, 'rb') as f:
                    bytes_png = f.read()
                result["data"]["preview"] = {
                    "data": encode_image(bytes_png),
                    "data_uri": build_data_uri('PNG', encode_image(bytes_png)),
                }
                result["message"] = f"Rendered successfully. PNG: {result['data']['png_size_kb']}KB, EXR: {result['data']['exr_size_kb']}KB"
            except Exception as e:
                result["warning"] = f"Failed to encode PNG preview: {str(e)}"

        if not keep_files:
            try:
                if os.path.exists(exr_path):
                    os.remove(exr_path)
                if os.path.exists(png_path):
                    os.remove(png_path)
            except Exception:
                pass

        return result
        
    except Exception as e:
        return {"success": False, "error": f"Render with passes failed: {str(e)}"}
    finally:
        try:
            scene = bpy.context.scene
            view_layer = bpy.context.view_layer
            
            if hasattr(view_layer, 'use_pass_z'):
                view_layer.use_pass_z = prev_depth
            if hasattr(view_layer, 'use_pass_normal'):
                view_layer.use_pass_normal = prev_normal
            if hasattr(view_layer, 'use_pass_object_index'):
                view_layer.use_pass_object_index = prev_index
                
            scene.render.image_settings.file_format = prev_format
            scene.render.filepath = prev_filepath
            scene.render.image_settings.color_mode = prev_color_mode
        except Exception:
            pass
