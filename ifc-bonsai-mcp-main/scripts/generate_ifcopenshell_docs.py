"""
IFC OpenShell API documentation generator.

Fetches and processes documentation from the IFC OpenShell GitHub repository,
extracting module and function docstrings to create a comprehensive API reference
for use with LLMs and knowledge bases.
"""

import ast
import urllib.request
from datetime import datetime
from pathlib import Path
import time
from tqdm import tqdm

base_url = "https://raw.githubusercontent.com/IfcOpenShell/IfcOpenShell/v0.8.0/src/ifcopenshell-python/ifcopenshell/api/"

folders = ['aggregate', 'alignment', 'attribute', 'boundary', 'classification', 'cogo', 'constraint', 'context', 'control', 'cost', 'document', 'drawing', 'feature', 'geometry', 'georeference', 'grid', 'group', 'layer', 'library', 'material', 'nest', 'owner', 'profile', 'project', 'pset', 'pset_template', 'resource', 'root', 'sequence', 'spatial', 'structural', 'style', 'system', 'type', 'unit']

def get_docstring(code):
    try:
        tree = ast.parse(code)
        docstring = ast.get_docstring(tree)
        return docstring
    except Exception as e:
        return f"Error parsing docstring: {e}"

def get_function_docstrings(code, func_name):
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == func_name:
                doc = ast.get_docstring(node)
                return doc
            elif isinstance(node, ast.ClassDef) and node.name == func_name:
                doc = ast.get_docstring(node)
                return doc
        return None
    except Exception as e:
        return f"Error parsing function docstring: {e}"

def get_all_functions(code):
    try:
        tree = ast.parse(code)
        all_funcs = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == '__all__':
                        if isinstance(node.value, ast.List):
                            for elt in node.value.elts:
                                if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                    all_funcs.append(elt.value)
                                elif isinstance(elt, ast.Str):  # Backward compatibility
                                    all_funcs.append(elt.s)
                                elif hasattr(elt, 'value') and isinstance(elt.value, str):
                                    all_funcs.append(elt.value)
        return all_funcs
    except Exception as e:
        return []

