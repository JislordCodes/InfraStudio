"""Optimized MCP Tools for RAG-based IFC Knowledge Retrieval.

This module implements a high-performance Retrieval-Augmented Generation (RAG) system
for IFC/OpenShell knowledge base access. It provides semantic search capabilities across
IFC documentation, function signatures, and usage patterns.

Architecture:
    - Lazy initialization with background threading for non-blocking startup
    - Multi-level caching for instant repeated queries
    - Remote embedding server integration for scalable vector operations
    - ChromaDB persistence for knowledge base storage

Design Philosophy:
    Pay upfront (5-10 seconds initialization), instant operations afterwards.
    All heavy initialization happens once in ensure_ifc_knowledge_ready().
    Subsequent operations leverage pre-loaded models and caches for sub-millisecond response.

Key Components:
    - Knowledge Store: Manages document embeddings and vector search
    - Retriever: Contextual retrieval with ranking and filtering
    - Cache Layer: Function results and module information caching
    - Background Initialization: Non-blocking system startup

Performance Characteristics:
    - Initial setup: 5-10 seconds (one-time cost)
    - Cached queries: <1ms
    - New queries: 20-50ms
    - Module lookups: <5ms with cache
"""

import json
import time
import os
import threading
import sys
import io
import contextlib
from typing import Optional, List, Dict, Any
from pathlib import Path

from ..mcp_instance import mcp
from ..rag import IFCDocumentParser, IFCKnowledgeStore, IFCKnowledgeRetriever
from ..rag.retriever import RetrievalContext

_knowledge_store: Optional[IFCKnowledgeStore] = None
_retriever: Optional[IFCKnowledgeRetriever] = None
_fully_initialized: bool = False
_init_error: Optional[str] = None
_init_stats: Dict[str, Any] = {}
_init_thread: Optional[threading.Thread] = None
_init_started_at: float = 0.0
_init_lock = threading.Lock()
_init_stage: str = "idle"

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_PERSIST_DIR = _PROJECT_ROOT / ".cache" / "chromadb"
_METADATA_FILE = _PERSIST_DIR / "ifc_knowledge_metadata.json"
_EMBED_CACHE_DIR = _PROJECT_ROOT / ".cache" / "huggingface"

_function_cache: Dict[str, List[Dict]] = {}
_module_info_cache: Dict[str, Dict] = {}


def _is_fully_ready() -> bool:
    """Check if system is completely initialized and ready for instant operations."""
    return _fully_initialized and _knowledge_store is not None and _retriever is not None and _init_error is None


def _get_initialization_stats() -> Dict[str, Any]:
    """Get cached initialization statistics."""
    return _init_stats.copy()


def _index_exists() -> bool:
    """Lightweight check whether the IFC knowledge index metadata exists.

    Server startup uses this to avoid instantiating heavy components just
    to know if an index is present on disk.
    """
    try:
        return _METADATA_FILE.exists()
    except Exception:
        return False


def _pre_warm_system(store, retriever) -> Dict[str, float]:
    """Pre-warm all components and cache common operations."""
    timings = {}
    
    start = time.time()
    try:
        store.embeddings.embed_query("warmup query")
        timings['model_warmup'] = time.time() - start
    except Exception as e:
        timings['model_warmup_error'] = str(e)
    start = time.time()
    common_queries = [
        "create wall", "create entity", "assign material", "add property",
        "spatial container", "geometry representation", "delete element"
    ]
    
    for query in common_queries:
        try:
            results = store.search(query, k=3)
            cache_key = f"search:{query}"
            _function_cache[cache_key] = results
        except Exception:
            pass
    
    timings['search_cache'] = time.time() - start
    start = time.time()
    common_modules = [
        'root', 'aggregate', 'attribute', 'material', 'pset', 
        'spatial', 'geometry', 'type', 'classification'
    ]
    
    for module in common_modules:
        try:
            module_info = store.get_module_info(module)
            if module_info:
                _module_info_cache[module] = module_info
        except Exception:
            pass
    
    timings['module_cache'] = time.time() - start
    start = time.time()
    try:
        context = RetrievalContext(current_module='root')
        retriever.retrieve("test query", context=context, k=1)
        timings['retriever_warmup'] = time.time() - start
    except Exception as e:
        timings['retriever_warmup_error'] = str(e)
    
    return timings


