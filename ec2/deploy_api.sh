#!/bin/bash
# Ships backend changes to the build box (replaces `aws lambda update-function-code`).
# Run from the repo root in Git Bash:  bash ec2/deploy_api.sh
# Needs the SSH key at C:/Users/david/agy-login/boxkey (override with BOXKEY=...).
set -e
IP="${BOX_IP:-56.228.86.56}"
KEY="${BOXKEY:-/c/Users/david/agy-login/boxkey}"
SSHO="-i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"

(cd aws-lambda && npm run build)
scp $SSHO aws-lambda/dist/index.js ec2-user@$IP:/tmp/index.js
scp $SSHO ec2/api/server.js ec2-user@$IP:/tmp/server.js
ssh $SSHO ec2-user@$IP 'sudo mv /tmp/index.js /tmp/server.js /opt/infrastudio/api/ && sudo systemctl restart infrastudio-api && sleep 2 && systemctl is-active infrastudio-api'
curl -s -m 20 -X POST -H "Content-Type: application/json" -d '{"action":"identity"}' "https://${IP//./-}.nip.io/agent-bim" | head -c 200; echo
