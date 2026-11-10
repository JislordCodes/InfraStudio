#!/bin/bash
# Idempotent: prepares a fresh build box to run the Antigravity CLI (agy) headless.
#
#  1. Installs agy (/root/.local/bin/agy).
#  2. Runs a persistent D-Bus session with an unlocked gnome-keyring as a systemd
#     service, and writes its addresses to /root/dbus_env.sh. Every on-box build
#     script does `source /root/dbus_env.sh` before it launches agy.
#  3. Registers the slot-1 MCP server (localhost:8000) with agy. Slots 2 and 3 get
#     their own HOME with ports 8001/8002 from ec2/setup_mcp_slots.sh.
#
# The Google login itself is a one-time browser step: run `sudo bash /root/agy_relogin.sh`
# (see ec2/agy_relogin.sh) and paste the code.
set -e
export HOME=/root
export PATH="/root/.local/bin:$PATH"

command -v dbus-run-session >/dev/null || dnf install -y dbus-daemon gnome-keyring

if [ ! -x /root/.local/bin/agy ]; then
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi

cat > /root/start_dbus.sh <<'EOS'
#!/bin/bash
rm -f /root/dbus_env.sh
exec dbus-run-session -- bash -c '
  echo "export DBUS_SESSION_BUS_ADDRESS=\"$DBUS_SESSION_BUS_ADDRESS\"" > /root/dbus_env.sh
  eval $(printf "" | gnome-keyring-daemon --unlock --components=secrets,pkcs11,ssh)
  eval $(printf "" | gnome-keyring-daemon --start --components=secrets,pkcs11,ssh --replace)
  echo "export GNOME_KEYRING_CONTROL=\"$GNOME_KEYRING_CONTROL\"" >> /root/dbus_env.sh
  echo "export SSH_AUTH_SOCK=\"$SSH_AUTH_SOCK\"" >> /root/dbus_env.sh
  exec sleep infinity'
EOS
chmod +x /root/start_dbus.sh

cat > /etc/systemd/system/infrastudio-dbus.service <<'EOS'
[Unit]
Description=Persistent D-Bus session and unlocked keyring for agy
After=network.target

[Service]
ExecStart=/root/start_dbus.sh
Restart=always

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable infrastudio-dbus.service
systemctl restart infrastudio-dbus.service
sleep 4
cat /root/dbus_env.sh

# Register the slot-1 MCP server (idempotent: "add" updates an existing entry).
source /root/dbus_env.sh
agy mcp add --type http bonsai http://localhost:8000/mcp
agy mcp list || true
mkdir -p /root/agy_jobs
echo AGY_SETUP_DONE