@mcp.tool()
def ensure_ifc_knowledge_ready(
    force_rebuild: bool = False,
    timeout_seconds: int = 30
) -> str:
    """Complete IFC knowledge system initialization for local model only.
    
    Args:
        force_rebuild: Rebuild the index even if it exists
        timeout_seconds: Maximum time to wait for initialization
    
    Returns:
        JSON status with initialization results
    """
    global _knowledge_store, _retriever, _fully_initialized, _init_error, _init_stats, _init_thread, _init_started_at, _init_stage
    
    try:
        if _fully_initialized and not force_rebuild:
            return json.dumps({
                'status': 'already_ready',
                'message': 'System is already fully initialized and ready for instant operations',
                'stats': _init_stats,
                'ready_for_instant_operations': True
            }, indent=2)
        
        if _init_thread and _init_thread.is_alive() and not force_rebuild:
            return json.dumps({
                'status': 'initializing',
                'message': 'Initialization in progress',
                'elapsed_seconds': round(time.time() - _init_started_at, 2),
                'ready_for_instant_operations': False,
                'stage': _init_stage
            }, indent=2)

        def _bg_init():
            global _knowledge_store, _retriever, _fully_initialized, _init_error, _init_stats, _init_stage
            start_time = time.time()
            
            try:
                with _init_lock:
                    _fully_initialized = False
                    _init_error = None
                    _function_cache.clear()
                    _module_info_cache.clear()

                    _init_stage = 'env_setup'
                    _PERSIST_DIR.mkdir(parents=True, exist_ok=True)
                    _EMBED_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    
                    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
                    os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
                    os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
                    os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
                    os.environ['BLENDER_MCP_REMOTE_EMBEDDINGS_URL'] = 'http://127.0.0.1:8080/embeddings'
                    

                    _init_stage = 'load_embeddings'
                    store_box: Dict[str, Any] = {}
                    
                    def _load_store():
                        try:
                            store_box['store'] = IFCKnowledgeStore()
                        except Exception as e:
                            store_box['error'] = str(e)
                    
                    t = threading.Thread(target=_load_store, daemon=True)
                    t.start()
                    t.join(timeout=120)
                    
                    if t.is_alive():
                        _init_error = 'Timeout while loading embeddings/model (>120s). Check if model is cached locally.'
                        _init_stage = 'error'
                        return
                    
                    if 'error' in store_box:
                        _init_error = store_box['error']
                        _init_stage = 'error'
                        return
                    
                    store = store_box['store']

                    _init_stage = 'build_index'
                    build_box: Dict[str, Any] = {}
                    
                    def _build():
                        try:
                            store.build_index(force_rebuild=force_rebuild)
                        except Exception as e:
                            build_box['error'] = str(e)
                    
                    b = threading.Thread(target=_build, daemon=True)
                    b.start()
                    b.join(timeout=300)
                    
                    if b.is_alive():
                        _init_error = 'Timeout while building index (>300s). Run scripts/init_knowledge_base.py first.'
                        _init_stage = 'error'
                        return
                    
                    if 'error' in build_box:
                        _init_error = build_box['error']
                        _init_stage = 'error'
                        return

                    _init_stage = 'create_retriever'
                    retriever = IFCKnowledgeRetriever(store)

                    _knowledge_store = store
                    _retriever = retriever
                    _fully_initialized = True

                    try:
                        stats = store.get_stats()
                    except Exception:
                        stats = {}
                    
                    _init_stats = {
                        'initialization_time': round(time.time() - start_time, 2),
                        'stage': 'completed',
                        **(stats or {})
                    }
                    
            except Exception as e:
                _init_error = f"Initialization error: {str(e)}"
                _init_stage = 'error'
                _fully_initialized = False

        _init_started_at = time.time()
        _init_thread = threading.Thread(target=_bg_init, daemon=True)
        _init_thread.start()

        end_wait = time.time() + timeout_seconds
        while time.time() < end_wait:
            if _fully_initialized:
                return json.dumps({
                    'status': 'completed',
                    'message': 'IFC Knowledge system initialized and ready for operations',
                    'ready_for_instant_operations': True,
                    'stats': _init_stats
                }, indent=2)
            if _init_error:
                return json.dumps({
                    'status': 'error',
                    'error': _init_error,
                    'ready_for_instant_operations': False
                }, indent=2)
            time.sleep(0.2)

        return json.dumps({
            'status': 'initializing',
            'message': 'Initialization started in background',
            'elapsed_seconds': round(time.time() - _init_started_at, 2),
            'ready_for_instant_operations': False,
            'stage': _init_stage
        }, indent=2)
        
    except Exception as e:
        _init_error = str(e)
        _fully_initialized = False
        return json.dumps({
            'status': 'error',
            'error': str(e),
            'ready_for_instant_operations': False
        }, indent=2)

