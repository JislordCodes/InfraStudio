# Headless Blender + IFC Bonsai MCP + AWS App Runner
FROM ubuntu:24.04 AS builder

# Install dependencies for downloading and extracting
RUN apt-get update && apt-get install -y \
    wget \
    xz-utils \
    curl \
    jq \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Download Blender 4.4 Linux
RUN wget https://mirror.clarkson.edu/blender/release/Blender4.4/blender-4.4.0-linux-x64.tar.xz \
    && tar -xvf blender-4.4.0-linux-x64.tar.xz \
    && mv blender-4.4.0-linux-x64 blender \
    && rm blender-4.4.0-linux-x64.tar.xz

# Download latest Bonsai Addon for Python 3.11 (Blender 4.4)
# Use GitHub API to get the actual latest release URL dynamically
RUN BONSAI_URL=$(curl -s https://api.github.com/repos/IfcOpenShell/IfcOpenShell/releases \
    | python3 -c "import sys,json; releases=json.load(sys.stdin); assets=[a for r in releases for a in r['assets'] if 'bonsai_py311' in a['name'] and 'linux-x64' in a['name']]; print(assets[0]['browser_download_url'])") \
    && echo "Downloading Bonsai from: $BONSAI_URL" \
    && wget -qO bonsai.zip "$BONSAI_URL" \
    && test -s bonsai.zip || (echo "ERROR: bonsai.zip is empty or missing" && exit 1)

# -----------------
# Final Runtime Image
# -----------------
FROM ubuntu:24.04

# Install Blender runtime dependencies (X11, OpenGL, etc.)
RUN apt-get update && apt-get install -y \
    libx11-6 \
    libxi6 \
    libxxf86vm1 \
    libxfixes3 \
    libxrender1 \
    libgl1 \
    libxkbcommon0 \
    libsm6 \
    libegl1 \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv for python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Copy Blender and Bonsai from builder
COPY --from=builder /opt/blender /opt/blender
COPY --from=builder /opt/bonsai.zip /opt/bonsai_addon.zip

# Create app directory
WORKDIR /app

# Upgrade pip and install Blender's Python dependencies
RUN /opt/blender/4.4/python/bin/python3.11 -m ensurepip
RUN /opt/blender/4.4/python/bin/python3.11 -m pip install --upgrade pip
RUN /opt/blender/4.4/python/bin/python3.11 -m pip install ifcopenshell>=0.7.0 trimesh>=3.24.0 pillow>=10.0.0 numpy>=1.26.0

# Install Bonsai Addon headlessly into Blender
RUN /opt/blender/blender -b --python-expr "import bpy; bpy.ops.preferences.addon_install(filepath='/opt/bonsai_addon.zip'); bpy.ops.preferences.addon_enable(module='bonsai'); bpy.ops.wm.save_userpref(); print('Bonsai Addon Installed')"

# Create virtualenv early for layer caching
RUN uv venv

# Copy the full application source (needed for -e install)
COPY . ./

# Install all Python dependencies in one layer for speed and reliability
# We include langchain explicitly to ensure all sub-packages (core, community, chroma, huggingface, text_splitters) are present
# Use torch cpu to save space and avoid large CUDA dependencies
RUN . .venv/bin/activate && uv pip install -e . \
    boto3 uvicorn starlette watchdog \
    torch sentence-transformers fastapi \
    langchain langchain-community langchain-huggingface langchain-chroma langchain-text-splitters requests beautifulsoup4 \
    --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple

# Initialize Knowledge Base (downloads embedding model into Docker image)
RUN . .venv/bin/activate && python3 scripts/init_knowledge_base.py

# Expose port for App Runner (Port 8080)
EXPOSE 8080

# Environment variables
ENV BLENDER_EXECUTABLE="/opt/blender/blender"
ENV AWS_REGION="us-east-1"
ENV BLENDER_MCP_HOST="127.0.0.1"
ENV BLENDER_MCP_PORT="9876"
ENV HOST="0.0.0.0"
ENV BLENDER_MCP_REMOTE_EMBEDDINGS_URL="http://127.0.0.1:8081/embeddings"
ENV PYTHONPATH="/app/src"

# Startup Script to run Blender Headless, RAG Embeddings Server, and FastMCP
RUN printf '#!/bin/bash\nset -e\necho "Starting headless Blender on port $BLENDER_MCP_PORT..."\n/opt/blender/blender -b -P scripts/start_blender.py &\nBLENDER_PID=$!\necho "Waiting for Blender to start..."\nsleep 5\nsource .venv/bin/activate\necho "Starting RAG Embedding Server on port 8081..."\npython3 scripts/embedding_server.py --model sentence-transformers/all-MiniLM-L6-v2 --host 127.0.0.1 --port 8081 --normalize &\nEMB_PID=$!\necho "Starting FastMCP Server on $HOST:8080..."\npython3 -m blender_mcp.server\n' > start.sh
RUN chmod +x start.sh

CMD ["/bin/bash", "./start.sh"]
