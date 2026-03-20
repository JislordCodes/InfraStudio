#!/bin/bash
# start.sh — Container entrypoint for ifc-bonsai-mcp on AWS App Runner
# Runs supervisord which manages:
#   1. Blender (headless, addon, socket server on 9876)
#   2. Embedding Server (FastAPI, port 9090, offline RAG)
#   3. MCP SSE Server  (FastMCP, port 8080, public-facing)

set -e

echo "=== Starting ifc-bonsai-mcp container ==="
echo "  Blender:          headless, port 9876"
echo "  Embedding Server: port 9090 (offline, pre-built cache)"
echo "  MCP SSE Server:   port 8080 (App Runner entry point)"
echo ""

# Create Blender user config dir (avoids first-run dialogs in headless mode)
mkdir -p /root/.config/blender/4.4/config
mkdir -p /app/.blender_config

# Create directories for IFC file storage
mkdir -p /tmp/ifc_files

# Ensure log directory exists
mkdir -p /var/log

echo "=== Launching supervisord ==="
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
