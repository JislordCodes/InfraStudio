#!/usr/bin/env python3
"""
Blender Package Installer

Automated installation of required Python packages in Blender's Python environment
for the IFC Bonsai MCP add-on.

Required packages:
- ifcopenshell (>=0.7.0): IFC file handling
- trimesh (>=3.24.0): 3D mesh processing
- pillow (>=10.0.0): Image processing
- numpy (>=1.26.0): Numerical computations
"""

import subprocess
import sys
import os
import platform
from pathlib import Path


import glob
import shutil

def _unique_existing(paths):
    """Filter paths to unique existing files.

    Args:
        paths: List of file paths to filter

    Returns:
        List of unique, existing file paths
    """
    seen = set()
    out = []
    for p in paths:
        if p and os.path.exists(p) and p not in seen:
            out.append(p)
            seen.add(p)
    return out

def find_blender_python():
    """Locate Blender's Python executable.

    Searches common installation paths across Windows, macOS, and Linux.

    Returns:
        List of found Python executable paths, sorted by version
    """
    system = platform.system()
    candidates = []

    if system == "Windows":
        patterns = [
            r"C:\Program Files\Blender Foundation\Blender *\*\python\bin\python.exe",
            r"C:\Program Files (x86)\Blender Foundation\Blender *\*\python\bin\python.exe",
                os.path.expanduser(r"~\Downloads\Blender*\*\python\bin\python.exe"),
            os.path.expanduser(r"~\Desktop\Blender*\*\python\bin\python.exe"),
        ]
        for pat in patterns:
            candidates.extend(glob.glob(pat))

        blender_exe = shutil.which("blender")
        if blender_exe and os.path.exists(blender_exe):
            try:
                out = subprocess.check_output(
                    [blender_exe, "-b", "--python-expr", "import sys;print(sys.executable)"],
                    text=True, timeout=10
                ).strip().splitlines()[-1].strip()
                if out and os.path.exists(out):
                    candidates.append(out)
            except Exception:
                pass

    elif system == "Darwin":  # macOS
        patterns = [
            "/Applications/Blender.app/Contents/Resources/*/python/bin/python*",
            "/Applications/Blender */Contents/Resources/*/python/bin/python*",
        ]
        for pat in patterns:
            candidates.extend(glob.glob(pat))

    elif system == "Linux":
        patterns = [
            "/usr/share/blender/*/python/bin/python*",
            "/opt/blender/*/python/bin/python*",
            os.path.expanduser("~/blender-*/*/python/bin/python*"),
        ]
        for pat in patterns:
            candidates.extend(glob.glob(pat))

    candidates = _unique_existing(candidates)
    def _ver_key(p):
        parts = [s for s in p.split(os.sep) if s.replace('.', '').isdigit()]
        return tuple(int(x) if x.isdigit() else 0 for x in (parts[-1].split('.') if parts else []))
    candidates.sort(key=_ver_key, reverse=True)

    return candidates



def install_package(python_path, package):
    """Install a Python package.

    Args:
        python_path: Path to Python executable
        package: Package specification (name with optional version)

    Returns:
        True if installation succeeded, False otherwise
    """
    try:
        print(f"Installing {package}...")
        result = subprocess.run(
            [python_path, "-m", "pip", "install", package],
            capture_output=True,
            text=True,
            check=True
        )
        print(f"[OK] Successfully installed {package}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[FAIL] Failed to install {package}: {e.stderr}")
        return False


def test_imports(python_path):
    """Verify package imports.

    Args:
        python_path: Path to Python executable

    Returns:
        True if all packages import successfully, False otherwise
    """
    test_script = '''
try:
    import ifcopenshell
    import trimesh
    import numpy as np
    from PIL import Image
    print("[OK] All packages imported successfully!")
    print(f"  ifcopenshell: {ifcopenshell.__version__}")
    print(f"  trimesh: {trimesh.__version__}")
    print(f"  numpy: {np.__version__}")
except ImportError as e:
    print(f"[FAIL] Import error: {e}")
    exit(1)
'''
    
    try:
        result = subprocess.run(
            [python_path, "-c", test_script],
            capture_output=True,
            text=True,
            check=True
        )
        print(result.stdout)
        return True
    except subprocess.CalledProcessError as e:
        print(e.stdout)
        print(e.stderr)
        return False


def main():
    """Main entry point."""
    print("Blender Package Installer for IFC Bonsai MCP")
    print("=" * 50)

    required_packages = [
        "ifcopenshell>=0.7.0",
        "trimesh>=3.24.0",
        "pillow>=10.0.0",
        "numpy>=1.26.0"
    ]

    python_paths = find_blender_python()
    
    if not python_paths:
        print("[ERROR] Could not automatically find Blender's Python executable.")
        print("\nManual installation required:")
        print("1. Open Blender")
        print("2. Go to Scripting workspace") 
        print("3. In the Python console, run:")
        print("   import subprocess, sys")
        for package in required_packages:
            print(f'   subprocess.check_call([sys.executable, "-m", "pip", "install", "{package}"])')
        return
    
    if len(python_paths) == 1:
        python_path = python_paths[0]
        print(f"Found Blender Python: {python_path}")
    else:
        print("Multiple Blender installations found:")
        for i, path in enumerate(python_paths):
            print(f"  {i + 1}. {path}")
        
        while True:
            try:
                choice = int(input(f"\nSelect Blender installation (1-{len(python_paths)}): ")) - 1
                if 0 <= choice < len(python_paths):
                    python_path = python_paths[choice]
                    break
                else:
                    print("Invalid choice. Please try again.")
            except ValueError:
                print("Please enter a valid number.")
    
    print(f"Using Blender Python: {python_path}")

    try:
        result = subprocess.run([python_path, "--version"], capture_output=True, text=True, check=True)
        print(f"Python version: {result.stdout.strip()}")
    except subprocess.CalledProcessError:
        print(f"[ERROR] Cannot execute Python at {python_path}")
        return

    print(f"\nInstalling {len(required_packages)} required packages...")
    success_count = 0
    
    for package in required_packages:
        if install_package(python_path, package):
            success_count += 1
    
    print(f"[SUMMARY] Installation Summary: {success_count}/{len(required_packages)} packages installed successfully")

    if success_count == len(required_packages):
        print("\n[TEST] Testing imports...")
        if test_imports(python_path):
            print("[SUCCESS] All packages installed and working correctly!\n")
        else:
            print("\n[WARNING] Packages installed but import test failed.")
            print("Please check for any error messages above.")
    else:
        print(f"\n[WARNING] Only {success_count} out of {len(required_packages)} packages were installed successfully.")
        print("Please check the error messages above and try manual installation.")


if __name__ == "__main__":
    main()