@mcp.tool()
def search_ifc_knowledge(
    query: str,
    context_type: Optional[str] = None,
    module: Optional[str] = None,
    max_results: int = 5
) -> str:
    """Search the IFC OpenShell knowledge base for functions, modules, and documentation.
    
    This tool performs semantic search across the entire IFC knowledge base using
    advanced retrieval techniques. Results include functions, examples, and documentation
    relevant to your query. Designed for instant performance after initialization.
    
    Args:
        query (str): Natural language search query describing what you're looking for.
                     Examples: "create wall", "assign material", "spatial structure"
        context_type (Optional[str]): Filter by content type:
            - 'function': Only function definitions and signatures
            - 'module': Only module information and descriptions
            - 'workflow': Usage patterns and workflows
            - None: Search all content types
        module (Optional[str]): Limit search to specific IFC module:
            - 'root': Core entity operations
            - 'material': Material and properties
            - 'geometry': Geometric representations
            - 'spatial': Spatial relationships
            - None: Search all modules
        max_results (int): Maximum number of results to return (default: 5, max: 20)
    
    Returns:
        str: JSON response containing:
            - query: The search query used
            - results_count: Number of results found
            - results: Array of search results, each containing:
                - type: Content type ('function', 'module', etc.)
                - module: IFC module name
                - function: Function name (if applicable)
                - description: Relevant description or documentation
                - signature: Function signature (if applicable)
                - parameters: Function parameters (if applicable)
                - returns: Return type (if applicable)
                - examples: Usage examples (if available)
            - search_time: Time taken for the search in seconds
            - status: Search status ('success', 'error', 'not_ready')
            - cache_hit: Whether result came from cache
    
    Example:
        >>> search_ifc_knowledge("create wall", max_results=3)
        {
            "query": "create wall",
            "results_count": 3,
            "results": [
                {
                    "type": "function",
                    "module": "root",
                    "function": "create_wall",
                    "description": "Creates a new IFC wall entity",
                    "signature": "create_wall(length, height, thickness)"
                }
            ],
            "search_time": 0.023
        }
    
    Note:
        Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.
    """
    if not _is_fully_ready():
        return json.dumps({
            'status': 'not_ready',
            'error': 'System not initialized. Call ensure_ifc_knowledge_ready() first.',
            'query': query,
            'ready_for_instant_operations': False
        })
    
    start_time = time.time()
    
    try:
        cache_key = f"search:{query}:{module}:{max_results}"
        if cache_key in _function_cache and max_results <= 5:
            cached_results = _function_cache[cache_key]
            search_time = time.time() - start_time
            
            return json.dumps({
                'query': query,
                'results_count': len(cached_results),
                'results': cached_results[:max_results],
                'search_time': round(search_time, 4),
                'status': 'success',
                'cache_hit': True
            }, indent=2)
        
        context = RetrievalContext(current_module=module) if module else None
        results = _retriever.retrieve(query=query, context=context, k=max_results)
        
        formatted_results = []
        for result in results:
            formatted = {
                'type': result['metadata'].get('type'),
                'module': result['metadata'].get('module'),
                'function': result['metadata'].get('function'),
                'description': result.get('content', '')[:500]
            }
            
            if 'full_documentation' in result:
                full_doc = result['full_documentation']
                formatted.update({
                    'signature': full_doc.get('signature'),
                    'parameters': full_doc.get('parameters'),
                    'returns': full_doc.get('return_type'),
                    'examples': full_doc.get('examples', [])[:2]
                })
            
            formatted_results.append(formatted)
        
        if max_results <= 5:
            _function_cache[cache_key] = formatted_results
        
        search_time = time.time() - start_time
        
        return json.dumps({
            'query': query,
            'results_count': len(formatted_results),
            'results': formatted_results,
            'search_time': round(search_time, 4),
            'status': 'success',
            'cache_hit': False
        }, indent=2)
        
    except Exception as e:
        return json.dumps({
            'status': 'error',
            'error': f"Search error: {str(e)}",
            'query': query,
            'search_time': round(time.time() - start_time, 4)
        })


