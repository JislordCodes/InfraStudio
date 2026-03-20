'''
MCP tools for Blender analysis and viewport manipulation
'''

from mcp.server.fastmcp import Context, Image
import base64
from ..server import logger, get_blender_connection
from ..mcp_instance import mcp

@mcp.tool()
def capture_blender_window_screenshot(
    ctx: Context, 
    max_size: int = None, 
    format: str = "PNG", 
    quality: int = 95,
    return_image_data: bool = True,
    include_data_uri: bool = False,
    keep_file: bool = False
) -> Image:
    """
    Capture a screenshot of the current Blender application window with high quality options.
    
    Parameters:
    - max_size: Maximum size in pixels for the largest dimension (None = full resolution, recommended for text analysis)
    - format: Image format - "PNG" (lossless, default), "JPEG" (smaller files), or "WEBP"
    - quality: JPEG/WEBP quality 1-100 (only used for JPEG/WEBP format, default: 95)
    - return_image_data: Include base64-encoded image data
    - include_data_uri: Include data URI string
    - keep_file: Preserve temporary files on disk
    
    Returns the screenshot as an Image.
    
    Usage examples:
    - capture_blender_window_screenshot() -> Full resolution PNG (best quality)
    - capture_blender_window_screenshot(max_size=4000) -> 4K max PNG 
    - capture_blender_window_screenshot(max_size=2000, format="JPEG", quality=90) -> 2K JPEG
    """
    try:
        blender = get_blender_connection()
        params = {
            "format": format, 
            "quality": quality,
            "return_image_data": return_image_data,
            "include_data_uri": include_data_uri,
            "keep_file": keep_file
        }
        if max_size is not None:
            params["max_size"] = max_size
        result = blender.send_command("capture_blender_window_screenshot", params)
        
        if not result.get("success", False):
            raise Exception(result.get("error", "Unknown error"))
        
        data = result.get("data", {})
        image_data_b64 = data.get("image", {}).get("data")
        if not image_data_b64:
            raise Exception("No image data returned from Blender")
        
        image_data = base64.b64decode(image_data_b64)
        img_format = data.get("encoding", {}).get("format", "PNG").lower()
        
        dimensions = data.get("dimensions", {})
        encoding = data.get("encoding", {})
        logger.info(f"Screenshot captured: {dimensions.get('width', 'unknown')}x{dimensions.get('height', 'unknown')} "
                   f"({encoding.get('file_size_kb', 0):.1f}KB, {img_format.upper()})")
        
        return Image(data=image_data, format=img_format)
        
    except Exception as e:
        logger.error(f"Error capturing Blender screenshot: {str(e)}")
        raise Exception(f"Screenshot capture failed: {str(e)}")

@mcp.tool()
def capture_blender_3dviewport_screenshot(
    ctx: Context, 
    max_size: int = None, 
    format: str = "PNG", 
    quality: int = 95,
    return_image_data: bool = True,
    include_data_uri: bool = False,
    keep_file: bool = False,
    area_index: int = None,
    shading_type: str = None,
    show_overlays: bool = None,
    show_gizmo: bool = None,
    deterministic: bool = False
) -> Image:
    """
    Capture a screenshot of only the Blender 3D viewport (excluding UI panels).
    
    Parameters:
    - max_size: Maximum size in pixels for the largest dimension (None = full resolution)
    - format: Image format - "PNG" (lossless, default), "JPEG" (smaller files), or "WEBP"
    - quality: JPEG/WEBP quality 1-100 (only used for JPEG/WEBP format, default: 95)
    - return_image_data: Include base64-encoded image data
    - include_data_uri: Include data URI string
    - keep_file: Preserve temporary files on disk
    - area_index: Specific viewport index, or None for largest
    - shading_type: Override viewport shading mode
    - show_overlays: Override overlay visibility
    - show_gizmo: Override gizmo visibility
    - deterministic: Use consistent viewport settings for reproducible results
    
    Returns the viewport screenshot as an Image with additional viewport metadata.
    
    Usage examples:
    - capture_blender_3dviewport_screenshot() -> Full resolution PNG of 3D viewport
    - capture_blender_3dviewport_screenshot(max_size=1920, format="JPEG", quality=85) -> HD JPEG
    
    This captures only the 3D scene content without Blender's UI, perfect for analyzing 
    the actual 3D model, geometry, and spatial relationships.
    """
    try:
        blender = get_blender_connection()
        params = {
            "format": format, 
            "quality": quality,
            "return_image_data": return_image_data,
            "include_data_uri": include_data_uri,
            "keep_file": keep_file,
            "deterministic": deterministic
        }
        if max_size is not None:
            params["max_size"] = max_size
        if area_index is not None:
            params["area_index"] = area_index
        if shading_type is not None:
            params["shading_type"] = shading_type
        if show_overlays is not None:
            params["show_overlays"] = show_overlays
        if show_gizmo is not None:
            params["show_gizmo"] = show_gizmo
            
        result = blender.send_command("capture_blender_3dviewport_screenshot", params)
        
        if not result.get("success", False):
            raise Exception(result.get("error", "Unknown error"))
        
        data = result.get("data", {})
        image_data_b64 = data.get("image", {}).get("data")
        if not image_data_b64:
            raise Exception("No image data returned from Blender")
            
        image_data = base64.b64decode(image_data_b64)
        img_format = data.get("encoding", {}).get("format", "PNG").lower()
        
        dimensions = data.get("dimensions", {})
        encoding = data.get("encoding", {})
        viewport_info = data.get("viewport_info", {})
        logger.info(f"3D Viewport screenshot captured: {dimensions.get('width', 'unknown')}x{dimensions.get('height', 'unknown')} "
                   f"({encoding.get('file_size_kb', 0):.1f}KB, {img_format.upper()}) - "
                   f"Shading: {viewport_info.get('shading_type', 'N/A')}, "
                   f"View: {viewport_info.get('view_perspective', 'N/A')}")
        
        return Image(data=image_data, format=img_format)
        
    except Exception as e:
        logger.error(f"Error capturing 3D viewport screenshot: {str(e)}")
        raise Exception(f"3D viewport screenshot capture failed: {str(e)}")
