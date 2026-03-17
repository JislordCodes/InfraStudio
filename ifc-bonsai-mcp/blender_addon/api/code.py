"""Security-restricted code execution module for Blender IFC operations.

Provides sandboxed Python code execution with restrictions on Blender API access
while allowing full IFC OpenShell functionality.
"""

import io
import traceback
import ast
import html
import re
import json
import signal
import logging
import platform
from contextlib import redirect_stdout, contextmanager
from typing import List, Dict, Any, Optional
from . import register_command

try:
    from ...src.blender_mcp.mcp_instance import mcp
except ImportError:
    mcp = None

logger = logging.getLogger(__name__)

BLACKLISTED_MODULES = {
    'os', 'sys', 'subprocess', 'socket', 'shlex',
    'importlib', 'pickle', 'shelve', 'dbm', 'sqlite3',
    'http', 'urllib', 'ftplib', 'poplib', 'imaplib', 'smtplib',
    'telnetlib', 'xmlrpc', 'ssl', 'socketserver', 'http.server', 'xmlrpc.server',
    'threading', 'multiprocessing', 'concurrent', 'asyncio',
    'bpy', 'bmesh', 'gpu', 'aud', 'bgl', 'blf',
    'bpy_extras', 'keyingsets_utils'
}

BLACKLISTED_CALLS = {
    'eval', 'exec', 'compile', 'open', 'input', 'file'
}

BLACKLISTED_ATTRS = {
    '__globals__', '__class__.__dict__', '__subclasses__', '__bases__.__dict__'
}


class SecurityError(Exception):
    """Raised when code execution violates security policies."""
    pass


class ExecutionTimeoutError(Exception):
    """Raised when code execution times out."""
    pass


@contextmanager
def execution_timeout(seconds: int = 60):
    """Context manager to limit execution time."""
    if platform.system() != 'Windows':
        def timeout_handler(signum, frame):
            raise ExecutionTimeoutError(f"Code execution timed out after {seconds} seconds")

        try:
            old_handler = signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(seconds)
            try:
                yield
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
        except (AttributeError, ValueError):
            yield
    else:
        yield


def unsanitize_python_code(code: str) -> str:
    """Reverse HTML entity encoding and backslash escapes in Python code."""
    code = html.unescape(code)
    
    escapes = {
        r'\\\\': '\\',
        r'\\n': '\n',
        r'\\r': '\r',
        r'\\t': '\t',
        r'\\"': '"',
        r"\\\'": "'",
    }
    
    for pattern, replacement in escapes.items():
        code = code.replace(pattern, replacement)
    
    return code


def create_safe_import(blacklisted_modules):
    """Create a custom __import__ function that blocks dangerous modules."""
    original_import = __import__
    
    def safe_import(name, *args, **kwargs):
        module_root = name.split('.')[0]
        if module_root in blacklisted_modules:
            raise ImportError(f"Import of module '{name}' is not allowed for security reasons")
        return original_import(name, *args, **kwargs)
    
    return safe_import


class _ThreatVisitor(ast.NodeVisitor):
    def __init__(self):
        self.issues: List[str] = []

    def visit_Import(self, node):
        for alias in node.names:
            module_name = alias.name
            module_root = module_name.split('.')[0]

            if module_root in BLACKLISTED_MODULES:
                self.issues.append(f"Import of blacklisted module '{module_name}' not allowed")
                continue

            if module_root == 'ifcopenshell' or module_name.startswith('blender_addon.api'):
                continue

        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            module_name = node.module
            module_root = module_name.split('.')[0]

            if module_root in BLACKLISTED_MODULES:
                self.issues.append(f"Import from blacklisted module '{module_name}' not allowed")
                return

            if module_root == 'ifcopenshell' or module_name.startswith('blender_addon.api'):
                self.generic_visit(node)
                return

        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name):
            if node.func.id in BLACKLISTED_CALLS:
                self.issues.append(f"Call to dangerous function '{node.func.id}()' not allowed")
        elif isinstance(node.func, ast.Attribute):
            full_name = self._get_attribute_chain(node.func)
            if full_name:
                func_root = full_name.split('.')[0]
                if func_root in {'bpy', 'bmesh', 'gpu', 'aud', 'mathutils'}:
                    self.issues.append(f"Call to Blender API function '{full_name}()' not allowed")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        attr_name = node.attr
        if attr_name in BLACKLISTED_ATTRS:
            self.issues.append(f"Access to dangerous attribute '{attr_name}' not allowed")
        self.generic_visit(node)

    def _get_attribute_chain(self, node):
        """Extract the full attribute chain like 'ifcopenshell.api.root.create_entity'."""
        parts = []
        current = node

        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value

        if isinstance(current, ast.Name):
            parts.append(current.id)
            return ".".join(reversed(parts))

        return None


