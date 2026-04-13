#!/bin/bash
set -e

# Identity for Bash-invoked `git` (Claude Code). Do not use `git config --global`
# under $HOME: with Docker --user <hostUid> and HOME=/home/node, writing
# /home/node/.gitconfig often fails (permission), which breaks commits and can
# abort this script under `set -e`.
CFG="/tmp/nanoclaw-gitconfig-$(id -u)"
rm -f "$CFG"
git config --file "$CFG" user.email "${GIT_AUTHOR_EMAIL:-nanoclaw@localhost}"
git config --file "$CFG" user.name "${GIT_AUTHOR_NAME:-NanoClaw Agent}"
git config --file "$CFG" user.useConfigOnly false
chmod 644 "$CFG"
export GIT_CONFIG_GLOBAL="$CFG"

export GIT_EDITOR="${GIT_EDITOR:-:}"
export EDITOR="${EDITOR:-:}"
export VISUAL="${VISUAL:-:}"

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
