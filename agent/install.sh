#!/bin/sh
# Installs the WebChat agent from the release this script came with, then hands over to its setup
# (docs/decisions/agent-install.md). The release job writes the release's address over @BASE@.
#
#   curl -fsSL <release address>/install.sh | sh -s -- <pairing code>
#
# The file is checked against its checksum in the release before anything is installed.
set -eu
base=@BASE@

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "The WebChat agent runs on macOS and Linux. On Windows, run this line in WSL2." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) echo "The WebChat agent has no build for $(uname -m) processors." >&2; exit 1 ;;
esac
file=webchat-agent-$os-$cpu.gz

# The download lands next to the program, so a small /tmp never fills and the last step is a rename.
dir=$HOME/.local/bin
mkdir -p "$dir"
tmp=$(mktemp -d "$dir/.webchat-agent.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$file" "$base/$file"
curl -fsSL -o "$tmp/$file.sha256" "$base/$file.sha256"
if command -v sha256sum > /dev/null; then sum=sha256sum; else sum='shasum -a 256'; fi
if ! (cd "$tmp" && $sum -c "$file.sha256") > /dev/null 2>&1; then
  echo "$file does not match the release's checksum, so nothing was installed." >&2
  exit 1
fi
gunzip -c "$tmp/$file" > "$tmp/webchat-agent"
chmod 755 "$tmp/webchat-agent"
mv "$tmp/webchat-agent" "$dir/webchat-agent"
echo "Installed webchat-agent $("$dir/webchat-agent" --version) in $dir."
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH to type webchat-agent in a new terminal." ;;
esac
"$dir/webchat-agent" setup "$@"
