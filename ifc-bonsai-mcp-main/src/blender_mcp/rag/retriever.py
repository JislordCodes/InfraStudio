"""Advanced retriever with query enhancement and re-ranking for IFC knowledge."""

import re
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

from .vector_store import IFCKnowledgeStore


@dataclass
class RetrievalContext:
    """Context for retrieval operations."""
    current_module: Optional[str] = None
    current_class: Optional[str] = None
    previous_functions: Optional[List[str]] = None
    task_description: Optional[str] = None
    
    def __post_init__(self):
        if self.previous_functions is None:
            self.previous_functions = []


class IFCKnowledgeRetriever:
    """Advanced retriever for IFC knowledge with query enhancement."""
    
    OPERATION_KEYWORDS = {
        'create': ['create', 'add', 'make', 'generate', 'instantiate'],
        'modify': ['edit', 'update', 'change', 'modify', 'alter', 'set'],
        'delete': ['remove', 'delete', 'clear', 'unassign'],
        'assign': ['assign', 'attach', 'connect', 'link', 'associate'],
        'query': ['get', 'find', 'search', 'retrieve', 'list', 'fetch'],
        'copy': ['copy', 'duplicate', 'clone'],
        'calculate': ['calculate', 'compute', 'measure']
    }
    
    ELEMENT_KEYWORDS = {
        'wall': ['wall', 'partition'],
        'slab': ['slab', 'floor', 'ceiling', 'roof'],
        'door': ['door', 'entrance'],
        'window': ['window', 'opening'],
        'space': ['space', 'room', 'zone'],
        'building': ['building', 'structure'],
        'storey': ['storey', 'floor', 'level'],
        'site': ['site', 'location'],
        'material': ['material', 'substance'],
        'property': ['property', 'attribute', 'pset'],
        'type': ['type', 'style', 'template'],
        'quantity': ['quantity', 'qto', 'measurement'],
        'classification': ['classification', 'category', 'class'],
        'aggregate': ['aggregate', 'collection', 'group'],
        'spatial': ['spatial', 'space', 'containment']
    }
    
    def __init__(self, knowledge_store: IFCKnowledgeStore):
        """Initialize the retriever."""
        self.knowledge_store = knowledge_store
    def retrieve(
        self,
        query: str,
        context: Optional[RetrievalContext] = None,
        k: int = 5,
        use_reranking: bool = True
    ) -> List[Dict[str, Any]]:
        """Retrieve relevant IFC knowledge with query enhancement."""
        enhanced_query = self._enhance_query(query, context)
        filters = self._build_filters(query, context)
        
        results = self.knowledge_store.search(
            query=enhanced_query,
            k=k * 2 if use_reranking else k,
            filter_dict=filters
        )
        
        if use_reranking and len(results) > k:
            results = self._rerank_results(results, query, context)[:k]
        
        return results
    
    def find_workflow(
        self,
        task_description: str,
        context: Optional[RetrievalContext] = None
    ) -> Dict[str, Any]:
        """Find a complete workflow for a given task."""
        operations = self._extract_operations(task_description)
        
        workflow = {
            'task': task_description,
            'steps': []
        }
        
        for i, operation in enumerate(operations):
            functions = self.knowledge_store.search_functions(
                operation=operation['action'],
                module=operation.get('module'),
                k=3
            )
            
            if functions:
                step = {
                    'step_number': i + 1,
                    'operation': operation['action'],
                    'target': operation.get('target'),
                    'recommended_function': functions[0] if functions else None,
                    'alternatives': functions[1:] if len(functions) > 1 else []
                }
                workflow['steps'].append(step)
        
        return workflow
    
    def suggest_next_function(
        self,
        context: RetrievalContext,
        task_goal: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Suggest the next function based on context."""
        query_parts = []
        
        if context.previous_functions:
            last_func = context.previous_functions[-1]
            query_parts.append(f"after {last_func}")
        
        if context.current_class:
            query_parts.append(f"for {context.current_class}")
        
        if task_goal:
            query_parts.append(task_goal)
        
        query = " ".join(query_parts) if query_parts else "common next steps"
        
        results = self.retrieve(
            query=query,
            context=context,
            k=5
        )
        
        functions = [r for r in results if r['metadata'].get('type') == 'function']
        
        if context.previous_functions:
            functions = [
                f for f in functions 
                if f['metadata'].get('function') not in context.previous_functions
            ]
        
        return functions
    
    def _enhance_query(self, query: str, context: Optional[RetrievalContext]) -> str:
        """Enhance query with IFC terminology and context."""
        enhanced = query.lower()
        
        for op_type, keywords in self.OPERATION_KEYWORDS.items():
            for keyword in keywords:
                if keyword in enhanced:
                    enhanced = enhanced.replace(keyword, f"{keyword} {op_type}")
                    break
        
        for elem_type, keywords in self.ELEMENT_KEYWORDS.items():
            for keyword in keywords:
                if keyword in enhanced:
                    enhanced += f" IFC{elem_type.capitalize()}"
                    break
        
        if context:
            if context.current_module:
                enhanced += f" module:{context.current_module}"
            if context.current_class:
                enhanced += f" class:{context.current_class}"
            if context.task_description:
                enhanced += f" task:{context.task_description[:50]}"
        
        return enhanced
    
    def _build_filters(
        self,
        query: str,
        context: Optional[RetrievalContext]
    ) -> Optional[Dict[str, Any]]:
        """Build metadata filters for search."""
        filters = {}
        
        module_pattern = r'module[:\s]+(\w+)'
        module_match = re.search(module_pattern, query.lower())
        if module_match:
            filters['module'] = module_match.group(1)
        elif context and context.current_module:
            filters['module'] = context.current_module
        
        if any(word in query.lower() for word in ['function', 'method', 'api']):
            filters['type'] = 'function'
        elif 'module' in query.lower():
            filters['type'] = 'module'
        
        return filters if filters else None
    
    def _rerank_results(
        self,
        results: List[Dict[str, Any]],
        query: str,
        context: Optional[RetrievalContext]
    ) -> List[Dict[str, Any]]:
        """Re-rank results based on relevance."""
        scored_results = []
        
        for result in results:
            score = 0
            metadata = result.get('metadata', {})
            
            if 'function' in query.lower() and metadata.get('type') == 'function':
                score += 2
            elif 'module' in query.lower() and metadata.get('type') == 'module':
                score += 2
            
            if metadata.get('has_examples'):
                score += 1
            
            if context:
                if context.current_module and metadata.get('module') == context.current_module:
                    score += 2
                if context.current_class and context.current_class.lower() in result.get('content', '').lower():
                    score += 1
            
            content_lower = result.get('content', '').lower()
            query_lower = query.lower()
            
            query_words = set(query_lower.split())
            content_words = set(content_lower.split())
            match_ratio = len(query_words & content_words) / len(query_words) if query_words else 0
            score += match_ratio * 3
            
            scored_results.append((score, result))
        
        scored_results.sort(key=lambda x: x[0], reverse=True)
        
        return [result for score, result in scored_results]
    
    def _extract_operations(self, task_description: str) -> List[Dict[str, str]]:
        """Extract operations from task description."""
        operations = []
        task_lower = task_description.lower()
        
        patterns = [
            r'(create|add|make)\s+(?:a\s+)?(\w+)',
            r'(assign|attach)\s+(\w+)\s+to\s+(\w+)',
            r'(modify|edit|update)\s+(?:the\s+)?(\w+)',
            r'(delete|remove)\s+(?:the\s+)?(\w+)',
        ]
        
        for pattern in patterns:
            matches = re.finditer(pattern, task_lower)
            for match in matches:
                groups = match.groups()
                operation = {
                    'action': groups[0],
                    'target': groups[1] if len(groups) > 1 else None
                }
                
                target = operation.get('target', '')
                if 'wall' in target or 'slab' in target or 'door' in target:
                    operation['module'] = 'root'
                elif 'property' in target or 'pset' in target:
                    operation['module'] = 'pset'
                elif 'material' in target:
                    operation['module'] = 'material'
                elif 'type' in target:
                    operation['module'] = 'type'
                elif 'classification' in target:
                    operation['module'] = 'classification'
                
                operations.append(operation)
        
        return operations