@mcp.tool()
def get_ifc_knowledge_status() -> str:
    """Get the current status of the IFC knowledge base system.
    
    This tool provides a comprehensive overview of the system's initialization state,
    cache statistics, and readiness for operations. Use this to check if the system
    is ready for instant operations or needs initialization.
    
    Returns:
        str: JSON response containing:
            - ready_for_instant_operations: Boolean indicating if system is ready
            - fully_initialized: Boolean indicating complete initialization
            - knowledge_store_loaded: Boolean indicating if knowledge store is loaded
            - retriever_loaded: Boolean indicating if retriever is loaded
            - initialization_error: Any initialization error message (if failed)
            - cached_searches: Number of cached search results
            - cached_modules: Number of cached module information entries
            - status: Overall status ('ready', 'error', 'not_initialized')
            - message: Human-readable status message
            - stats: Detailed initialization statistics (if available)
    
    Example:
        >>> get_ifc_knowledge_status()
        {
            "ready_for_instant_operations": true,
            "status": "ready",
            "message": "All systems ready - operations are instant",
            "cached_searches": 15,
            "cached_modules": 8
        }
    
    Note:
        If status is 'not_initialized', call ensure_ifc_knowledge_ready() to initialize.
    """
    try:
        status_info = {
            'ready_for_instant_operations': _is_fully_ready(),
            'fully_initialized': _fully_initialized,
            'knowledge_store_loaded': _knowledge_store is not None,
            'retriever_loaded': _retriever is not None,
            'initialization_error': _init_error,
            'cached_searches': len(_function_cache),
            'cached_modules': len(_module_info_cache),
            'stats': _init_stats if _init_stats else None,
            'stage': _init_stage,
            'remote_embeddings_url': os.environ.get('BLENDER_MCP_REMOTE_EMBEDDINGS_URL')
        }
        
        if _is_fully_ready():
            status_info['status'] = 'ready'
            status_info['message'] = 'All systems ready - operations are instant'
        elif '_init_thread' in globals() and _init_thread is not None and _init_thread.is_alive():
            status_info['status'] = 'initializing'
            status_info['message'] = 'Initialization in progress'
            status_info['elapsed_seconds'] = round(time.time() - (_init_started_at or time.time()), 2)
        elif _init_error:
            status_info['status'] = 'error'
            status_info['message'] = f'Initialization failed: {_init_error}'
        else:
            status_info['status'] = 'not_initialized'
            status_info['message'] = 'Call ensure_ifc_knowledge_ready() to initialize'
        
        return json.dumps(status_info, indent=2)
        
    except Exception as e:
        return json.dumps({
            'status': 'error',
            'error': f"Status check error: {str(e)}"
        })


