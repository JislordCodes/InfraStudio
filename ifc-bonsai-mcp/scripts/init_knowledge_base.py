"""
IFC Knowledge Base Initialization Module.

This module provides functionality to initialize or rebuild the IFC knowledge base
for the Blender MCP server. It handles downloading and caching of embedding models
and builds the Chroma vector index for semantic search capabilities.

The script performs the following operations:
- Ensures a local Hugging Face cache at <project>/.cache/huggingface
- Downloads the sentence-transformers model to the cache
- Builds (or rebuilds) the Chroma vector index with IFC documentation

Usage:
    python scripts/init_knowledge_base.py
    python scripts/init_knowledge_base.py --force-rebuild
    python scripts/init_knowledge_base.py --model sentence-transformers/all-mpnet-base-v2
    python scripts/init_knowledge_base.py --cache-dir C:\\models\\hf_cache

Attributes:
    project_root: Path to the project root directory
    default_cache: Default cache directory for Hugging Face models
    default_persist: Default persistence directory for Chroma database
"""

import sys
import os
import argparse
import logging
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.blender_mcp.rag import IFCKnowledgeStore


def setup_logging() -> None:
    """Configure logging levels and suppress known warnings."""
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    logging.getLogger('urllib3').setLevel(logging.WARNING)
    logging.getLogger('huggingface_hub').setLevel(logging.WARNING)
    logging.getLogger('transformers').setLevel(logging.WARNING)
    logging.getLogger('sentence_transformers').setLevel(logging.INFO)
    try:
        from langchain_core._api.deprecation import LangChainDeprecationWarning  # type: ignore
        warnings.filterwarnings('ignore', category=LangChainDeprecationWarning)
    except Exception:
        pass
    warnings.filterwarnings('ignore', message='Xet Storage is enabled*')


def ensure_model_cached(model_id: str, cache_dir: Path) -> None:
    """
    Download the sentence-transformers model into cache_dir if not present.

    Args:
        model_id: HuggingFace model identifier or local path
        cache_dir: Directory to cache the model files

    Raises:
        ImportError: If sentence-transformers is not installed
    """
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        logging.info(f"Ensuring model cached: {model_id}")
        logging.info(f"Cache: {cache_dir}")
        cache_dir.mkdir(parents=True, exist_ok=True)
        _ = SentenceTransformer(model_id, device='cpu', cache_folder=str(cache_dir))
    except ImportError:
        logging.error("sentence-transformers not installed. Install with: pip install sentence-transformers")
        raise


def build_index(persist_dir: Path, force_rebuild: bool) -> IFCKnowledgeStore:
    """
    Build the Chroma vector index with the configured embeddings and cache.

    Args:
        persist_dir: Directory to persist the Chroma database
        force_rebuild: Whether to force rebuild existing index

    Returns:
        IFCKnowledgeStore: Initialized knowledge store instance
    """
    store = IFCKnowledgeStore(persist_directory=persist_dir)
    store.build_index(force_rebuild=force_rebuild)
    return store


def main():
    parser = argparse.ArgumentParser(description="Initialize IFC knowledge base and cache embeddings")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2", help="Sentence-transformers model id or local path")
    parser.add_argument("--cache-dir", default=None, help="Hugging Face/SentenceTransformers cache directory")
    parser.add_argument("--persist-dir", default=None, help="Chroma persist directory for the index")
    parser.add_argument("--force-rebuild", action="store_true", help="Force rebuild the vector index")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    default_cache = project_root / ".cache" / "huggingface"
    default_persist = project_root / ".cache" / "chromadb"

    cache_dir = Path(args.cache_dir) if args.cache_dir else default_cache
    persist_dir = Path(args.persist_dir) if args.persist_dir else default_persist

    setup_logging()
    logging.info("Initializing IFC Knowledge Base for RAG...")
    logging.info("-" * 60)

    os.environ["BLENDER_MCP_EMBEDDING_MODEL"] = args.model
    os.environ["BLENDER_MCP_EMBEDDING_CACHE"] = str(cache_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(cache_dir))
    os.environ.setdefault("HF_HOME", str(cache_dir))
    os.environ["BLENDER_MCP_EMBEDDING_OFFLINE"] = "0"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    ensure_model_cached(args.model, cache_dir)
    store = build_index(persist_dir, force_rebuild=args.force_rebuild)
    stats = store.get_stats()

    logging.info("")
    logging.info("Knowledge base initialized successfully!")
    logging.info(f"Documents indexed: {stats.get('document_count', 0)}")
    logging.info(f"Embedding model: {stats.get('embedding_model')} -> {args.model}")
    logging.info(f"Embeddings cache: {cache_dir}")
    logging.info(f"Chroma storage:  {persist_dir}")

    try:
        results = store.search("create wall", k=3)
        logging.info("")
        logging.info(f"Smoke test: 'create wall' -> {len(results)} results")
        if results:
            r0 = results[0]
            logging.info(f"Top result: module={r0['metadata'].get('module')}, function={r0['metadata'].get('function')}, type={r0['metadata'].get('type')}")
    except Exception as e:
        logging.warning(f"Search smoke test failed (non-fatal): {e}")

    logging.info("")
    logging.info("Done. Runtime will reuse this cache and index.")
    logging.info("-" * 60)


if __name__ == "__main__":
    main()
