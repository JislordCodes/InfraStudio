#!/usr/bin/env python3
"""
Optional Installation script for IFC Bonsai MCP.

Provides automated setup for the IFC Bonsai MCP package, including
Claude Desktop configuration, Python package installation, and Blender
addon packaging. Each step can be run individually or all together.
"""

import os
import sys
import json
import argparse
from pathlib import Path
import shutil
import subprocess
import zipfile

ALL_EXTRAS = [
    "addon",
    "docs",
    "embedding-server",
    "rpplan",
    "standalone",
]

def find_claude_config():
    """Find the Claude Desktop config file or return the default location if not found"""
    home = Path.home()
    
    locations = {
        "windows": home / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json",
        "macos": home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
        "linux": home / ".config" / "Claude" / "claude_desktop_config.json",
    }
    
    if sys.platform.startswith("win"):
        platform = "windows"
    elif sys.platform.startswith("darwin"):
        platform = "macos"
    else:
        platform = "linux"
    
    if locations[platform].exists():
        return locations[platform]
    
    print(f"Config file not found. Will create at default location: {locations[platform]}")
    locations[platform].parent.mkdir(parents=True, exist_ok=True)
    return locations[platform]

def update_claude_config(config_path, project_path):
    """Update or create the Claude Desktop config file with MCP server settings"""
    try:
        if config_path.exists():
            with open(config_path, "r") as f:
                config = json.load(f)
        else:
            config = {}
    except json.JSONDecodeError:
        print(f"Warning: Existing config file is invalid. Creating new configuration.")
        config = {}
    
    if "mcpServers" not in config:
        config["mcpServers"] = {}
    
    config["mcpServers"]["blender"] = {
        "command": "python",
        "args": [
            "-m",
            "blender_mcp.server"
        ],
        "cwd": str(project_path)
    }
    
    try:
        with open(config_path, "w") as f:
            json.dump(config, f, indent=4)
        return True
    except Exception as e:
        print(f"Error writing config file: {str(e)}")
        return False

def install_package(extras=None, include_all_extras: bool = False):
    """Install project dependencies using uv when available."""
    extras_list = [extra for extra in (extras or []) if extra]
    uv_path = shutil.which("uv")

    if uv_path:
        cmd = [uv_path, "sync", "--in-project"]
        if include_all_extras:
            cmd.append("--all-extras")
            print("Using uv to install project dependencies with all extras")
        else:
            for extra in extras_list:
                cmd.extend(["--extra", extra])
            if extras_list:
                print(f"Using uv to install project extras: {', '.join(extras_list)}")
            else:
                print("Using uv to install project dependencies")
        try:
            subprocess.run(cmd, check=True)
            print("uv sync completed; virtual environment available in .venv")
            return True
        except subprocess.CalledProcessError as e:
            print(f"Error installing package with uv: {str(e)}")
            return False

    print("uv is not installed or not on PATH. Falling back to pip (slower, no lockfile).")
    if include_all_extras:
        extras_spec = f".[{','.join(ALL_EXTRAS)}]"
    elif extras_list:
        extras_spec = f".[{','.join(extras_list)}]"
    else:
        extras_spec = "."
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-e", extras_spec], check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error installing package with pip: {str(e)}")
        return False

def create_addon_zip(project_path: Path):
    """Create blender_addon.zip from the blender_addon folder"""
    addon_source_dir = project_path / "blender_addon"
    zip_file_path = project_path / "blender_addon.zip"
    
    if not addon_source_dir.is_dir():
        print(f"Error: Addon source directory not found at {addon_source_dir}")
        print("Make sure the 'blender_addon' folder exists with required addon files.")
        return False

    files_to_zip = list(addon_source_dir.glob('**/*.*'))
    if not files_to_zip:
        print(f"Error: No files found in {addon_source_dir} to zip.")
        return False

    try:
        print(f"Creating {zip_file_path}...")
        with zipfile.ZipFile(zip_file_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in files_to_zip:
                relative_path = file_path.relative_to(addon_source_dir.parent)
                zf.write(file_path, str(relative_path))
                
        print(f"Successfully created {zip_file_path} with {len(files_to_zip)} files.")
        return True
    except Exception as e:
        print(f"Error creating zip file: {str(e)}")
        return False

def main():
    """Main installation function with command-line arguments"""
    parser = argparse.ArgumentParser(description='Install IFC Bonsai MCP')
    
    parser.add_argument('--configure-claude', action='store_true', 
                        help='Configure Claude Desktop to use Blender MCP')
    parser.add_argument('--install-package', action='store_true', 
                        help='Install the Python package in development mode (uses uv when available)')
    parser.add_argument('--create-addon-zip', action='store_true', 
                        help='Create Blender addon zip file')
    parser.add_argument('--all', action='store_true', 
                        help='Perform all installation steps')
    parser.add_argument('--extras', type=str, default='',
                        help='Comma-separated optional dependency groups to install with the package (e.g. "addon,docs")')
    parser.add_argument('--all-extras', action='store_true',
                        help='Install the package along with every optional extra (same as uv --all-extras)')
    
    args = parser.parse_args()
    
    if not (args.configure_claude or args.install_package or 
            args.create_addon_zip or args.all):
        parser.print_help()
        return 0
    
    project_path = Path.cwd().resolve()
    print(f"Project path: {project_path}")

    extras = [extra.strip() for extra in args.extras.split(',') if extra.strip()]
    success = True
    
    if args.create_addon_zip or args.all:
        print("\nCreating Blender addon zip file...")
        if not create_addon_zip(project_path):
            print("Failed to create blender_addon.zip.")
            success = False
        else:
            print("blender_addon.zip created successfully.")

    if args.install_package or args.all:
        print("\nInstalling Python package...")
        if not install_package(extras, include_all_extras=args.all_extras):
            print("Failed to install package.")
            success = False
        else:
            print("Package installed successfully.")
    
    if args.configure_claude or args.all:
        print("\nConfiguring Claude Desktop...")
        config_path = find_claude_config()
        if config_path:
            print(f"Using config file: {config_path}")
            if update_claude_config(config_path, project_path):
                print("Claude Desktop configuration updated successfully.")
            else:
                print("Failed to update Claude Desktop configuration.")
                success = False
    
    if args.all or args.configure_claude or args.install_package or args.create_addon_zip:
        print("\nNext steps:")
        print("1. Open Blender.")
        print("2. Install the addon: Edit > Preferences > Add-ons > Install... and select blender_addon.zip")
        print("3. Enable the 'Blender MCP' addon.")
        print("4. In the 3D View sidebar (N key), find the 'BlenderMCP' tab.")
        print("5. Click 'Connect to MCP server'.")
        print("6. Open Claude Desktop or other AI assistants to use Blender MCP tools.")
        if args.install_package or args.all:
            print("7. Activate the uv-created virtual environment: on Windows `.venv\\Scripts\\activate`, on Unix `source .venv/bin/activate`.")
            print("8. Use `uv run <command>` to execute project scripts inside the environment when needed.")

    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())
