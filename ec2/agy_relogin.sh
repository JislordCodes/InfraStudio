#!/bin/bash
# Re-authenticate the Antigravity CLI (agy) with a Google account.
# One login is shared by all build slots and the clarifying-questions step.
export HOME=/root
export PATH="$HOME/.local/bin:$PATH"
source /root/dbus_env.sh
T=/root/.gemini/antigravity-cli/antigravity-oauth-token
B=/root/agy_oauth_token.backup.$(date +%s)
cp -a "$T" "$B" 2>/dev/null && echo "Old login backed up to $B"
rm -f "$T"
echo
echo "1) Open the link below in your browser"
echo "2) Sign in with the Google account that has Antigravity"
echo "3) Copy the code shown, paste it here and press Enter - you have 60 seconds"
echo
agy --model gemini-3.8-flash-low -p "Reply with the word ok" --dangerously-skip-permissions --output-format text
if [ ! -s "$T" ]; then
  echo; echo "Login did not complete - restoring the old login."
  cp -a "$B" "$T" 2>/dev/null
  exit 1
fi
echo; echo "=== Logged in. Models available to this account: ==="
agy models
