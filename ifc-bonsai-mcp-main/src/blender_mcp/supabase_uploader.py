"""Storage uploader for IFC files (AWS S3 with Supabase fallback).

Uploads the current IFC project file to AWS S3 so the frontend
can fetch and display it automatically with zero database timeouts and high availability.
"""

import os
import time
import logging
import hashlib
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

logger = logging.getLogger("StorageUploader")

S3_BUCKET = os.environ.get("S3_BUCKET", "infrastudio-ifc-models-us-east-1")
S3_REGION = os.environ.get("AWS_REGION", "us-east-1")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pzeoilvqeyuheslkfhjq.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc"
)
BUCKET_NAME = "ifc-models"
DEFAULT_IFC_PATH = "new_project.ifc"


def _get_ifc_file_path() -> str:
    """Resolve the path to the current IFC file on disk."""
    try:
        from bonsai.bim.ifc import IfcStore
        if IfcStore.path:
            return IfcStore.path
    except Exception:
        pass
    return DEFAULT_IFC_PATH


def upload_ifc_to_supabase(session_id: str = "default") -> dict:
    """Upload the current IFC file to AWS S3 (primary) with Supabase fallback."""
    ifc_path = _get_ifc_file_path()

    if not os.path.isfile(ifc_path):
        error_msg = f"IFC file not found at: {ifc_path}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}

    file_size = os.path.getsize(ifc_path)
    session_hash = hashlib.md5(session_id.encode()).hexdigest()[:8]
    storage_path = f"models/{session_hash}/model.ifc"

    # 1. PRIMARY: AWS S3 Upload (High Availability, zero database timeout)
    try:
        import boto3
        s3 = boto3.client("s3", region_name=S3_REGION)
        s3.upload_file(
            ifc_path,
            S3_BUCKET,
            storage_path,
            ExtraArgs={"ContentType": "application/octet-stream"}
        )
        s3_url = f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{storage_path}?t={int(time.time())}"
        logger.info(f"IFC file successfully uploaded to S3: {s3_url}")
        return {
            "success": True,
            "file_url": s3_url,
            "storage_path": storage_path,
            "file_size": file_size,
        }
    except Exception as s3_err:
        logger.warning(f"S3 upload failed ({s3_err}), falling back to Supabase...")

    # 2. FALLBACK: Supabase Storage
    try:
        with open(ifc_path, "rb") as f:
            file_data = f.read()
        upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{storage_path}"
        headers = {
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/octet-stream",
            "x-upsert": "true",
        }
        req = Request(upload_url, data=file_data, headers=headers, method="POST")
        response = urlopen(req, timeout=15)
        public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{storage_path}?t={int(time.time())}"
        return {
            "success": True,
            "file_url": public_url,
            "storage_path": storage_path,
            "file_size": file_size,
        }
    except Exception as sb_err:
        error_msg = f"Both S3 and Supabase uploads failed: {sb_err}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}
