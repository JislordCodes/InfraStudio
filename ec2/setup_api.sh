#!/bin/bash
# Idempotent: runs the backend bundle as a systemd service on the build box and puts Caddy in
# front of it for HTTPS. Used when AWS Lambda is not available on the account.
#
# Expects (copied over by the deploy step):
#   /opt/infrastudio/api/index.js    the esbuild bundle (aws-lambda/dist/index.js)
#   /opt/infrastudio/api/server.js   ec2/api/server.js
#   /etc/infrastudio-api.env         KEY=value lines (MCP_URL, USE_ANTIGRAVITY_ENGINE, EXPLABS_API_KEY ...)
# Usage: setup_api.sh <public-hostname>     e.g. 13-63-78-238.nip.io
set -e
HOSTNAME_PUBLIC="${1:?usage: setup_api.sh <public-hostname>}"

command -v node >/dev/null || dnf install -y nodejs20 nodejs20-npm || dnf install -y nodejs
node --version

cat > /etc/systemd/system/infrastudio-api.service <<'EOS'
[Unit]
Description=InfraStudio backend API
After=network.target docker.service

[Service]
WorkingDirectory=/opt/infrastudio/api
EnvironmentFile=/etc/infrastudio-api.env
Environment=AWS_REGION=eu-north-1
Environment=AWS_DEFAULT_REGION=eu-north-1
ExecStart=/usr/bin/node /opt/infrastudio/api/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOS

if [ ! -x /usr/local/bin/caddy ]; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy
cat > /etc/caddy/Caddyfile <<EOC
${HOSTNAME_PUBLIC} {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
		transport http {
			response_header_timeout 20m
		}
	}
}
EOC
setcap cap_net_bind_service=+ep /usr/local/bin/caddy || true
cat > /etc/systemd/system/caddy.service <<'EOS'
[Unit]
Description=Caddy HTTPS reverse proxy
After=network.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOS

systemctl daemon-reload
systemctl enable infrastudio-api caddy
systemctl restart infrastudio-api
systemctl restart caddy
sleep 3
systemctl is-active infrastudio-api caddy
echo API_SETUP_DONE
