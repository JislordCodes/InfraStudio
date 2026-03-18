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
RUN cat << 'EOF' > install_addon.py
import bpy
import sys
import os

addon_path = "/opt/bonsai_addon.zip"
bpy.ops.preferences.addon_install(filepath=addon_path)
bpy.ops.preferences.addon_enable(module="bonsai")
bpy.ops.wm.save_homefile()
print("Bonsai Addon Installed successfully!")
EOF
RUN /opt/blender/blender -b -P install_addon.py

# Install MCP server python dependencies including Torch/SentenceTransformers for RAG
COPY pyproject.toml uv.lock ./
RUN uv venv && . .venv/bin/activate && uv pip install -e .
RUN . .venv/bin/activate && uv pip install boto3 uvicorn starlette watchdog
RUN . .venv/bin/activate && uv pip install torch sentence-transformers fastapi

# Initialize Knowledge Base (downloads embedding model into Docker image)
COPY scripts/init_knowledge_base.py scripts/
RUN . .venv/bin/activate && python3 scripts/init_knowledge_base.py

# Copy the rest of the application
COPY . ./

# Expose port for App Runner (Port 8080)
EXPOSE 8080

# Environment variables
ENV BLENDER_EXECUTABLE="/opt/blender/blender"
ENV AWS_REGION="us-east-1"
ENV BLENDER_MCP_HOST="127.0.0.1"
ENV BLENDER_MCP_PORT="9876"
ENV HOST="0.0.0.0"
ENV BLENDER_MCP_REMOTE_EMBEDDINGS_URL="http://127.0.0.1:8081/embeddings"

# Startup Script to run Blender Headless, RAG Embeddings Server, and FastMCP
RUN cat << 'EOF' > start.sh
#!/bin/bash
set -e

echo "Starting headless Blender on port $BLENDER_MCP_PORT..."
# Run Blender in background
/opt/blender/blender -b -P scripts/start_blender.py &
BLENDER_PID=$!

echo "Waiting for Blender to start..."
sleep 5

source .venv/bin/activate

echo "Starting RAG Embedding Server on port 8081..."
python3 scripts/embedding_server.py --model sentence-transformers/all-MiniLM-L6-v2 --host 127.0.0.1 --port 8081 --normalize &
EMB_PID=$!

echo "Starting FastMCP Server on $HOST:8080..."

# Execute the python script that starts MCP
python3 src/blender_mcp/server.py
EOF

RUN chmod +x start.sh

CMD ["./start.sh"]
