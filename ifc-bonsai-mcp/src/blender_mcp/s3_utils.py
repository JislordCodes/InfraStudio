import os
import time
import threading
import logging
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger("BlenderMCP.S3Sync")

# Configuration
S3_BUCKET = os.environ.get("AWS_S3_IFC_BUCKET")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
IFC_FILE_PATH = "/app/model.ifc"

_last_modified_time = 0
_s3_upload_thread = None
_s3_client = None

def get_s3_client():
    global _s3_client
    if not _s3_client and S3_BUCKET:
        try:
            _s3_client = boto3.client('s3', region_name=AWS_REGION)
        except Exception as e:
            logger.error(f"Failed to initialize Boto3 S3 client: {e}")
    return _s3_client

def upload_if_changed():
    """Checks if model.ifc changed and uploads to S3 in the background."""
    global _last_modified_time, _s3_upload_thread
    
    if not S3_BUCKET:
        return # S3 sync not configured
        
    if not os.path.exists(IFC_FILE_PATH):
        return
        
    current_mtime = os.path.getmtime(IFC_FILE_PATH)
    if current_mtime > _last_modified_time:
        _last_modified_time = current_mtime
        
        # Upload in background to not block the MCP server response
        if _s3_upload_thread is None or not _s3_upload_thread.is_alive():
            _s3_upload_thread = threading.Thread(target=_do_upload)
            _s3_upload_thread.daemon = True
            _s3_upload_thread.start()

def _do_upload():
    """Actual upload logic"""
    s3 = get_s3_client()
    if not s3:
        return
        
    file_key = "model.ifc" 
    
    logger.info(f"Model changed. Uploading to S3 bucket {S3_BUCKET}...")
    try:
        # Upload file
        s3.upload_file(
            Filename=IFC_FILE_PATH,
            Bucket=S3_BUCKET,
            Key=file_key,
            ExtraArgs={'ContentType': 'application/x-step'}
        )
        url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{file_key}"
        logger.info(f"Successfully uploaded to S3: {url}")
    except ClientError as e:
        logger.error(f"Failed to upload to S3: {e}")
    except Exception as e:
        logger.error(f"Unexpected error uploading to S3: {e}")

def get_public_url():
    """Returns the expected public S3 URL of the model"""
    if not S3_BUCKET:
        return None
    return f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/model.ifc"
