# ─────────────────────────────────────────────────────────────────────────────
# ifc-bonsai-mcp  —  AWS App Runner Docker Image
#
# Architecture:
#   - Blender 4.4.3 (headless, with Bonsai/blendermcp addon)  → socket on 9876
#   - Embedding Server (sentence-transformers, offline)        → HTTP on 9090
#   - MCP SSE Server  (FastMCP + all IFC tools)               → HTTP on 8080
#
# All three processes are managed by supervisord.
# App Runner routes HTTPS traffic → port 8000 (MCP SSE Server).
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

# ── System dependencies ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget \
        xz-utils \
        zip \
        unzip \
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

# ── Install uv ────────────────────────────────────────────────────────────
RUN pip install --no-cache-dir uv

# ── Set workdir and copy the project ──────────────────────────────────────
WORKDIR /app
COPY . .

# ── Install MCP server Python dependencies ────────────────────────────────
RUN uv pip install --system torch --index-url https://download.pytorch.org/whl/cpu && \
    uv pip install --system -e . && \
    uv pip install --system \
        sentence-transformers \
        chromadb \
        fastapi \
        uvicorn[standard] \
        sse-starlette

# ── Download and install Blender 4.4.3 ────────────────────────────────────
ENV BLENDER_VERSION=4.4.3
ENV PORT=8000
ENV BLENDER_DIR=/opt/blender-${BLENDER_VERSION}-linux-x64
RUN wget -q https://download.blender.org/release/Blender4.4/blender-${BLENDER_VERSION}-linux-x64.tar.xz -O /tmp/blender.tar.xz && \
    tar -xf /tmp/blender.tar.xz -C /opt/ && \
    rm /tmp/blender.tar.xz && \
    ln -s ${BLENDER_DIR}/blender /usr/local/bin/blender

# ── Download and install Bonsai Addon (v0.8.5 alpha) ───────────────────────
RUN wget -q https://github.com/IfcOpenShell/IfcOpenShell/releases/download/bonsai-0.8.5-alpha2603201233/bonsai_py311-0.8.5-alpha260320-linux-x64.zip -O /tmp/bonsai.zip && \
    mkdir -p /tmp/bonsai_temp && \
    unzip -q /tmp/bonsai.zip -d /tmp/bonsai_temp/ && \
    mkdir -p ${BLENDER_DIR}/4.4/scripts/addons && \
    # Find the actual 'bonsai' package folder inside the zip (might be nested) and move it
    BP=$(find /tmp/bonsai_temp -maxdepth 3 -name "__init__.py" | grep "bonsai/__init__.py" | head -n 1 | xargs dirname) && \
    mv "$BP" ${BLENDER_DIR}/4.4/scripts/addons/bonsai && \
    rm -rf /tmp/bonsai.zip /tmp/bonsai_temp

# ── Install required packages into Blender's Python ────────────────────────
ENV BLENDER_PYTHON=${BLENDER_DIR}/4.4/python/bin/python3.11
RUN ${BLENDER_PYTHON} -m pip install --upgrade pip && \
    ${BLENDER_PYTHON} -m pip install \
        "ifcopenshell>=0.7.0" \
        "trimesh>=3.24.0" \
        "pillow>=10.0.0" \
        "numpy>=1.26.0"

# ── Install the Blender addon (blendermcp) ────────────────────────────────
ENV BLENDER_ADDONS_DIR=${BLENDER_DIR}/4.4/scripts/addons
RUN zip -r /tmp/blendermcp.zip blender_addon/ && \
    mkdir -p ${BLENDER_ADDONS_DIR}/blendermcp && \
    unzip -q /tmp/blendermcp.zip -d /tmp/blendermcp_unzip && \
    cp -r /tmp/blendermcp_unzip/blender_addon/* ${BLENDER_ADDONS_DIR}/blendermcp/ && \
    rm -rf /tmp/blendermcp.zip /tmp/blendermcp_unzip

# ── Pre-build the RAG knowledge base ──────────────────────────────────────
ENV PYTHONPATH=/app/src
RUN python scripts/init_knowledge_base.py \
        --model sentence-transformers/all-MiniLM-L6-v2 \
        --cache-dir /app/.cache/huggingface \
        --persist-dir /app/.cache/chromadb

# ── Setup Runtime ──────────────────────────────────────────────────────────
RUN chmod +x /app/docker/start.sh
EXPOSE 8080

ENV HOST=0.0.0.0
ENV PORT=8080
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/app/.cache/huggingface
ENV HUGGINGFACE_HUB_CACHE=/app/.cache/huggingface
ENV BLENDER_MCP_HOST=127.0.0.1
ENV BLENDER_MCP_PORT=9876
ENV BLENDER_MCP_REMOTE_EMBEDDINGS_URL=http://127.0.0.1:9090/embeddings
ENV BLENDER_MCP_EMBEDDING_OFFLINE=1
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

CMD ["/app/docker/start.sh"]
