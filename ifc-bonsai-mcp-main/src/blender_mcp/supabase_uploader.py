"""Supabase Storage uploader for IFC files.

Uploads the current IFC project file to Supabase Storage so the frontend
can fetch and display it automatically.
"""

import os
import time
import logging
import hashlib
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

logger = logging.getLogger("SupabaseUploader")

# Configuration from environment variables
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://gitfkenmwzrldzqunvww.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU"
)
BUCKET_NAME = "ifc-models"

# Default IFC file path (matches project.py's IfcStore.path)
DEFAULT_IFC_PATH = "new_project.ifc"


def _get_ifc_file_path() -> str:
    """Resolve the path to the current IFC file on disk."""
    # Try IfcStore.path first (the Bonsai-managed path)
    try:
        from bonsai.bim.ifc import IfcStore
        if IfcStore.path:
            return IfcStore.path
    except Exception:
        pass

    # Fallback to default
    return DEFAULT_IFC_PATH


def upload_ifc_to_supabase(session_id: str = "default") -> dict:
    """Upload the current IFC file to Supabase Storage.

    Args:
        session_id: An identifier for the current session, used in the
                    storage path to namespace files.

    Returns:
        dict with keys:
            - success (bool)
            - file_url (str): Public URL of the uploaded file
            - error (str): Error message if upload failed
    """
    ifc_path = _get_ifc_file_path()

    # Verify file exists
    if not os.path.isfile(ifc_path):
        error_msg = f"IFC file not found at: {ifc_path}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}

    # Read the file
    try:
        with open(ifc_path, "rb") as f:
            file_data = f.read()
    except Exception as e:
        error_msg = f"Failed to read IFC file: {e}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}

    file_size = len(file_data)
    logger.info(f"Read IFC file: {ifc_path} ({file_size} bytes)")

    # Generate storage path: models/{session_hash}/model.ifc
    # Using a stable name per session so updates overwrite the previous version
    session_hash = hashlib.md5(session_id.encode()).hexdigest()[:8]
    storage_path = f"models/{session_hash}/model.ifc"

    # Upload to Supabase Storage REST API
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{storage_path}"

    headers = {
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",  # Overwrite if exists
    }

    try:
        req = Request(upload_url, data=file_data, headers=headers, method="POST")
        response = urlopen(req, timeout=60)
        response_body = response.read().decode("utf-8")
        logger.info(f"Upload response ({response.status}): {response_body[:200]}")
    except HTTPError as e:
        # If 409 (duplicate), try PUT to update
        if e.code == 409:
            logger.info("File exists, attempting upsert via PUT...")
            try:
                put_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{storage_path}"
                req = Request(put_url, data=file_data, headers=headers, method="PUT")
                response = urlopen(req, timeout=60)
                response_body = response.read().decode("utf-8")
                logger.info(f"PUT response ({response.status}): {response_body[:200]}")
            except Exception as put_err:
                error_msg = f"Failed to upsert IFC file: {put_err}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg}
        else:
            error_body = e.read().decode("utf-8") if e.fp else ""
            error_msg = f"Supabase upload failed (HTTP {e.code}): {error_body[:300]}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    except (URLError, Exception) as e:
        error_msg = f"Upload request failed: {e}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}

    # Build the public URL
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{storage_path}"

    # Add cache-busting timestamp
    public_url_with_ts = f"{public_url}?t={int(time.time())}"

    logger.info(f"IFC file uploaded successfully: {public_url_with_ts}")
    return {
        "success": True,
        "file_url": public_url_with_ts,
        "storage_path": storage_path,
        "file_size": file_size,
    }
