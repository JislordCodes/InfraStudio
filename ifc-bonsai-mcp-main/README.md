# IFC Bonsai MCP

IFC-Bonsai-MCP is an MCP server that connects AI language models with the [Bonsai](https://extensions.blender.org/add-ons/bonsai/) Blender add-on to read, create, and edit IFC models directly via high-level tool calls. 

> This repository is associated with the paper: **MCP4IFC: IFC-Based Building Design using Large Language Models** | [Project Page](https://show2instruct.github.io/mcp4ifc/) · [arXiv](https://arxiv.org/abs/2511.05533) · [Experiment Results](https://drive.google.com/drive/folders/1aeheOPQG9IUZf0TVAyczumG9J_ZUr5Ad?usp=sharing)

**🚀 Highlights:**
- **AI-Driven BIM**: Use natural language to create and edit IFC elements like walls, doors, roofs, and stairs directly within Blender.
- **RAG-Powered Knowledge**: Leverage a Retrieval-Augmented Generation system with a local vector index for instant, semantic search across IFC and IfcOpenShell documentation.
- **Advanced Geometry Generation**: Create complex 3D geometry using Python and [Trimesh](https://trimesh.org/), with tools to convert procedural meshes into native IFC elements.
- **Extensible Toolset**: A comprehensive set of over 50 MCP tools for scene analysis, object manipulation, parametric creation, and knowledge retrieval.

## Installation Guide

### Prerequisites

- [Blender 4.4+](https://www.blender.org/download/) with [Bonsai Add-on 0.8.2+](https://extensions.blender.org/add-ons/bonsai/)
- [Python 3.10+](https://www.python.org/downloads/) (ensure it's in your PATH)
- [UV Package Manager](https://docs.astral.sh/uv/getting-started/installation/): `pip install uv`
- [Claude Desktop](https://claude.ai/download) or any MCP-compatible client

### Quick Installation

This is a quick overview of installation steps in the global Python environment. For more details or virtual environment setup, check the section below.

```bash
# 1. Clone and setup
git clone [REPOSITORY_URL] && cd [REPOSITORY_NAME]

# 2. Install dependencies
pip install uv
uv sync

# 3. Install Blender packages (automatic)
python scripts/install_blender_packages.py

# 4. Create the zip file of blender_addon folder manually or use the helper script:
python scripts/install.py --create-addon-zip
# Then: Blender → Edit → Preferences → Add-ons → Install → blender_addon.zip
# After installing the add-on: Go to Blender UI → Sidebar Add-On Panel → BlenderMCP → Click "Connect to MCP server"

# 5. Configure Claude Desktop (Edit Config in Settings → Developer)
# Add: 
# {
#   "mcpServers": {
#     "blender": {
#       "command": "python",
#       "args": ["-m", "blender_mcp.server"],
#     }
#   }
# }

# 6. (Optional) Setup knowledge base
uv run python scripts/init_knowledge_base.py
uv run python scripts/embedding_server.py --model sentence-transformers/all-MiniLM-L6-v2 --host 127.0.0.1 --port 8080 --normalize
```

Here is the workflow diagram in Claude Desktop for reference:
[![Workflow Diagram](./figs/workflow.png)](./figs/workflow.png)

If there are any issues, please refer to the detailed installation steps below.

### Step-by-Step Installation

- **Step 1**: Clone and navigate to the project
  
   ```bash
   git clone [REPOSITORY_URL]
   cd [REPOSITORY_NAME]
   ```

- **Step 2**: Create and set up the virtual environment. This is for the MCP server that will run in the system/virtual environment.
   ```bash
   uv sync
   # Creates virtual environment: If `.venv/` doesn't exist, it creates one and installs all dependencies
   # Uses lock file: Ensures exact same versions as specified in `uv.lock`
   # Check https://docs.astral.sh/uv/ for using custom venv paths or names.
   ```
   Activate the virtual environment:
   ```bash
   source .venv/bin/activate    # Linux/macOS
  .venv\Scripts\activate       # Windows
   ```

  (Alternative) For a global installation, install all dependencies in your system Python environment:

   ```bash
   uv pip install . # records the install in uv.lock
   pip install .    # or, with pip
   ```

- **Step 3**: Install Blender-specific packages (Required). These are required for the Blender add-on to function correctly.

  The MCP server runs in your system's Python environment, but the Blender add-on runs inside Blender's Python environment. Some packages need to be installed specifically in Blender:

  - Option A: Automatic Installation (Recommended) using the helper script:
      
      ```bash
      python scripts/install_blender_packages.py
      ```
      This script automatically finds your Blender installation(s), installs all required packages (ifcopenshell, trimesh, pillow, numpy), and tests that everything works correctly

  - Option B: Manual Installation
      ```bash
      # Navigate to Blender's Python directory (adjust path for your Blender installation)
      # Windows (typical path):
      cd "C:\Program Files\Blender Foundation\Blender 4.4\4.4\python\bin"

      # Install required packages for Blender add-on
      python.exe -m pip install ifcopenshell>=0.7.0
      python.exe -m pip install trimesh>=3.24.0  
      python.exe -m pip install pillow>=10.0.0
      python.exe -m pip install numpy>=1.26.0
      ```

   - Option C: Using Blender's Console
      ```python
      # 1. Open Blender
      # 2. Go to Scripting workspace
      # 3. Run this in the Python console:
      import subprocess
      import sys
      subprocess.check_call([sys.executable, "-m", "pip", "install", "ifcopenshell>=0.7.0", "trimesh>=3.24.0", "pillow>=10.0.0", "numpy>=1.26.0"])
      ```

### Blender Add-on Packaging
The Blender add-on enables communication between Blender and the MCP server. To install it:
1. Create a zip file of the `blender_addon` folder
   - Either manually or run `python scripts/install.py --create-addon-zip`
2. In Blender, go to `Edit > Preferences > Add-ons > Install...`
3. Select the `blender_addon.zip` file and activate the add-on
4. In the main Blender UI, open `Sidebar Add-On Panel → BlenderMCP → Connect to MCP server`. Check `/figs/workflow.png` for reference.

## Configuring Claude Desktop

### For Virtual Environment Installation
If you installed using a virtual environment, you need to point Claude to the Python executable in the virtual environment:

1. Open Claude Desktop > Settings > Developer > Edit Config File.
2. Add this configuration:
   ```json
   {
     "mcpServers": {
       "blender": {
         "command": "C:\\path\\to\\ifc-bonsai-mcp\\.venv\\Scripts\\python.exe",
         "args": ["-m", "blender_mcp.server"],
       }
     }
   }
   ```
   Note: On Windows, use double backslashes (`\\`) in file paths. On macOS and Linux, use forward slashes (`/`).
   

### For Global Installation
If you installed globally, use the system Python:
```json
{
  "mcpServers": {
    "blender": {
      "command": "python",
      "args": ["-m", "blender_mcp.server"],
    }
  }
}
```

3. Important: Replace `C:/path/to/ifc-bonsai-mcp` with your actual project path
4. Restart Claude Desktop

## Running the MCP Server

> **Important**: Since the project tries to save to an IFC file and loads it, always create an empty file and save it before doing any operations. Because the MCP server directly loads the IFC file and does the edits. If a new project is created and no .ifc file is saved, then the MCP server will not update in the actual blender scene. Just do ctrl (cmd) + S and save an empty IFC file if a new project is created.

> If there are connection issues please check if the "Connect to MCP server" button in the Blender add-on panel has been clicked. Check the `/figs/workflow.png` to see where it is located.

> **Code Execution Limitations**: The general `execute_code` tool behaves unpredictably with IFC operations. The general execute code tool lacks proper context handling, cannot save changes back to the model consistently and may produce unsafe results for IFC operations. Consider disabling the general `execute_code` tool if there are issues.


## Knowledge Base & Embeddings
The MCP server includes a RAG-powered tool to query IFC documentation and best practices. This uses a local ChromaDB index and an embedding model (Sentence Transformers). To use the RAG-powered IFC knowledge base, follow these steps:
- Initialize the Local Chroma Index
   ```bash
   uv run python scripts/init_knowledge_base.py
   ```
   This downloads the embedding model (Sentence Transformers) and caches the IFC knowledge base under `.cache/chromadb/`.

- Run the embedding model so the MCP server can use it for embedding generation:
   ```bash
   uv run python scripts/embedding_server.py --model sentence-transformers/all-MiniLM-L6-v2 --host 127.0.0.1 --port 8080 --normalize
   ```
   This starts a local embedding server that the MCP server can use for embedding generation. Adjust the model and port as needed. If the port is changed, the `BLENDER_MCP_REMOTE_EMBEDDINGS_URL` environment variable must be set accordingly.

## List of Available Tools
The MCP server has various tools that can be called by the AI assistant. All available tools and their parameters are documented in the [API Reference](./docs/api-reference.md).

<details>
<summary>Click to expand the summary of the available tools:</summary>



| Tool Name | Description |
|-----------|-------------|
| **Analysis Tools** |
| `capture_blender_window_screenshot` | Capture high-quality screenshot of entire Blender window |
| `capture_blender_3dviewport_screenshot` | Capture screenshot of only the 3D viewport area |
| **API Tools** |
| `execute_blender_code` | Execute arbitrary Python code in Blender context |
| `list_blender_commands` | List all available Blender addon commands |
| `execute_ifc_code_tool` | Execute IFC OpenShell code with security restrictions |
| `get_scene_info` | Get basic information about current Blender scene |
| `get_blender_object_info` | Get detailed Blender information about specific object |
| `get_selected_objects` | Get list of currently selected objects with GUID info |
| `get_object_info` | Get IFC object information from GUIDs or selection |
| `get_ifc_scene_overview` | Get comprehensive IFC scene overview |
| `create_wall` | Create parametric IFC wall with full control |
| `create_two_point_wall` | Create wall between two 3D points |
| `create_polyline_walls` | Create connected walls along polyline path |
| `update_wall` | Update existing wall properties using GUID |
| `get_wall_properties` | Get properties of existing wall by GUID |
| `get_roof_types` | Get all supported roof types and descriptions |
| `create_roof` | Create parametric IFC roof from polyline outline |
| `update_roof` | Update existing roof properties and regenerate geometry |
| `delete_roof` | Delete one or more roofs with comprehensive cleanup |
| `create_slab` | Create parametric IFC slab with custom geometry |
| `update_slab` | Update existing slab geometric properties |
| `get_slab_properties` | Get comprehensive properties of existing slab |
| `get_door_operation_types` | Get all supported door operation types |
| `create_door` | Create parametric IFC door with detailed properties |
| `update_door` | Update existing door properties using GUID |
| `get_door_properties` | Get properties of existing door by GUID |
| `get_window_partition_types` | Get all supported window partition types |
| `create_window` | Create parametric IFC window with customization |
| `update_window` | Update existing window properties using GUID |
| `get_window_properties` | Get detailed properties of existing window |
| `create_trimesh_ifc` | Execute Trimesh code and create IFC element |
| `get_stairs_types` | Get all supported stairs types and IFC mappings |
| `create_stairs` | Create parametric IFC stairs with various types |
| `update_stairs` | Update existing stairs properties and geometry |
| `delete_stairs` | Delete one or more stairs by their GUIDs |
| `create_surface_style` | Create basic surface style with color/transparency |
| `create_pbr_style` | Create PBR style with advanced material properties |
| `apply_style_to_object` | Apply style directly to IFC objects |
| `list_styles` | List all available styles in current IFC model |
| `update_style` | Update properties of existing style |
| `remove_style` | Remove style from the model |
| `create_mesh_ifc` | Create IFC element from JSON mesh data |
| `list_ifc_entities` | List valid IFC entity classes for mesh generation |
| `get_trimesh_examples` | Get comprehensive Trimesh code examples |
| **RAG Tools** |
| `ensure_ifc_knowledge_ready` | Initialize IFC knowledge system for local model |
| `search_ifc_knowledge` | Search IFC knowledge base with semantic search |
| `get_ifc_knowledge_status` | Get current status of IFC knowledge base system |
| `find_ifc_function` | Find IFC functions by operation and object type |
| `get_ifc_module_info` | Get detailed information about specific IFC module |
| `get_ifc_function_details` | Get comprehensive details about specific IFC function |
| `clear_ifc_knowledge_cache` | Clear cached IFC knowledge data |
| `get_cache_statistics` | Get detailed cache usage statistics |

</details>


## Contributing
Pull requests are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for any issues.

## Acknowledgements
This is not an official Blender, Bonsai or IfcOpenShell project. Thanks to [BlenderMCP](https://github.com/ahujasid/blender-mcp) and [Bonsai_mcp](https://github.com/JotaDeRodriguez/Bonsai_mcp) for their open source work.

## Citation
Please consider citing our work if you find it useful or used in your research.

```bibtex
@misc{nithyanantham2025mcp4ifcifcbasedbuildingdesign,
      title={MCP4IFC: IFC-Based Building Design Using Large Language Models}, 
      author={Bharathi Kannan Nithyanantham and Tobias Sesterhenn and Ashwin Nedungadi and Sergio Peral Garijo and Janis Zenkner and Christian Bartelt and Stefan Lüdtke},
      year={2025},
      eprint={2511.05533},
      archivePrefix={arXiv},
      primaryClass={cs.CL},
      url={https://arxiv.org/abs/2511.05533}, 
}
``` 

<!-- ## Contact
Please contact us if you have any questions related to the MCP server: bharathikannan.nithyanantham@uni-rostock.de -->