def detect_threats(code: str) -> List[str]:
    """Parse code and return security threat descriptions."""
    try:
        tree = ast.parse(code)
        visitor = _ThreatVisitor()
        visitor.visit(tree)
        return visitor.issues
    except SyntaxError as e:
        return [f"Invalid Python syntax: {str(e)}"]


@register_command('execute_code', description="Execute arbitrary Blender Python code")
def execute_code(code: str) -> dict:
    """Execute Blender Python code with security checks."""
    try:
        logger.info(f"Blender code execution requested, length: {len(code)}")
        
        code = unsanitize_python_code(code)
        threats = detect_threats(code)
        
        if threats:
            logger.warning(f"Security violations detected: {threats}")
            return {"error": f"Security violation: {'; '.join(threats)}"}
        
        exec_globals = globals().copy()
        try:
            exec_globals['blenderbim'] = __import__('bonsai')
        except ImportError:
            pass
        
        output_buffer = io.StringIO()
        
        with execution_timeout(60):
            with redirect_stdout(output_buffer):
                exec(code, exec_globals)
        
        output = output_buffer.getvalue()
        logger.info("Blender code executed successfully")
        return {"output": output} if output else {"status": "success"}
        
    except SecurityError as e:
        logger.error(f"Security check failed: {e}")
        return {"error": f"Security check failed: {e}"}
    except ExecutionTimeoutError as e:
        logger.error(f"Code execution timed out: {e}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Code execution failed: {e}")
        return {"error": f"Execution failed: {e}"}


@register_command('ping', description="Simple ping test")
def ping() -> str:
    """Simple connectivity test."""
    return "pong"