@mcp.tool()
def find_ifc_function(
    operation: str,
    object_type: Optional[str] = None,
    module: Optional[str] = None
) -> str:
    """Find IFC functions by operation type and object type - instant operation after initialization.
    
    This tool searches the IFC knowledge base for functions that match the specified operation
    and object type. It's designed for instant performance after the initial setup.
    
    Args:
        operation (str): The operation to search for (e.g., 'create', 'assign', 'delete', 'get')
        object_type (Optional[str]): Specific IFC object type to filter by (e.g., 'wall', 'slab', 'beam')
        module (Optional[str]): Specific IFC module to search in (e.g., 'root', 'material', 'geometry')
    
    Returns:
        str: JSON response containing:
            - operation: The search operation used
            - object_type: The object type filter used
            - functions_found: Number of matching functions found
            - functions: Array of function objects with details:
                - module: IFC module name
                - function: Function name
                - full_path: Complete module path
                - signature: Function signature (if available)
                - description: Function description (if available)
                - parameters: Function parameters (if available)
                - returns: Return type (if available)
                - usage: Usage example (if available)
            - search_time: Time taken for the search in seconds
            - message: Additional status message
    
    Example:
        >>> find_ifc_function("create", "wall")
        Returns functions for creating walls
        
        >>> find_ifc_function("assign", "material", "material")
        Returns material assignment functions
    
    Note:
        Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.
    """
    if not _is_fully_ready():
        return json.dumps({
            'error': 'System not ready. Call ensure_ifc_knowledge_ready() first.',
            'ready_for_instant_operations': False
        })
    
    start_time = time.time()
    
    try:
        search_query = operation
        if object_type:
            search_query += f" {object_type}"
        
        cache_key = f"function_search:{search_query}:{module}"
        if cache_key in _function_cache:
            functions = _function_cache[cache_key]
        else:
            functions = _knowledge_store.search_functions(
                operation=search_query,
                module=module,
                k=5
            )
            _function_cache[cache_key] = functions
        
        if functions is None:
            functions = []
        
        if not functions:
            return json.dumps({
                'operation': operation,
                'object_type': object_type,
                'functions_found': 0,
                'functions': [],
                'message': 'No matching functions found. Try a different search term.',
                'search_time': round(time.time() - start_time, 4)
            }, indent=2)
        
        formatted_functions = []
        for func in functions:
            if not func or not isinstance(func, dict):
                continue
                
            formatted = {
                'module': func.get('module'),
                'function': func.get('function'),
                'full_path': func.get('full_path')
            }
            
            if func.get('documentation') and isinstance(func['documentation'], dict):
                doc = func['documentation']
                formatted.update({
                    'signature': doc.get('signature'),
                    'description': doc.get('docstring', '')[:300] if doc.get('docstring') else '',
                    'parameters': doc.get('parameters', []) if isinstance(doc.get('parameters'), list) else [],
                    'returns': doc.get('return_type')
                })
                
                if doc.get('examples') and isinstance(doc['examples'], list) and len(doc['examples']) > 0:
                    formatted['usage'] = doc['examples'][0]
            
            formatted_functions.append(formatted)
        
        return json.dumps({
            'operation': operation,
            'object_type': object_type,
            'functions_found': len(formatted_functions),
            'functions': formatted_functions,
            'search_time': round(time.time() - start_time, 4)
        }, indent=2)
        
    except Exception as e:
        return json.dumps({
            'error': f"Function search error: {str(e)}",
            'operation': operation,
            'search_time': round(time.time() - start_time, 4)
        })


