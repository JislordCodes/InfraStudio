"""
Lightweight local embeddings HTTP server compatible with the MCP RemoteEmbeddings client.

Why
----
Run sentence-transformers in a dedicated Python process so your MCP server never loads
Hugging Face models. This avoids blocking the MCP main thread and allows you to scale or
restart embeddings independently.

Features
--------
- Single-file FastAPI server using SentenceTransformer
- Compatible with the MCP RemoteEmbeddings client added in this repo
- Endpoints:
  - POST /embeddings       -> {"embeddings": [[...], ...]}
  - POST /v1/embeddings    -> OpenAI-style {"data": [{"embedding": [...]}]}
  - GET  /health           -> health info, model name, device
- Accepts inputs in multiple shapes: {"inputs": [...]}, {"texts": [...]}, {"input": "..."}
- CPU by default; auto-selects CUDA/MPS if available when --device auto
- Respects local cache dir and offline mode (no network) if configured

Usage
-----
pip install fastapi uvicorn sentence-transformers torch
python scripts/embedding_server.py --model sentence-transformers/all-MiniLM-L6-v2 --host 127.0.0.1 --port 8080 --offline

Point the MCP to it:
  BLENDER_MCP_REMOTE_EMBEDDINGS_URL=http://127.0.0.1:8080/embeddings

Notes
-----
- For large corpora, consider increasing --batch-size for throughput; lower it if you run out of memory.
- Set HF_HUB_OFFLINE=1 to force local-only model loading (requires model present in the cache_dir or at local path).
- On Windows, run with: python scripts\\embedding_server.py ...
"""

from __future__ import annotations

import os
import argparse
import logging
import time
from typing import List, Dict, Any, Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import uvicorn


logger = logging.getLogger("embeddings_server")


def _resolve_device(preference: str = "cpu") -> str:
    preference = (preference or "cpu").lower()
    if preference == "auto":
        try:
            import torch  # type: ignore
            if hasattr(torch, "cuda") and torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return "mps"
        except Exception:
            pass
        return "cpu"
    return preference


def _load_model(model_id: str, cache_dir: str | None, device: str, offline: bool) -> Any:
    from sentence_transformers import SentenceTransformer  # type: ignore

    model_kwargs: Dict[str, Any] = {}
    if offline:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        model_kwargs["local_files_only"] = True

    logger.info(f"Loading model '{model_id}' on device '{device}'")
    t0 = time.time()
    model = SentenceTransformer(model_id, device=device, cache_folder=cache_dir, **model_kwargs)
    logger.info(f"Model loaded in {time.time() - t0:.2f}s")
    return model


def create_app(model_id: str, cache_dir: str | None, device: str, normalize: bool, batch_size: int, offline: bool) -> FastAPI:
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("transformers").setLevel(logging.WARNING)
    logging.getLogger("huggingface_hub").setLevel(logging.WARNING)

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    model = _load_model(model_id=model_id, cache_dir=cache_dir, device=device, offline=offline)

    app = FastAPI(title="Local Embeddings Server", version="1.0.0")

    @app.get("/health")
    async def health() -> Dict[str, Any]:
        return {
            "status": "ok",
            "model": model_id,
            "device": device,
            "normalize": normalize,
            "batch_size": batch_size,
            "offline": offline,
        }

    def _coerce_inputs(payload: Dict[str, Any]) -> List[str]:
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="JSON body must be an object")

        if "inputs" in payload:
            val = payload["inputs"]
        elif "texts" in payload:
            val = payload["texts"]
        elif "input" in payload:
            val = payload["input"]
        else:
            raise HTTPException(status_code=400, detail="Provide 'inputs', 'texts', or 'input'")

        if isinstance(val, str):
            return [val]
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return val
        raise HTTPException(status_code=400, detail="Inputs must be a string or list of strings")

    def _encode(texts: List[str], normalize_override: Union[None, bool]) -> List[List[float]]:
        use_normalize = normalize if normalize_override is None else bool(normalize_override)
        vectors: List[List[float]] = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i:i + batch_size]
            embs = model.encode(
                chunk,
                normalize_embeddings=use_normalize,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            vectors.extend(embs.tolist())
        return vectors

    @app.post("/embeddings")
    async def embeddings(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")

        texts = _coerce_inputs(payload)
        normalize_override = payload.get("normalize") if isinstance(payload, dict) else None
        vectors = _encode(texts, normalize_override)
        return JSONResponse({"embeddings": vectors})

    @app.post("/v1/embeddings")
    async def embeddings_openai(request: Request) -> JSONResponse:
        """OpenAI-compatible response shape.
        Accepts {"input": "..."} or {"input": ["..."]}, optional {"model": "..."}
        Returns {"data": [{"embedding": [...], "index": i}], "model": model_id}
        """
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")

        texts = _coerce_inputs(payload)
        normalize_override = payload.get("normalize") if isinstance(payload, dict) else None
        vectors = _encode(texts, normalize_override)
        data = [{"embedding": vec, "index": i} for i, vec in enumerate(vectors)]
        return JSONResponse({"data": data, "model": model_id, "object": "list"})

    return app


def main():
    parser = argparse.ArgumentParser(description="Run a local embeddings server for sentence-transformers")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2", help="Model id or local path")
    parser.add_argument("--cache-dir", default=None, help="Hugging Face cache directory")
    parser.add_argument("--device", default="cpu", help="cpu|cuda|mps|auto")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8080, help="Bind port")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size for encode()")
    parser.add_argument("--normalize", action="store_true", help="Normalize embeddings (recommended)")
    parser.add_argument("--offline", action="store_true", help="Force offline model loading (no downloads)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    device = _resolve_device(args.device)
    app = create_app(
        model_id=args.model,
        cache_dir=args.cache_dir,
        device=device,
        normalize=args.normalize,
        batch_size=args.batch_size,
        offline=args.offline,
    )

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

