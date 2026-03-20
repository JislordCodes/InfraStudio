'''
API documentation generator for MCP tools.

Automatically extracts and formats documentation from MCP tool functions
decorated with @mcp.tool, generating a comprehensive markdown reference.
'''

import os
import ast

MCP_FUNCTIONS_DIR = os.path.join(
    os.path.dirname(__file__),
    "..", "src", "blender_mcp", "mcp_functions"
)
MCP_FUNCTIONS_DIR = os.path.abspath(MCP_FUNCTIONS_DIR)
OUTPUT_MD = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs", "api-reference.md"))

def is_mcp_tool(func_node):
    if not hasattr(func_node, "decorator_list"):
        return False
    for deco in func_node.decorator_list:
        if isinstance(deco, ast.Call) and hasattr(deco.func, "attr"):
            if deco.func.attr == "tool":
                return True
    return False

def extract_tools_from_file(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()
    tree = ast.parse(source, filename=filepath)
    tools = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and is_mcp_tool(node):
            docstring = ast.get_docstring(node) or ""
            args = []
            defaults = []
            
            for i, arg in enumerate(node.args.args):
                if arg.arg in ("self", "ctx"):
                    continue
                args.append(arg.arg)
            
            if node.args.defaults:
                num_defaults = len(node.args.defaults)
                num_args = len(args)
                for i, default in enumerate(node.args.defaults):
                    arg_index = num_args - num_defaults + i
                    if arg_index >= 0:
                        if isinstance(default, ast.Constant):
                            defaults.append((args[arg_index], default.value))
                        elif isinstance(default, ast.Name):
                            defaults.append((args[arg_index], default.id))
                        else:
                            defaults.append((args[arg_index], "..."))
            
            annotations = {}
            for arg in node.args.args:
                if arg.arg in ("self", "ctx"):
                    continue
                if arg.annotation:
                    if isinstance(arg.annotation, ast.Name):
                        annotations[arg.arg] = arg.annotation.id
                    elif isinstance(arg.annotation, ast.Subscript):
                        annotations[arg.arg] = ast.unparse(arg.annotation)
                    else:
                        annotations[arg.arg] = ast.unparse(arg.annotation)
            
            return_type = None
            if node.returns:
                if isinstance(node.returns, ast.Name):
                    return_type = node.returns.id
                else:
                    return_type = ast.unparse(node.returns)
            
            signature = f"{node.name}({', '.join(args)})"
            tools.append({
                "name": node.name,
                "signature": signature,
                "args": args,
                "defaults": dict(defaults),
                "annotations": annotations,
                "return_type": return_type,
                "docstring": docstring,
                "file": os.path.basename(filepath),
            })
    return tools

def format_function_signature(tool):
    """Format function signature with types and defaults"""
    parts = []
    for arg in tool["args"]:
        part = arg
        if arg in tool["annotations"]:
            part += f": {tool['annotations'][arg]}"
        if arg in tool["defaults"]:
            default = tool["defaults"][arg]
            if isinstance(default, str):
                part += f' = "{default}"'
            else:
                part += f" = {default}"
        parts.append(part)
    
    signature = f"{tool['name']}({', '.join(parts)})"
    if tool["return_type"]:
        signature += f" -> {tool['return_type']}"
    return signature

def generate_toc(all_tools):
    """Generate table of contents"""
    toc_lines = ["## Table of Contents", ""]
    
    for filename in sorted(set(tool["file"] for tool in all_tools)):
        file_tools = [t for t in all_tools if t["file"] == filename]
        if file_tools:
            module_name = filename.replace(".py", "").replace("_", " ").title()
            toc_lines.append(f"- **[{module_name}](#{filename.replace('.py', '').replace('_', '-')})**")
            for tool in file_tools:
                toc_lines.append(f"  - [{tool['name']}](#{tool['name'].lower().replace('_', '-')})")
    
    toc_lines.append("")
    return toc_lines

def main():
    all_tools = []
    for fname in sorted(os.listdir(MCP_FUNCTIONS_DIR)):
        if not fname.endswith(".py") or fname == "__init__.py":
            continue
        fpath = os.path.join(MCP_FUNCTIONS_DIR, fname)
        tools = extract_tools_from_file(fpath)
        all_tools.extend(tools)
    
    if not all_tools:
        print("No MCP tools found!")
        return
    
    md_lines = [
        "---",
        "layout: default",
        "title: MCP Tools API Reference", 
        "---",
        "",
        "# MCP Tools API Reference",
        "",
        "> **Note: This file is auto-generated. Do not edit manually.**",
        "",
        f"*Last updated: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*",
        "",
        f"Total tools found: {len(all_tools)} across {len(set(tool['file'] for tool in all_tools))} modules.",
        ""
    ]
    
    md_lines.extend(generate_toc(all_tools))
    
    files_processed = set()
    for fname in sorted(os.listdir(MCP_FUNCTIONS_DIR)):
        if not fname.endswith(".py") or fname == "__init__.py":
            continue
        
        file_tools = [t for t in all_tools if t["file"] == fname]
        if not file_tools:
            continue
            
        module_name = fname.replace(".py", "").replace("_", " ").title()
        anchor = fname.replace(".py", "").replace("_", "-")
        md_lines.extend([
            f"## {module_name}",
            f"*File: `{fname}`*",
            "",
            f"This module contains {len(file_tools)} tool(s):",
            ""
        ])
        
        for tool in file_tools:
            anchor_name = tool['name'].lower().replace('_', '-')
            md_lines.extend([
                f"### `{tool['name']}`",
                "",
                "```python",
                format_function_signature(tool),
                "```",
                ""
            ])
            
            if tool["docstring"]:
                docstring = tool["docstring"].strip()
                
                has_code_blocks = ("import " in docstring or
                                 "def " in docstring or
                                 "class " in docstring or
                                 "# =" in docstring or
                                 "# -" in docstring or
                                 "ifcopenshell" in docstring or
                                 docstring.count("#") > 3)
                
                if has_code_blocks:
                    md_lines.extend([
                        "```python",
                        docstring,
                        "```"
                    ])
                elif "Parameters:" in docstring or "Args:" in docstring:
                    parts = docstring.split("Parameters:")
                    if len(parts) == 1:
                        parts = docstring.split("Args:")
                    
                    if len(parts) > 1:
                        desc = parts[0].strip()
                        params = parts[1].strip()
                        
                        md_lines.append(desc)
                        md_lines.append("")
                        md_lines.append("**Parameters:**")
                        md_lines.append("")
                        
                        for line in params.split('\n'):
                            if line.strip():
                                if line.strip().startswith('- ') or line.strip().startswith('* '):
                                    md_lines.append(line.strip())
                                elif ':' in line and not line.strip().startswith(' '):
                                    md_lines.append(f"- **{line.strip()}**")
                                else:
                                    md_lines.append(f"  {line.strip()}")
                    else:
                        md_lines.append(docstring)
                else:
                    md_lines.append(docstring)
            else:
                md_lines.append("_No documentation provided._")
            
            md_lines.extend(["", "---", ""])
    
    if md_lines[-3:] == ["", "---", ""]:
        md_lines = md_lines[:-3]
    
    md_lines.extend([
        "",
        "---",
        ""
    ])
    
    with open(OUTPUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))
    
    print(f"Documentation generated at {OUTPUT_MD}")
    print(f"Found {len(all_tools)} MCP tools across {len(set(tool['file'] for tool in all_tools))} files.")

if __name__ == "__main__":
    main()
