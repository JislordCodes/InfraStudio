"""Document parser for IFC OpenShell API documentation."""

import re
import json
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from pathlib import Path


@dataclass
class IFCFunction:
    """Represents an IFC API function with metadata."""
    module: str
    name: str
    signature: Optional[str]
    docstring: Optional[str]
    parameters: List[Dict[str, Any]]
    return_type: Optional[str]
    examples: List[str]
    
    def to_document(self) -> Dict[str, Any]:
        """Convert to document format for vector storage."""
        content_parts = [
            f"Module: {self.module}",
            f"Function: {self.name}",
        ]
        
        if self.signature:
            content_parts.append(f"Signature: {self.signature}")
        
        if self.docstring:
            content_parts.append(f"Description: {self.docstring[:500]}")
            
        if self.parameters:
            params_str = ", ".join([p.get('name', '') for p in self.parameters])
            content_parts.append(f"Parameters: {params_str}")
            
        if self.examples:
            content_parts.append("Example usage available")
            
        content = "\n".join(content_parts)
        
        metadata = {
            'module': self.module,
            'function': self.name,
            'type': 'function',
            'has_examples': len(self.examples) > 0,
            'param_count': len(self.parameters),
            'full_path': f"ifcopenshell.api.{self.module}.{self.name}",
            'full_doc': json.dumps({
                'signature': self.signature,
                'docstring': self.docstring,
                'parameters': self.parameters,
                'examples': self.examples,
                'return_type': self.return_type
            })
        }
        
        return {
            'content': content,
            'metadata': metadata
        }


@dataclass 
class IFCModule:
    """Represents an IFC API module with metadata."""
    name: str
    description: str
    functions: List[IFCFunction]
    
    def to_document(self) -> Dict[str, Any]:
        """Convert module overview to document."""
        content = f"Module: {self.name}\nDescription: {self.description}\n"
        content += f"Available functions: {', '.join([f.name for f in self.functions])}"
        
        metadata = {
            'module': self.name,
            'type': 'module',
            'function_count': len(self.functions),
            'functions': ', '.join([f.name for f in self.functions])
        }
        
        return {
            'content': content,
            'metadata': metadata
        }


class IFCDocumentParser:
    """Parser for IFC OpenShell API documentation."""
    def __init__(self, api_docs_path: Optional[Path] = None):
        """Initialize parser with path to ifcopenshell_api_docs.txt."""
        if api_docs_path is None:
            api_docs_path = Path(__file__).parent.parent.parent.parent / "docs" / "ifcopenshell_api_docs.txt"
        self.api_docs_path = api_docs_path
        self.modules: List[IFCModule] = []
        
    def parse(self) -> List[Dict[str, Any]]:
        """Parse the API documentation and return structured documents."""
        if not self.api_docs_path.exists():
            raise FileNotFoundError(f"API docs not found at {self.api_docs_path}")
            
        with open(self.api_docs_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        self._parse_modules(content)
        
        documents = []
        for module in self.modules:
            documents.append(module.to_document())
            for function in module.functions:
                documents.append(function.to_document())
                
        return documents
    
    def _parse_modules(self, content: str) -> None:
        """Parse modules from the documentation."""
        module_pattern = r'## Module: (\w+)\n\n### Description\n(.*?)\n\n### Available Functions\n(.*?)(?=## Module:|$)'
        
        for match in re.finditer(module_pattern, content, re.DOTALL):
            module_name = match.group(1)
            description = match.group(2).strip()
            functions_section = match.group(3)
            
            functions = self._parse_functions(module_name, functions_section, content)
            
            module = IFCModule(
                name=module_name,
                description=description,
                functions=functions
            )
            self.modules.append(module)
    
    def _parse_functions(self, module_name: str, functions_section: str, full_content: str) -> List[IFCFunction]:
        """Parse functions for a module."""
        functions = []
        
        function_names = []
        for line in functions_section.split('\n'):
            if line.startswith('- '):
                func_name = line[2:].strip()
                function_names.append(func_name)
        
        for func_name in function_names:
            docstring_pattern = rf'#### {func_name}\n(.*?)(?=####|## Module:|$)'
            match = re.search(docstring_pattern, full_content, re.DOTALL)
            
            docstring = None
            examples = []
            parameters = []
            signature = None
            
            if match:
                docstring_content = match.group(1).strip()
                
                if 'Example:' in docstring_content:
                    parts = docstring_content.split('Example:', 1)
                    docstring = parts[0].strip()
                    
                    example_pattern = r'```python\n(.*?)\n```'
                    example_matches = re.findall(example_pattern, parts[1], re.DOTALL)
                    examples = [ex.strip() for ex in example_matches]
                else:
                    docstring = docstring_content
                
                parameters = self._parse_parameters(docstring)
                
                if examples:
                    for ex in examples:
                        if f'{func_name}(' in ex:
                            lines = ex.split('\n')
                            for line in lines:
                                if f'{func_name}(' in line:
                                    signature = line.strip()
                                    break
                            if signature:
                                break
            
            function = IFCFunction(
                module=module_name,
                name=func_name,
                signature=signature,
                docstring=docstring,
                parameters=parameters,
                return_type=self._extract_return_type(docstring) if docstring else None,
                examples=examples
            )
            functions.append(function)
            
        return functions
    
    def _parse_parameters(self, docstring: str) -> List[Dict[str, Any]]:
        """Extract parameters from docstring."""
        parameters = []
        if not docstring:
            return parameters
            
        param_pattern = r':param\s+(\w+):\s+(.*?)(?=:param|:return|:raise|$)'
        
        for match in re.finditer(param_pattern, docstring, re.DOTALL):
            param_name = match.group(1)
            param_desc = match.group(2).strip()
            
            parameters.append({
                'name': param_name,
                'description': param_desc,
                'required': 'optional' not in param_desc.lower()
            })
            
        return parameters
    
    def _extract_return_type(self, docstring: str) -> Optional[str]:
        """Extract return type from docstring."""
        if not docstring:
            return None
            
        return_pattern = r':return:\s+(.*?)(?=:|\n\n|$)'
        match = re.search(return_pattern, docstring, re.DOTALL)
        
        if match:
            return match.group(1).strip()
        
        return None
    
    def get_module_functions(self, module_name: str) -> List[IFCFunction]:
        """Get all functions for a specific module."""
        for module in self.modules:
            if module.name == module_name:
                return module.functions
        return []
    
    def search_functions(self, keyword: str) -> List[IFCFunction]:
        """Search functions by keyword in name or docstring."""
        results = []
        keyword_lower = keyword.lower()
        
        for module in self.modules:
            for function in module.functions:
                if (keyword_lower in function.name.lower() or 
                    (function.docstring and keyword_lower in function.docstring.lower())):
                    results.append(function)
                    
        return results