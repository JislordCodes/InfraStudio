#!/bin/bash
# Idempotent: adds build slots 2 and 3 next to the original MCP container
# (infrastudio-mcp = slot 1, port 8000, untouched). Each slot is a full,
# isolated copy of the ifc-bonsai-mcp image - its own headless Blender, so its
# own IFC scene - so builds in different slots can never bleed into each other.
#
#   slot 1  container infrastudio-mcp    127.0.0.1:8000  export key models/c21f969b/model.ifc (unchanged)
#   slot 2  container infrastudio-mcp-2  127.0.0.1:8001  export key models/slot2/model.ifc
#   slot 3  container infrastudio-mcp-3  127.0.0.1:8002  export key models/slot3/model.ifc
#
# The MCP server exports every build to ONE S3 key derived from a constant, so
# slots 2/3 mount a patched supabase_uploader.py that honours MCP_SLOT_KEY.
# Slots 2/3 bind to localhost only: nothing outside this box needs them
# (agy talks to them locally; progress is reported through S3 status files).
#
# Also creates one HOME per slot for the `agy` CLI whose only difference from
# /root is .gemini/config/mcp_config.json pointing at that slot's port - agy
# has no per-run MCP flag, and auth (keyring over dbus) is HOME-independent.
set -e
mkdir -p /root/mcp_slots /root/agy_jobs

IMAGE=$(docker inspect infrastudio-mcp --format '{{.Image}}')
docker cp infrastudio-mcp:/app/src/blender_mcp/supabase_uploader.py /root/mcp_slots/supabase_uploader.py
python3 - <<'PY'
p = '/root/mcp_slots/supabase_uploader.py'
s = open(p).read()
old = 'storage_path = f"models/{session_hash}/model.ifc"'
new = 'storage_path = f"models/{os.environ[\'MCP_SLOT_KEY\']}/model.ifc" if os.environ.get("MCP_SLOT_KEY") else f"models/{session_hash}/model.ifc"'
if 'MCP_SLOT_KEY' not in s:
    assert old in s, "uploader layout changed - patch needs updating"
    s = s.replace(old, new)
    open(p, 'w').write(s)
print("uploader patched")
PY

for N in 2 3; do
  PORT=$((8000 + N - 1))
  if docker ps --format '{{.Names}}' | grep -qx "infrastudio-mcp-$N"; then
    echo "infrastudio-mcp-$N already running"
  else
    docker rm -f "infrastudio-mcp-$N" >/dev/null 2>&1 || true
    docker run -d --name "infrastudio-mcp-$N" --restart always \
      -p "127.0.0.1:$PORT:8000" \
      -e "MCP_SLOT_KEY=slot$N" \
      --env-file /root/box.env \
      -v /root/mcp_slots/supabase_uploader.py:/app/src/blender_mcp/supabase_uploader.py:ro \
      "$IMAGE" >/dev/null
    echo "started infrastudio-mcp-$N on 127.0.0.1:$PORT"
  fi
done

# Per-slot HOME for agy.
for N in 2 3; do
  PORT=$((8000 + N - 1))
  H=/root/slots/home$N
  mkdir -p "$H/.gemini"
  for f in /root/* /root/.[!.]*; do
    b=$(basename "$f")
    case "$b" in .gemini|slots) continue;; esac
    ln -sfn "$f" "$H/$b"
  done
  for f in /root/.gemini/* /root/.gemini/.[!.]*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    [ "$b" = config ] && continue
    ln -sfn "$f" "$H/.gemini/$b"
  done
  # Always link the shared login state, even before the one-time login has happened
  # (a dangling link is fine and starts working once /root/.gemini/antigravity-cli exists).
  rm -rf "$H/.gemini/antigravity-cli"
  ln -sfn /root/.gemini/antigravity-cli "$H/.gemini/antigravity-cli"
  rm -rf "$H/.gemini/config"
  cp -r /root/.gemini/config "$H/.gemini/config"
  sed -i "s#localhost:8000/mcp#localhost:$PORT/mcp#" "$H/.gemini/config/mcp_config.json"
  echo "home$N -> $(grep -o 'localhost:[0-9]*' "$H/.gemini/config/mcp_config.json")"
done
echo SETUP_DONE
