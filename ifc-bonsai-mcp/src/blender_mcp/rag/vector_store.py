"""
Vector store for IFC knowledge base using ChromaDB and LangChain.

Offline-aware embedding loading:
- Uses env var `BLENDER_MCP_EMBEDDING_MODEL` to override model (Hugging Face ID or local path).
- Uses env var `BLENDER_MCP_EMBEDDING_CACHE` to point to a local cache folder.
- If `BLENDER_MCP_EMBEDDING_OFFLINE=1`, will not attempt to download models and will
  raise a clear error if the model is unavailable locally.

Important: Do not print to stdout from MCP servers. Replace any print calls with
logging so that messages go to stderr and do not corrupt the MCP stdio transport.
"""

import os
from typing import List, Dict, Any, Optional
from pathlib import Path
import json
import logging

try:
    from langchain_huggingface import HuggingFaceEmbeddings
except ImportError:
    from langchain_community.embeddings import HuggingFaceEmbeddings

try:
    from langchain_chroma import Chroma
except ImportError:
    from langchain_community.vectorstores import Chroma
from langchain.schema import Document
from langchain.text_splitter import RecursiveCharacterTextSplitter

from .document_parser import IFCDocumentParser


logger = logging.getLogger(__name__)




class RemoteEmbeddings:
    """Minimal Embeddings adapter that calls a remote HTTP service.

    Set BLENDER_MCP_REMOTE_EMBEDDINGS_URL to enable. The service is expected to accept
    a POST with either:
      {"inputs": ["text1", "text2", ...]}  # Hugging Face TEI style
    or {"texts": ["text1", "text2", ...]}  # simple style
    and return one of:
      {"embeddings": [[...], [...], ...]}
      {"data": [{"embedding": [...]}, ...]}

    For queries, a single-string payload is sent and a single vector is returned.
    """

    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        try:
            self.chunk_size = int(os.environ.get("BLENDER_MCP_REMOTE_EMBEDDINGS_CHUNK", "128"))
            if self.chunk_size <= 0:
                self.chunk_size = 128
        except Exception:
            self.chunk_size = 128

    def _post(self, payload: Dict[str, Any]) -> Any:
        import json as _json
        try:
            import requests  # type: ignore
        except Exception as e:
            raise RuntimeError(
                "Remote embeddings requested but 'requests' is not installed.\n"
                "Install with: pip install requests"
            ) from e

        resp = requests.post(self.base_url, json=payload, timeout=self.timeout)
        if resp.status_code != 200:
            raise RuntimeError(f"Remote embeddings error: HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            return resp.json()
        except Exception as e:
            raise RuntimeError(f"Remote embeddings returned non-JSON response: {e}")

    def _parse_vectors(self, data: Any, expect: int) -> List[List[float]]:
        if isinstance(data, dict):
            if 'embeddings' in data and isinstance(data['embeddings'], list):
                return data['embeddings']
            if 'data' in data and isinstance(data['data'], list):
                return [item.get('embedding') for item in data['data'] if isinstance(item, dict) and 'embedding' in item]
        raise RuntimeError("Remote embeddings response format not recognized")

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        all_vectors: List[List[float]] = []
        for i in range(0, len(texts), self.chunk_size):
            chunk = texts[i:i + self.chunk_size]
            payload = {'inputs': chunk}
            data = self._post(payload)
            vectors = self._parse_vectors(data, expect=len(chunk))
            if not isinstance(vectors, list) or len(vectors) != len(chunk):
                raise RuntimeError("Remote embeddings returned wrong vector count for a chunk")
            all_vectors.extend(vectors)
        return all_vectors

    def embed_query(self, text: str) -> List[float]:
        payload = {'inputs': [text]}
        data = self._post(payload)
        vectors = self._parse_vectors(data, expect=1)
        if not vectors or not isinstance(vectors[0], list):
            raise RuntimeError("Remote embeddings returned invalid vector for query")
        return vectors[0]


class IFCKnowledgeStore:
    """Vector store for IFC API knowledge."""
    
    def __init__(
        self,
        persist_directory: Optional[Path] = None,
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
        collection_name: str = "ifc_knowledge"
    ):
        """
        Initialize the knowledge store.
        
        Args:
            persist_directory: Directory to persist the vector store
            embedding_model: HuggingFace model for embeddings
            collection_name: Name of the ChromaDB collection
        """
        if persist_directory is None:
            persist_directory = Path(__file__).parent.parent.parent.parent / ".cache" / "chromadb"

        self.persist_directory = Path(persist_directory)
        self.persist_directory.mkdir(parents=True, exist_ok=True)

        self.collection_name = collection_name

        env_model = os.environ.get("BLENDER_MCP_EMBEDDING_MODEL")
        model_to_use = env_model or embedding_model
        cache_dir = os.environ.get("BLENDER_MCP_EMBEDDING_CACHE") or os.environ.get("HUGGINGFACE_HUB_CACHE") or os.environ.get("HF_HOME")
        offline = os.environ.get("BLENDER_MCP_EMBEDDING_OFFLINE", "0") in ("1", "true", "True")

        remote_url = os.environ.get("BLENDER_MCP_REMOTE_EMBEDDINGS_URL")
        if remote_url:
            logger.info(f"Using remote embeddings service: {remote_url}")
            self.embeddings = RemoteEmbeddings(remote_url)
            self.vector_store = None
            self._initialize_store()
            return

        if offline:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

        model_kwargs = {'device': 'cpu'}
        if offline:
            model_kwargs['local_files_only'] = True
        cache_folder = str(cache_dir) if cache_dir else None

        local_path = Path(model_to_use)
        if local_path.exists() and local_path.is_dir():
            resolved_model = str(local_path)
            logger.info(f"Loading embedding model from local path: {resolved_model}")
        else:
            resolved_model = model_to_use
            if offline and not local_path.exists() and not cache_dir:
                raise RuntimeError(
                    "Offline mode enabled but no local model path or cache configured. "
                    "Set BLENDER_MCP_EMBEDDING_MODEL to a local directory or set "
                    "BLENDER_MCP_EMBEDDING_CACHE/HUGGINGFACE_HUB_CACHE to a directory that contains the model '"
                    + model_to_use + "'."
                )

            try:
                logger.info(f"Loading embedding model: {resolved_model}")

                if 'device' not in model_kwargs:
                    model_kwargs['device'] = 'cpu'

                tokenizer_kwargs = None
                try:
                    use_lc_hf = 'langchain_huggingface' in HuggingFaceEmbeddings.__module__
                except Exception:
                    use_lc_hf = False
                if use_lc_hf and offline:
                    tokenizer_kwargs = {'local_files_only': True}

                init_kwargs = dict(
                    model_name=resolved_model,
                    cache_folder=cache_folder,
                    model_kwargs=model_kwargs,
                    encode_kwargs={'normalize_embeddings': True}
                )
                if tokenizer_kwargs is not None:
                    init_kwargs['tokenizer_kwargs'] = tokenizer_kwargs

                self.embeddings = HuggingFaceEmbeddings(**init_kwargs)
                logger.info("Embedding model loaded successfully")

            except RuntimeError as re:
                if "meta tensor" in str(re).lower():
                    logger.warning("Encountered meta tensor issue, retrying with different configuration")
                    model_kwargs.pop('low_cpu_mem_usage', None)
                    model_kwargs['device'] = 'cpu'
                    self.embeddings = HuggingFaceEmbeddings(
                        model_name=resolved_model,
                        cache_folder=cache_folder,
                        model_kwargs=model_kwargs,
                        encode_kwargs={'normalize_embeddings': True}
                    )
                    logger.info("Embedding model loaded successfully (after retry)")
                else:
                    raise
            except Exception as e:
                if "meta tensor" in str(e).lower():
                    logger.error(f"Meta tensor error detected: {e}")
                    logger.error("This is likely a PyTorch/Transformers version issue.")
                    logger.error("Try updating: pip install --upgrade transformers sentence-transformers torch")
                raise
        
        self.vector_store = None
        self._initialize_store()
        
    def _initialize_store(self):
        """Initialize or load the vector store."""
        logger.info("Initializing ChromaDB vector store...")
        os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
        self.vector_store = Chroma(
            collection_name=self.collection_name,
            embedding_function=self.embeddings,
            persist_directory=str(self.persist_directory)
        )
        logger.info("ChromaDB vector store initialized")
    
    def build_index(self, api_docs_path: Optional[Path] = None, force_rebuild: bool = False):
        """
        Build or rebuild the vector index from API documentation.
        
        Args:
            api_docs_path: Path to ifcopenshell_api_docs.txt
            force_rebuild: Force rebuild even if index exists
        """
        if not force_rebuild and self._index_exists():
            logger.info("Index already exists. Use force_rebuild=True to rebuild.")
            return
        
        logger.info("Building IFC knowledge index...")
        
        parser = IFCDocumentParser(api_docs_path)
        parsed_docs = parser.parse()

        documents = []
        for doc_data in parsed_docs:
            documents.append(Document(page_content=doc_data['content'], metadata=doc_data['metadata']))

        project_root = Path(__file__).parent.parent.parent.parent
        ifc_jsonl = project_root / "docs" / "ifc4x3_spec.jsonl"
        ifc_txt = project_root / "docs" / "ifc4x3_spec.txt"

        if ifc_jsonl.exists():
            try:
                import json as _json
                with ifc_jsonl.open("r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = _json.loads(line)
                        except Exception:
                            continue
                        text = rec.get("text", "")
                        if not text:
                            continue
                        meta = {
                            "type": "ifc_spec",
                            "module": "ifc_spec",
                            "title": rec.get("title"),
                            "url": rec.get("url"),
                            "source": str(ifc_jsonl),
                        }
                        documents.append(Document(page_content=text, metadata=meta))
            except Exception:
                pass
        elif ifc_txt.exists():
            try:
                content = ifc_txt.read_text(encoding="utf-8")
                documents.append(Document(
                    page_content=content,
                    metadata={
                        "type": "ifc_spec_corpus",
                        "module": "ifc_spec",
                        "source": str(ifc_txt)
                    }
                ))
            except Exception:
                pass




        api_md = project_root / "docs" / "api-reference.md"
        if api_md.exists():
            try:
                content = api_md.read_text(encoding="utf-8")
                documents.append(Document(
                    page_content=content,
                    metadata={"type": "mcp_tools", "module": "mcp", "source": str(api_md)}
                ))
            except Exception:
                pass

        env_md = project_root / "docs" / "LLM_ENV.md"
        if env_md.exists():
            try:
                content = env_md.read_text(encoding="utf-8")
                documents.append(Document(
                    page_content=content,
                    metadata={"type": "env_helper", "module": "mcp_env", "source": str(env_md)}
                ))
            except Exception:
                pass
        
        logger.info(f"Parsed {len(documents)} documents from API documentation")
        
        if force_rebuild and self._index_exists():
            self._clear_store()
        
        self.vector_store.add_documents(documents)
        
        logger.info(f"Successfully indexed {len(documents)} documents")
        
        self._save_metadata(len(documents))
    
    def search(
        self,
        query: str,
        k: int = 5,
        filter_dict: Optional[Dict[str, Any]] = None,
        search_type: str = "similarity"
    ) -> List[Dict[str, Any]]:
        """
        Search the knowledge base.
        
        Args:
            query: Search query
            k: Number of results to return
            filter_dict: Metadata filters (e.g., {'module': 'root'})
            search_type: Type of search ('similarity' or 'mmr')
        
        Returns:
            List of search results with content and metadata
        """
        if not self._index_exists():
            raise ValueError("Knowledge index not built. Run build_index() first.")
        
        where_clause = None
        if filter_dict:
            if len(filter_dict) > 1:
                where_clause = {"$and": [
                    {key: {"$eq": value}} for key, value in filter_dict.items()
                ]}
            else:
                key, value = next(iter(filter_dict.items()))
                where_clause = {key: {"$eq": value}}
        
        if search_type == "mmr":
            results = self.vector_store.max_marginal_relevance_search(
                query=query,
                k=k,
                filter=where_clause
            )
        else:
            results = self.vector_store.similarity_search(
                query=query,
                k=k,
                filter=where_clause
            )
        
        formatted_results = []
        for doc in results:
            result = {
                'content': doc.page_content,
                'metadata': doc.metadata
            }
            
            if 'full_doc' in doc.metadata:
                import json
                try:
                    result['full_documentation'] = json.loads(doc.metadata['full_doc'])
                except json.JSONDecodeError:
                    result['full_documentation'] = doc.metadata['full_doc']
                
            formatted_results.append(result)
        
        return formatted_results
    
    def search_functions(
        self,
        operation: str,
        module: Optional[str] = None,
        k: int = 5
    ) -> List[Dict[str, Any]]:
        """
        Search for specific IFC functions.
        
        Args:
            operation: Operation description (e.g., "create wall", "assign class")
            module: Specific module to search in
            k: Number of results
        
        Returns:
            List of matching functions with full documentation
        """
        filter_dict = {'type': 'function'}
        if module:
            filter_dict['module'] = module
        
        enhanced_query = f"function operation: {operation}"
        if module:
            enhanced_query += f" module: {module}"
        
        results = self.search(
            query=enhanced_query,
            k=k,
            filter_dict=filter_dict
        )
        
        functions = []
        for result in results:
            if 'full_documentation' in result:
                func_info = {
                    'module': result['metadata'].get('module'),
                    'function': result['metadata'].get('function'),
                    'full_path': result['metadata'].get('full_path'),
                    'documentation': result['full_documentation']
                }
                functions.append(func_info)
        
        return functions
    
    def get_module_info(self, module_name: str) -> Optional[Dict[str, Any]]:
        """
        Get information about a specific module.
        
        Args:
            module_name: Name of the module
        
        Returns:
            Module information or None if not found
        """
        results = self.search(
            query=f"module {module_name}",
            k=1,
            filter_dict={'type': 'module', 'module': module_name}
        )
        
        if results:
            result = results[0]
            if 'functions' in result['metadata'] and isinstance(result['metadata']['functions'], str):
                result['metadata']['functions'] = result['metadata']['functions'].split(', ')
            return result
        return None
    
    def get_function_info(self, function_name: str, module: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Get detailed information about a specific function.
        
        Args:
            function_name: Name of the function
            module: Optional module name for more specific search
        
        Returns:
            Function information or None if not found
        """
        filter_dict = {'type': 'function', 'function': function_name}
        if module:
            filter_dict['module'] = module
        
        results = self.search(
            query=f"function {function_name}",
            k=1,
            filter_dict=filter_dict
        )
        
        if results:
            return results[0]
        return None
    
    def find_similar_functions(self, function_name: str, k: int = 5) -> List[Dict[str, Any]]:
        """
        Find functions similar to a given function.
        
        Args:
            function_name: Name of the reference function
            k: Number of similar functions to return
        
        Returns:
            List of similar functions
        """
        ref_func = self.get_function_info(function_name)
        if not ref_func:
            return []
        
        query = ref_func['content']
        results = self.search(
            query=query,
            k=k+1,  # Add 1 to account for the reference function itself
            filter_dict={'type': 'function'},
            search_type='mmr'
        )
        
        similar = [r for r in results if r['metadata'].get('function') != function_name]
        return similar[:k]
    
    def _index_exists(self) -> bool:
        """Check if the index exists."""
        metadata_file = self.persist_directory / f"{self.collection_name}_metadata.json"
        return metadata_file.exists()
    
    def _clear_store(self):
        """Clear the existing vector store."""
        if self.vector_store:
            self.vector_store.delete_collection()
            self._initialize_store()
    
    def _save_metadata(self, doc_count: int):
        """Save index metadata."""
        metadata = {
            'collection_name': self.collection_name,
            'document_count': doc_count,
            'embedding_model': self.embeddings.model_name
        }
        
        metadata_file = self.persist_directory / f"{self.collection_name}_metadata.json"
        with open(metadata_file, 'w') as f:
            json.dump(metadata, f, indent=2)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about the knowledge store."""
        if not self._index_exists():
            return {'status': 'not_initialized'}
        
        metadata_file = self.persist_directory / f"{self.collection_name}_metadata.json"
        with open(metadata_file, 'r') as f:
            metadata = json.load(f)
        
        return {
            'status': 'initialized',
            'document_count': metadata.get('document_count', 0),
            'embedding_model': metadata.get('embedding_model'),
            'collection_name': metadata.get('collection_name')
        }

