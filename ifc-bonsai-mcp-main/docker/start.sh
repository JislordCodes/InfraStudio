#!/bin/bash
set -e
echo "=== Starting ifc-bonsai-mcp container ==="
mkdir -p /root/.config/blender/4.4/config
mkdir -p /app/.blender_config
mkdir -p /tmp/ifc_files
mkdir -p /var/log
echo "=== Launching supervisord ==="
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
