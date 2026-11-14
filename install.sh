#!/usr/bin/env bash
# herdr-mesh: installer for the Herdr Multi-Repo Agent IDE mesh layout package
# Integrates the mesh layout and 5 active mods (files-search, changes-review, git-history, mesh-tabs, mesh-status).
#
# Usage:
#   ./install.sh [--home DIR] [--app-bin PATH]
#   ./install.sh --uninstall [--home DIR] [--app-bin PATH]
#
# Options:
#   --home DIR        Herdr configuration directory (default: $HERDR_APP_HOME or ~/.config/herdr-app)
#   --app-bin PATH    Path to herdr-app executable
#   --uninstall       Revert to standard layout, remove mesh layout, shortcuts, and all mods
#   -h, --help        Show this help message

set -euo pipefail

MODS=(files-search changes-review git-history mesh-tabs mesh-status)
LEGACY_MODS=(mesh-flow mesh-test mesh-ship)

here="$(cd "$(dirname "$0")" && pwd)"
pkg_root="$here"
layout_src="$pkg_root/layouts/mesh.json"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
app_bin="${HERDR_APP_BIN:-}"
mode="install"
repo_url="https://github.com/JohnMunozR/herdr-mesh"
branch="main"

say() { echo "herdr-mesh: $*"; }
die() { echo "herdr-mesh: error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode="uninstall" ;;
    --home) [ $# -ge 2 ] || die "--home requires a directory"; home="$2"; shift ;;
    --app-bin) [ $# -ge 2 ] || die "--app-bin requires a path"; app_bin="$2"; shift ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^#[ ]\?//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

find_app_bin() {
  if [ -n "$app_bin" ]; then echo "$app_bin"; return; fi
  if command -v herdr-app >/dev/null 2>&1; then command -v herdr-app; return; fi
  if [ -x "$HOME/.local/bin/herdr-app" ]; then echo "$HOME/.local/bin/herdr-app"; return; fi
  echo ""
}

HERDR_BIN="$(find_app_bin)"

target_mods="$home/mods"
layouts_dir="$home/layouts"
keys_file="$home/keys.json"

if [ "$mode" = "uninstall" ]; then
  say "Uninstalling herdr-mesh layout and mods..."

  # 1. Switch layout back to main if mesh was active
  if [ -n "$HERDR_BIN" ]; then
    say "Switching active layout back to 'main'..."
    "$HERDR_BIN" do layout.switch '{"name":"main"}' 2>/dev/null || true
  fi

  # 2. Remove mesh layout and cached state
  if [ -f "$layouts_dir/mesh.json" ]; then
    rm -f "$layouts_dir/mesh.json"
    say "Removed $layouts_dir/mesh.json"
  fi
  if [ -f "$layouts_dir/.state/mesh.json" ]; then
    rm -f "$layouts_dir/.state/mesh.json"
    say "Removed cached state $layouts_dir/.state/mesh.json"
  fi

  # 3. Clean up keys.json (files-search, changes-review, git-history, and mesh-* bindings)
  if [ -f "$keys_file" ] && command -v python3 >/dev/null 2>&1; then
    KEYS_FILE="$keys_file" python3 -c '
import json, os, re

try:
    path = os.path.expanduser(os.environ["KEYS_FILE"])
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            keys = json.load(f)
        changed = False
        if isinstance(keys, dict):
            pattern = re.compile(r"(files-search|changes-review|git-history|mesh-[a-z0-9-]+)")
            for sec in ("global", "window"):
                section = keys.get(sec)
                if isinstance(section, dict):
                    for k in list(section.keys()):
                        if pattern.search(str(section[k])):
                            del section[k]
                            changed = True
            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(keys, f, indent=2)
                    f.write("\n")
                print("herdr-mesh: Removed herdr-mesh shortcuts from keys.json")
except Exception:
    pass
'
  fi

  # 4. Remove all mod directories (including legacy mesh-flow, mesh-test, and mesh-ship if present)
  for mod in "${MODS[@]}" "${LEGACY_MODS[@]}"; do
    target_mod="$target_mods/$mod"
    if [ -d "$target_mod" ]; then
      rm -rf "$target_mod"
      say "Removed $target_mod"
    fi
  done

  say "✓ herdr-mesh uninstallation complete."
  exit 0
fi

# Mode: install
say "Installing Herdr Mesh layout and ${#MODS[@]} mods into: $home"

tmp_dir=""
cleanup() {
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

sources_present=true
if [ ! -f "$layout_src" ]; then
  sources_present=false
else
  for mod in "${MODS[@]}"; do
    if [ ! -d "$pkg_root/mods/$mod" ]; then
      sources_present=false
      break
    fi
  done
fi

# Fallback: fetch from repository if local sources are missing
if [ "$sources_present" = false ]; then
  say "Fetching herdr-mesh package files from GitHub..."
  tmp_dir="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL "${repo_url}/archive/refs/heads/${branch}.tar.gz" | tar -xz -C "$tmp_dir"
    pkg_root="$tmp_dir/herdr-mesh-${branch}"
  elif command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$repo_url.git" "$tmp_dir/repo"
    pkg_root="$tmp_dir/repo"
  else
    die "Cannot download files: neither curl+tar nor git are available"
  fi
  layout_src="$pkg_root/layouts/mesh.json"
fi

[ -f "$layout_src" ] || die "Mesh layout definition not found: $layout_src"
for mod in "${MODS[@]}"; do
  [ -d "$pkg_root/mods/$mod" ] || die "Mod source not found: $pkg_root/mods/$mod"
done

# Function to cleanly copy mod directory excluding developer/documentation files
copy_mod_clean() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'SPEC.md' \
      --exclude 'jsconfig.json' \
      --exclude 'gpui-kit.d.ts' \
      "$src/" "$dest/"
  else
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -R "$src"/. "$dest"/
    rm -f "$dest/SPEC.md" "$dest/jsconfig.json" "$dest/gpui-kit.d.ts"
  fi
}

mkdir -p "$target_mods"
for legacy_mod in "${LEGACY_MODS[@]}"; do
  if [ -d "$target_mods/$legacy_mod" ]; then
    rm -rf "$target_mods/$legacy_mod"
    say "Removed obsolete $legacy_mod mod"
  fi
done
for mod in "${MODS[@]}"; do
  say "Installing $mod mod..."
  copy_mod_clean "$pkg_root/mods/$mod" "$target_mods/$mod"
done

if [ -n "$HERDR_BIN" ]; then
  say "Verifying mods with herdr-app check..."
  for mod in "${MODS[@]}"; do
    "$HERDR_BIN" check "$target_mods/$mod" || die "Mod validation failed for $mod"
  done
fi

# Install mesh layout
mkdir -p "$layouts_dir"
say "Installing mesh layout: $layouts_dir/mesh.json"
cp "$layout_src" "$layouts_dir/mesh.json"

# Invalidate stale layout cache state if present
if [ -f "$layouts_dir/.state/mesh.json" ]; then
  rm -f "$layouts_dir/.state/mesh.json"
  say "Refreshed layout cache state for mesh.json"
fi

# Merge shortcuts into keys.json using setdefault safely
if command -v python3 >/dev/null 2>&1; then
  KEYS_FILE="$keys_file" python3 -c '
import json, os

path = os.path.expanduser(os.environ["KEYS_FILE"])
parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)

keys = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            keys = loaded
    except Exception:
        keys = {}

if not isinstance(keys.get("global"), dict):
    keys["global"] = {}

keys["global"].setdefault("ctrl-p", "mod.open:files-search")
keys["global"].setdefault("alt-f", "mod.open:files-search")

with open(path, "w", encoding="utf-8") as f:
    json.dump(keys, f, indent=2)
    f.write("\n")
print("herdr-mesh: Registered Ctrl+P and Alt+F in keys.json")
'
fi

# Activate mesh layout and select initial panel safely if herdr-app is reachable
if [ -n "$HERDR_BIN" ]; then
  say "Activating mesh layout in Herdr..."
  "$HERDR_BIN" do layout.switch '{"name":"mesh"}' 2>/dev/null || true
  "$HERDR_BIN" do layout.select --stack panel-body --child files 2>/dev/null || true
  "$HERDR_BIN" do layout.show --id panel 2>/dev/null || true
fi

say "✓ Herdr Mesh layout and ${#MODS[@]} mods installed successfully!"
