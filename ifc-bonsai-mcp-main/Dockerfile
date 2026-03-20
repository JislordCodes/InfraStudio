# ─────────────────────────────────────────────────────────────────────────────
# ifc-bonsai-mcp  —  AWS App Runner Docker Image
#
# Architecture:
#   - Blender 4.4.3 (headless, with Bonsai/blendermcp addon)  → socket on 9876
#   - Embedding Server (sentence-transformers, offline)        → HTTP on 9090
#   - MCP SSE Server  (FastMCP + all IFC tools)               → HTTP on 8080
#
# All three processes are managed by supervisord.
# App Runner routes HTTPS traffic → port 8080 (MCP SSE Server).
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

# ── System dependencies ────────────────────────────────────────────────────
# Blender 4.4 headless requires: X11 stubs, OpenGL stub, libXi, libXxf86vm
# ChromaDB requires: libsqlite3-dev (bundled in python:slim but confirm) 
# supervisor: process manager
# wget + xz-utils: Blender download + extraction
# zip: packaging the blender_addon zip
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget \
        xz-utils \
        zip \
        curl \
        git \
        supervisor \
        libx11-6 \
        libxxf86vm1 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libsm6 \
        libxrender1 \
        libxext6 \
    && rm -rf /var/lib/apt/lists/*

# ── Install uv (fast pip replacement) ─────────────────────────────────────
RUN pip install --no-cache-dir uv

# ── Set workdir and copy the project ──────────────────────────────────────
WORKDIR /app
COPY . .

# ── Install MCP server Python dependencies (system-wide via uv) ───────────
# We use uv sync to respect the lock file for reproducible installs.
# torch is a large optional dep; install cpu-only to save image space.
RUN uv pip install --system torch --index-url https://download.pytorch.org/whl/cpu && \
    uv pip install --system -e . && \
    uv pip install --system \
        sentence-transformers \
        chromadb \
        fastapi \
        uvicorn[standard]

# ── Download and install Blender 4.4.3 Linux binaries ─────────────────────
ENV BLENDER_VERSION=4.4.3
ENV BLENDER_DIR=/opt/blender-${BLENDER_VERSION}-linux-x64

RUN echo "=== Downloading Blender ${BLENDER_VERSION} ===" && \
    wget -q --retry-connrefused --waitretry=5 --tries=5 --no-check-certificate \
        https://download.blender.org/release/Blender4.4/blender-${BLENDER_VERSION}-linux-x64.tar.xz \
        -O /tmp/blender.tar.xz && \
    echo "=== Extracting Blender ===" && \
    tar -xf /tmp/blender.tar.xz -C /opt/ && \
    rm /tmp/blender.tar.xz && \
    ln -s ${BLENDER_DIR}/blender /usr/local/bin/blender && \
    echo "=== Blender installed: $(blender --version | head -1) ==="

# ── Install required packages into Blender's Python environment ────────────
# Blender ships its own Python 3.11; packages here must be in THAT environment.
ENV BLENDER_PYTHON=${BLENDER_DIR}/4.4/python/bin/python3.11

RUN echo "=== Installing Blender Python packages ===" && \
    ${BLENDER_PYTHON} -m pip install --upgrade pip && \
    ${BLENDER_PYTHON} -m pip install \
        "ifcopenshell>=0.7.0" \
        "trimesh>=3.24.0" \
        "pillow>=10.0.0" \
        "numpy>=1.26.0" && \
    echo "=== Verifying Blender Python packages ===" && \
    ${BLENDER_PYTHON} -c "import ifcopenshell; import trimesh; import numpy; print('All Blender packages OK')"

# ── Install the Blender addon (blendermcp) ────────────────────────────────
# Pack blender_addon/ into a zip, install it into Blender's addon directory,
# then enable it so Blender can load it at startup with --addons blendermcp.
ENV BLENDER_ADDONS_DIR=${BLENDER_DIR}/4.4/scripts/addons

RUN echo "=== Packaging blender_addon ===" && \
    cd /app && \
    # Create the zip from the blender_addon directory
    zip -r /tmp/blendermcp.zip blender_addon/ && \
    # Install into Blender's addons directory (unzip under the addons dir)
    mkdir -p ${BLENDER_ADDONS_DIR}/blendermcp && \
    unzip -q /tmp/blendermcp.zip -d /tmp/blendermcp_unzip && \
    cp -r /tmp/blendermcp_unzip/blender_addon/* ${BLENDER_ADDONS_DIR}/blendermcp/ && \
    rm -rf /tmp/blendermcp.zip /tmp/blendermcp_unzip && \
    echo "=== blendermcp addon installed to ${BLENDER_ADDONS_DIR}/blendermcp ==="

# ── Pre-build the RAG knowledge base / ChromaDB index ─────────────────────
# This bakes the Chroma index and HuggingFace model cache INTO the image,
# so there is ZERO runtime download and ZERO cold-start delay for RAG.
ENV BLENDER_MCP_EMBEDDING_OFFLINE=0
ENV PYTHONPATH=/app/src

RUN echo "=== Building RAG knowledge base (runs once at image build time) ===" && \
    python scripts/init_knowledge_base.py \
        --model sentence-transformers/all-MiniLM-L6-v2 \
        --cache-dir /app/.cache/huggingface \
        --persist-dir /app/.cache/chromadb && \
    echo "=== RAG knowledge base build complete ==="

# ── Copy docker helper files ───────────────────────────────────────────────
# (docker/ dir already copied as part of the full COPY . . above)
RUN chmod +x /app/docker/start.sh

# ── Expose the MCP SSE server port ────────────────────────────────────────
EXPOSE 8080

# ── Runtime environment defaults ──────────────────────────────────────────
# These can be overridden by App Runner environment variable configuration.
ENV HOST=0.0.0.0
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV BLENDER_MCP_HOST=127.0.0.1
ENV BLENDER_MCP_PORT=9876
ENV BLENDER_MCP_REMOTE_EMBEDDINGS_URL=http://127.0.0.1:9090/embeddings
ENV BLENDER_MCP_EMBEDDING_OFFLINE=1
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV TOKENIZERS_PARALLELISM=false

# ── Entrypoint ─────────────────────────────────────────────────────────────
CMD ["/app/docker/start.sh"]