@register_command('execute_ifc_code', description="Execute IFC OpenShell Python code with security checks")
def execute_ifc_code(code: str) -> Dict[str, Any]:
    """
    Execute IFC OpenShell Python code with relaxed restrictions for IFC operations.
    
    Security Policy:
    - BLOCKED: Direct Blender API access (bpy, bmesh, etc.)
    - BLOCKED: System/file/network operations (os, subprocess, socket, etc.)
    - ALLOWED: All IFC OpenShell modules and functions
    - ALLOWED: Python introspection (hasattr, getattr, etc.)
    - ALLOWED: Standard Python libraries needed for IFC work
    - ALLOWED: Your custom IFC utilities

    Parameters:
        code (str): Python code to execute. Should use IFC OpenShell APIs.

    Returns:
        Dict containing execution results or error information.
    """
    try:
        logger.info(f"IFC code execution requested, length: {len(code)}")
        
        code = unsanitize_python_code(code)
        if not code.strip():
            return {"status": "error", "error": "Empty code provided"}

        threats = detect_threats(code)
        if threats:
            logger.warning(f"Security violations detected: {threats}")
            return {
                "status": "error",
                "error": f"Security violations detected: {'; '.join(threats)}",
                "security_issues": threats
            }

        safe_import = create_safe_import(BLACKLISTED_MODULES)

        exec_globals = {
            '__builtins__': {
                'abs': abs, 'all': all, 'any': any, 'ascii': ascii, 'bin': bin,
                'bool': bool, 'bytearray': bytearray, 'bytes': bytes,
                'callable': callable, 'chr': chr, 'classmethod': classmethod,
                'complex': complex, 'delattr': delattr, 'dict': dict, 'dir': dir,
                'divmod': divmod, 'enumerate': enumerate, 'filter': filter,
                'float': float, 'format': format, 'frozenset': frozenset,
                'getattr': getattr, 'globals': globals, 'hasattr': hasattr,
                'hash': hash, 'help': help, 'hex': hex, 'id': id, 'int': int,
                'isinstance': isinstance, 'issubclass': issubclass, 'iter': iter,
                'len': len, 'list': list, 'locals': locals, 'map': map, 'max': max,
                'memoryview': memoryview, 'min': min, 'next': next, 'object': object,
                'oct': oct, 'ord': ord, 'pow': pow, 'print': print, 'property': property,
                'range': range, 'repr': repr, 'reversed': reversed, 'round': round,
                'set': set, 'setattr': setattr, 'slice': slice, 'sorted': sorted,
                'staticmethod': staticmethod, 'str': str, 'sum': sum, 'super': super,
                'tuple': tuple, 'type': type, 'vars': vars, 'zip': zip,
                '__import__': safe_import,
                'ArithmeticError': ArithmeticError, 'AssertionError': AssertionError,
                'AttributeError': AttributeError, 'BaseException': BaseException,
                'BlockingIOError': BlockingIOError, 'BrokenPipeError': BrokenPipeError,
                'BufferError': BufferError, 'BytesWarning': BytesWarning,
                'ChildProcessError': ChildProcessError, 'ConnectionAbortedError': ConnectionAbortedError,
                'ConnectionError': ConnectionError, 'ConnectionRefusedError': ConnectionRefusedError,
                'ConnectionResetError': ConnectionResetError, 'DeprecationWarning': DeprecationWarning,
                'EOFError': EOFError, 'Exception': Exception, 'FileExistsError': FileExistsError,
                'FileNotFoundError': FileNotFoundError, 'FloatingPointError': FloatingPointError,
                'FutureWarning': FutureWarning, 'GeneratorExit': GeneratorExit,
                'ImportError': ImportError, 'ImportWarning': ImportWarning,
                'IndentationError': IndentationError, 'IndexError': IndexError,
                'InterruptedError': InterruptedError, 'IsADirectoryError': IsADirectoryError,
                'KeyError': KeyError, 'KeyboardInterrupt': KeyboardInterrupt,
                'LookupError': LookupError, 'MemoryError': MemoryError,
                'ModuleNotFoundError': ModuleNotFoundError, 'NameError': NameError,
                'NotADirectoryError': NotADirectoryError, 'NotImplementedError': NotImplementedError,
                'OSError': OSError, 'OverflowError': OverflowError,
                'PendingDeprecationWarning': PendingDeprecationWarning, 'PermissionError': PermissionError,
                'ProcessLookupError': ProcessLookupError, 'RecursionError': RecursionError,
                'ReferenceError': ReferenceError, 'ResourceWarning': ResourceWarning,
                'RuntimeError': RuntimeError, 'RuntimeWarning': RuntimeWarning,
                'StopAsyncIteration': StopAsyncIteration, 'StopIteration': StopIteration,
                'SyntaxError': SyntaxError, 'SyntaxWarning': SyntaxWarning,
                'SystemError': SystemError, 'SystemExit': SystemExit,
                'TabError': TabError, 'TimeoutError': TimeoutError,
                'TypeError': TypeError, 'UnboundLocalError': UnboundLocalError,
                'UnicodeDecodeError': UnicodeDecodeError, 'UnicodeEncodeError': UnicodeEncodeError,
                'UnicodeError': UnicodeError, 'UnicodeTranslateError': UnicodeTranslateError,
                'UnicodeWarning': UnicodeWarning, 'UserWarning': UserWarning,
                'ValueError': ValueError, 'Warning': Warning, 'ZeroDivisionError': ZeroDivisionError,
                'False': False, 'True': True, 'None': None,
                'NotImplemented': NotImplemented, 'Ellipsis': Ellipsis,
                '__debug__': __debug__,
            }
        }

        try:
            import ifcopenshell
            exec_globals['ifcopenshell'] = ifcopenshell
        except ImportError:
            return {"status": "error", "error": "IFC OpenShell not available"}

        output_buffer = io.StringIO()

        with execution_timeout(60):
            with redirect_stdout(output_buffer):
                try:
                    exec(code, exec_globals)
                except Exception as exec_error:
                    return {
                        "status": "error",
                        "error": f"Execution failed: {str(exec_error)}",
                        "traceback": traceback.format_exc()
                    }

        output = output_buffer.getvalue()
        
        logger.info("IFC code executed successfully")
        return {
            "status": "success",
            "output": output if output else None,
            "code_length": len(code)
        }

    except SecurityError as e:
        logger.error(f"Security check failed: {e}")
        return {"status": "error", "error": f"Security check failed: {str(e)}"}
    except ExecutionTimeoutError as e:
        logger.error(f"IFC code execution timed out: {e}")
        return {"status": "error", "error": str(e)}
    except Exception as e:
        logger.error(f"Unexpected error in IFC code execution: {e}")
        return {
            "status": "error",
            "error": f"Unexpected error: {str(e)}",
            "traceback": traceback.format_exc()
        }