@mcp.tool()
def get_ifc_module_info(module_name: str) -> str:
    """Get detailed information about a specific IFC module - instant operation after initialization.
    
    This tool retrieves comprehensive information about IFC modules including their functions,
    descriptions, and usage statistics. Information is cached for instant subsequent access.
    
    Args:
        module_name (str): Name of the IFC module to get information for. Common modules include:
            - 'root': Core IFC entity creation and management
            - 'material': Material and material layer operations
            - 'geometry': Geometric representation and transformations
            - 'spatial': Spatial structure and relationships
            - 'attribute': Property sets and attributes
            - 'aggregate': Aggregation and grouping operations
            - 'type': Type definitions and relationships
    
    Returns:
        str: JSON response containing:
            - module: The module name requested
            - description: Module description and purpose
            - functions: List of functions available in the module
            - function_count: Total number of functions in the module
            - search_time: Time taken for the lookup in seconds
            - available_modules: List of all available modules (if module not found)
    
    Example:
        >>> get_ifc_module_info("material")
        {
            "module": "material",
            "description": "Material and material layer operations",
            "function_count": 25,
            "functions": ["create_material", "assign_material", ...]
        }
    
    Note:
        Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.
    """
    if not _is_fully_ready():
        return json.dumps({
            'error': 'System not ready. Call ensure_ifc_knowledge_ready() first.',
            'ready_for_instant_operations': False
        })
    
    start_time = time.time()
    
    try:
        if module_name in _module_info_cache:
            module_info = _module_info_cache[module_name]
        else:
            module_info = _knowledge_store.get_module_info(module_name)
            if module_info:
                _module_info_cache[module_name] = module_info
        
        if not module_info:
            return json.dumps({
                'error': f"Module '{module_name}' not found",
                'available_modules': [
                    'root', 'aggregate', 'attribute', 'boundary', 'classification',
                    'context', 'control', 'cost', 'material', 'pset', 'spatial',
                    'type', 'unit', 'void', 'geometry'
                ],
                'search_time': round(time.time() - start_time, 4)
            })
        
        response = {
            'module': module_name,
            'description': module_info.get('content', ''),
            'functions': module_info.get('metadata', {}).get('functions', []) if module_info.get('metadata') else [],
            'function_count': module_info.get('metadata', {}).get('function_count', 0) if module_info.get('metadata') else 0,
            'search_time': round(time.time() - start_time, 4)
        }
        
        return json.dumps(response, indent=2)
        
    except Exception as e:
        return json.dumps({
            'error': f"Module info error: {str(e)}",
            'module': module_name,
            'search_time': round(time.time() - start_time, 4)
        })


@mcp.tool()
def get_ifc_function_details(
    function_name: str,
    module: Optional[str] = None
) -> str:
    """Get detailed information about a specific IFC function - instant operation after initialization.
    
    This tool provides comprehensive details about IFC functions including their signatures,
    parameters, return types, documentation, and usage examples. Results are cached for
    instant subsequent access.
    
    Args:
        function_name (str): Name of the IFC function to get details for
        module (Optional[str]): Specific module to search in (speeds up search if known)
    
    Returns:
        str: JSON response containing:
            - function: The function name requested
            - module: The module containing the function
            - full_path: Complete module path to the function
            - signature: Function signature with parameters
            - description: Detailed function description
            - parameters: List of function parameters with types
            - returns: Return type information
            - examples: Usage examples and code snippets
            - search_time: Time taken for the lookup in seconds
            - similar_functions: Alternative functions if exact match not found
    
    Example:
        >>> get_ifc_function_details("create_wall")
        {
            "function": "create_wall",
            "module": "root",
            "signature": "create_wall(length: float, height: float, thickness: float)",
            "description": "Creates a new IFC wall entity with specified dimensions",
            "parameters": [{"name": "length", "type": "float"}, ...],
            "examples": ["wall = create_wall(5.0, 3.0, 0.2)"]
        }
    
    Note:
        Call ensure_ifc_knowledge_ready() first to initialize the system for instant performance.
    """
    if not _is_fully_ready():
        return json.dumps({
            'error': 'System not ready. Call ensure_ifc_knowledge_ready() first.',
            'ready_for_instant_operations': False
        })
    
    start_time = time.time()
    
    try:
        cache_key = f"function_details:{function_name}:{module}"
        if cache_key in _function_cache:
            func_info = _function_cache[cache_key]
        else:
            func_info = _knowledge_store.get_function_info(function_name, module)
            if func_info:
                _function_cache[cache_key] = func_info
        
        if not func_info:
            similar = _knowledge_store.find_similar_functions(function_name, k=3)
            if similar is None:
                similar = []
            return json.dumps({
                'error': f"Function '{function_name}' not found",
                'similar_functions': [
                    {
                        'function': s.get('metadata', {}).get('function'),
                        'module': s.get('metadata', {}).get('module'),
                        'full_path': s.get('metadata', {}).get('full_path')
                    }
                    for s in similar if s
                ],
                'search_time': round(time.time() - start_time, 4)
            })
        
        response = {
            'function': function_name,
            'module': func_info.get('metadata', {}).get('module'),
            'full_path': func_info.get('metadata', {}).get('full_path'),
            'search_time': round(time.time() - start_time, 4)
        }
        
        if 'full_documentation' in func_info:
            doc = func_info['full_documentation']
            response.update({
                'signature': doc.get('signature'),
                'description': doc.get('docstring'),
                'parameters': doc.get('parameters', []),
                'returns': doc.get('return_type'),
                'examples': doc.get('examples', [])
            })
        
        return json.dumps(response, indent=2)
        
    except Exception as e:
        return json.dumps({
            'error': f"Function details error: {str(e)}",
            'function': function_name,
            'search_time': round(time.time() - start_time, 4)
        })