def main():
    start_time = time.time()
    print("Starting IFC OpenShell API documentation generation...")
    print(f"Fetching from: {base_url}")
    
    docs = {}
    total_modules = len(folders) + 1  # +1 for root
    
    total_functions_processed = 0
    total_functions_found = 0
    
    print("\nProcessing root module...")
    url = base_url + "__init__.py"
    try:
        with urllib.request.urlopen(url) as response:
            code = response.read().decode('utf-8')
        module_doc = get_docstring(code)
        all_funcs = get_all_functions(code)
        docs['root'] = {'module': module_doc, 'all': all_funcs, 'functions': {}}
        total_functions_found += len(all_funcs)
        
        if all_funcs:
            print(f"   Found {len(all_funcs)} functions in root module")
            for func in tqdm(all_funcs, desc="   Processing root functions", leave=False):
                func_url = base_url + "root/" + func + ".py"
                try:
                    with urllib.request.urlopen(func_url) as response:
                        func_code = response.read().decode('utf-8')
                    doc = get_function_docstrings(func_code, func)
                    if doc:
                        docs['root']['functions'][func] = doc
                    total_functions_processed += 1
                except Exception as e:
                    docs['root']['functions'][func] = f"Error fetching: {e}"
                    total_functions_processed += 1
        else:
            print("   No functions found in root module")
    except Exception as e:
        docs['root'] = {'module': f"Error: {e}", 'all': [], 'functions': {}}
        print(f"   ERROR: Error processing root module: {e}")

    print(f"\nProcessing {len(folders)} additional modules...")
    
    for folder in tqdm(folders, desc="Processing modules"):
        url = base_url + folder + "/__init__.py"
        module_start_time = time.time()
        
        try:
            with urllib.request.urlopen(url) as response:
                code = response.read().decode('utf-8')
            module_doc = get_docstring(code)
            all_funcs = get_all_functions(code)
            docs[folder] = {'module': module_doc, 'all': all_funcs, 'functions': {}}
            total_functions_found += len(all_funcs)
            
            if all_funcs:
                for func in tqdm(all_funcs, desc=f"   {folder}", leave=False):
                    func_url = base_url + folder + "/" + func + ".py"
                    try:
                        with urllib.request.urlopen(func_url) as response:
                            func_code = response.read().decode('utf-8')
                        doc = get_function_docstrings(func_code, func)
                        if doc:
                            docs[folder]['functions'][func] = doc
                        else:
                            docs[folder]['functions'][func] = "No docstring found"
                        total_functions_processed += 1
                    except Exception as e:
                        docs[folder]['functions'][func] = f"Error fetching: {e}"
                        total_functions_processed += 1
            
            module_time = time.time() - module_start_time
            tqdm.write(f"   COMPLETED {folder}: {len(all_funcs)} functions ({module_time:.1f}s)")
            
        except Exception as e:
            docs[folder] = {'module': f"Error: {e}", 'all': [], 'functions': {}}
            tqdm.write(f"   ERROR {folder}: {e}")

    script_dir = Path(__file__).parent
    docs_dir = script_dir.parent / "docs"
    output_file = docs_dir / "ifcopenshell_api_docs.txt"
    
    docs_dir.mkdir(exist_ok=True)
    
    print(f"\nWriting documentation to file...")
    processing_time = time.time() - start_time
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("# IFC OpenShell API Documentation\n\n")
        f.write("## Metadata\n\n")
        f.write("- **Source Repository**: https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0\n")
        f.write(f"- **Fetched Date**: {datetime.now().strftime('%B %d, %Y')}\n")
        f.write(f"- **Fetched Time**: {datetime.now().strftime('%H:%M:%S')} UTC\n")
        f.write("- **Repository Description**: Open source IFC library and geometry engine\n")
        f.write("- **License**: LGPL-3.0, GPL-3.0\n")
        f.write("- **Owner**: IfcOpenShell\n")
        f.write("- **Stars**: 2.2k\n")
        f.write("- **Forks**: 814\n")
        f.write("- **Version**: v0.8.0\n")
        f.write("- **Generated by**: Automated crawler script (generate_ifcopenshell_docs.py)\n")
        f.write("- **Purpose**: LLM-ready documentation of IFC OpenShell Python API\n")
        f.write(f"- **Processing Time**: {processing_time:.2f} seconds\n")
        f.write(f"- **Functions Processed**: {total_functions_processed}/{total_functions_found}\n\n")
        f.write("This document contains the API documentation for IFC OpenShell, organized by module.\n")
        f.write("Each module has a description, list of available functions, and their docstrings where available.\n\n")
        
        modules_to_write = list(docs.items())
        for key, value in tqdm(modules_to_write, desc="Writing modules to file"):
            f.write(f"## Module: {key}\n\n")
            if value['module']:
                f.write("### Description\n")
                f.write(value['module'] + "\n\n")
            if value['all']:
                f.write("### Available Functions\n")
                for func in value['all']:
                    f.write(f"- {func}\n")
                f.write("\n")
            if value['functions']:
                f.write("### Function Docstrings\n")
                for func, doc in value['functions'].items():
                    f.write(f"#### {func}\n")
                    f.write(doc + "\n\n")
    
    total_time = time.time() - start_time
    file_size = output_file.stat().st_size / 1024  # KB
    
    print("\n" + "="*80)
    print("DOCUMENTATION GENERATION COMPLETE")
    print("="*80)
    print(f"Output file: {output_file}")
    print(f"File size: {file_size:.1f} KB")
    print(f"Total time: {total_time:.2f} seconds")
    print(f"Modules processed: {len(docs)}")
    print(f"Functions found: {total_functions_found}")
    print(f"Functions processed: {total_functions_processed}")
    print(f"Success rate: {(total_functions_processed/max(total_functions_found,1)*100):.1f}%")
    print(f"Average speed: {total_functions_processed/max(total_time,1):.1f} functions/second")
    print("="*80)

if __name__ == "__main__":
    main()