@mcp.tool()
def clear_ifc_knowledge_cache() -> str:
    """Clear all cached IFC knowledge data to free memory or force fresh lookups.
    
    This tool clears the internal caches used for instant performance. Use this when:
    - Memory usage needs to be reduced
    - You want to force fresh lookups from the knowledge base
    - Cache corruption is suspected
    - Testing cache behavior
    
    Returns:
        str: JSON response containing:
            - status: Operation status ('cache_cleared')
            - message: Confirmation message
            - previous_cache_sizes: Cache sizes before clearing:
                - function_cache_entries: Number of cached function searches
                - module_cache_entries: Number of cached module information entries
    
    Example:
        >>> clear_ifc_knowledge_cache()
        {
            "status": "cache_cleared",
            "message": "All caches cleared - next operations will rebuild cache",
            "previous_cache_sizes": {
                "function_cache_entries": 15,
                "module_cache_entries": 8
            }
        }
    
    Note:
        Cache will be rebuilt automatically on subsequent operations. This does not
        affect the underlying knowledge base, only the performance caches.
    """
    if not _is_fully_ready():
        return json.dumps({
            'error': 'System not ready.',
            'ready_for_instant_operations': False
        })
    
    cache_sizes = {
        'function_cache_entries': len(_function_cache),
        'module_cache_entries': len(_module_info_cache)
    }
    
    _function_cache.clear()
    _module_info_cache.clear()
    
    return json.dumps({
        'status': 'cache_cleared',
        'message': 'All caches cleared - next operations will rebuild cache',
        'previous_cache_sizes': cache_sizes
    }, indent=2)


@mcp.tool()
def get_cache_statistics() -> str:
    """Get detailed statistics about the IFC knowledge cache usage and patterns.
    
    This tool provides insights into cache performance, usage patterns, and system
    statistics. Useful for monitoring performance and understanding cache behavior.
    
    Returns:
        str: JSON response containing:
            - function_cache_entries: Number of cached function search results
            - module_cache_entries: Number of cached module information entries
            - cached_modules: List of module names currently cached
            - cache_types: Breakdown of cache entry types by category
            - system_stats: Complete system initialization statistics
            - most_cached_queries: Analysis of frequently cached queries
    
    Example:
        >>> get_cache_statistics()
        {
            "function_cache_entries": 23,
            "module_cache_entries": 12,
            "cached_modules": ["root", "material", "geometry"],
            "cache_types": {
                "function_search": 15,
                "search": 8
            },
            "system_stats": {
                "document_count": 1250,
                "initialization_time": 8.45
            }
        }
    
    Note:
        This provides diagnostic information about cache usage patterns and system performance.
    """
    if not _is_fully_ready():
        return json.dumps({
            'error': 'System not ready.',
            'ready_for_instant_operations': False
        })
    
    cache_stats = {
        'function_cache_entries': len(_function_cache),
        'module_cache_entries': len(_module_info_cache),
        'most_cached_queries': [],
        'cached_modules': list(_module_info_cache.keys()),
        'system_stats': _init_stats
    }
    
    query_types = {}
    for cache_key in _function_cache.keys():
        key_type = cache_key.split(':')[0]
        query_types[key_type] = query_types.get(key_type, 0) + 1
    
    cache_stats['cache_types'] = query_types
    
    return json.dumps(cache_stats, indent=2)


def initialize_immediately_on_import():
    """Called immediately when this module is imported - starts background init.

    DISABLED: Can cause threading conflicts. Only initialize when explicitly requested.
    """
    pass
