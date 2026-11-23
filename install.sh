#!/usr/bin/env bash
# herdr-cognivisor: installer for the Herdr Multi-Repo Agent IDE cognivisor layout package
# Integrates the cognivisor layout and 5 active mods (files-search, changes-review, git-history, cognivisor-tabs, cognivisor-status).
#
# Usage:
#   ./install.sh [--home DIR] [--app-bin PATH]
#   ./install.sh --uninstall [--home DIR] [--app-bin PATH]
#
# Options:
#   --home DIR        Herdr configuration directory (default: $HERDR_APP_HOME or ~/.config/herdr-app)
#   --app-bin PATH    Path to herdr-app executable
#   --uninstall       Revert to standard layout, remove cognivisor layout, shortcuts, and all mods
#   -h, --help        Show this help message

set -euo pipefail

MODS=(files-search changes-review git-history cognivisor-tabs cognivisor-status)
LEGACY_MODS=(mesh-tabs mesh-status mesh-flow mesh-test mesh-ship cognivisor-flow cognivisor-test cognivisor-ship)

here="$(cd "$(dirname "$0")" && pwd)"
pkg_root="$here"
layout_src="$pkg_root/layouts/cognivisor.json"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
app_bin="${HERDR_APP_BIN:-}"
mode="install"
repo_url="https://github.com/JohnMunozR/herdr-cognivisor"
branch="main"

say() { echo "herdr-cognivisor: $*"; }
die() { echo "herdr-cognivisor: error: $*" >&2; exit 1; }

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
  say "Uninstalling herdr-cognivisor layout and mods..."

  # 1. Switch layout back to main if cognivisor or legacy mesh was active
  if [ -n "$HERDR_BIN" ]; then
    say "Switching active layout back to 'main'..."
    "$HERDR_BIN" do layout.switch '{"name":"main"}' 2>/dev/null || true
  fi

  # 2. Remove cognivisor (and any legacy mesh) layout and cached state
  for stale_layout in "$layouts_dir/cognivisor.json" "$layouts_dir/.state/cognivisor.json" "$layouts_dir/mesh.json" "$layouts_dir/.state/mesh.json"; do
    if [ -f "$stale_layout" ]; then
      rm -f "$stale_layout"
      say "Removed $stale_layout"
    fi
  done

  # 3. Clean up keys.json (files-search, changes-review, git-history, cognivisor-*, and legacy mesh-* bindings)
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
            pattern = re.compile(r"(files-search|changes-review|git-history|cognivisor-[a-z0-9-]+|mesh-[a-z0-9-]+)")
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
                print("herdr-cognivisor: Removed herdr-cognivisor shortcuts from keys.json")
except Exception:
    pass
'
  fi

  # 4. Remove all mod directories (including legacy mesh-* and retired cognivisor-* mods if present)
  for mod in "${MODS[@]}" "${LEGACY_MODS[@]}"; do
    target_mod="$target_mods/$mod"
    if [ -d "$target_mod" ]; then
      rm -rf "$target_mod"
      say "Removed $target_mod"
    fi
  done

  say "✓ herdr-cognivisor uninstallation complete."
  exit 0
fi

# Mode: install
say "Installing Herdr Cognivisor layout and ${#MODS[@]} mods into: $home"

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
  say "Fetching herdr-cognivisor package files from GitHub..."
  tmp_dir="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL "${repo_url}/archive/refs/heads/${branch}.tar.gz" | tar -xz -C "$tmp_dir"
    pkg_root="$tmp_dir/herdr-cognivisor-${branch}"
  elif command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$repo_url.git" "$tmp_dir/repo"
    pkg_root="$tmp_dir/repo"
  else
    die "Cannot download files: neither curl+tar nor git are available"
  fi
  layout_src="$pkg_root/layouts/cognivisor.json"
fi

[ -f "$layout_src" ] || die "Cognivisor layout definition not found: $layout_src"
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

# Migrate legacy runtime directory from mesh -> cognivisor when upgrading cleanly
if [ -d "$home/mesh" ] && [ ! -e "$home/cognivisor" ]; then
  mv "$home/mesh" "$home/cognivisor"
  say "Migrated runtime state from $home/mesh to $home/cognivisor"
fi

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
  for shared_diag in diagnostics-logic.js diagnostics.js; do
    if [ -f "$pkg_root/shared/$shared_diag" ]; then
      cp "$pkg_root/shared/$shared_diag" "$target_mods/$mod/$shared_diag"
    fi
  done
  if [ "$mod" = "files-search" ] || [ "$mod" = "changes-review" ] || [ "$mod" = "git-history" ]; then
    for shared_file in code-wrap.js code-syntax.js markdown-syntax.js markdown-view-logic.js markdown-view.js dropdown-logic.js dropdown.js; do
      if [ -f "$pkg_root/shared/$shared_file" ]; then
        cp "$pkg_root/shared/$shared_file" "$target_mods/$mod/$shared_file"
      fi
    done
  fi
  if [ "$mod" = "files-search" ]; then
    for shared_file in code-nav-logic.js code-nav-js.js code-nav-python.js code-nav-java.js; do
      if [ -f "$pkg_root/shared/$shared_file" ]; then
        cp "$pkg_root/shared/$shared_file" "$target_mods/$mod/$shared_file"
      fi
    done
  fi
done

if [ -n "$HERDR_BIN" ]; then
  say "Verifying mods with herdr-app check..."
  for mod in "${MODS[@]}"; do
    "$HERDR_BIN" check "$target_mods/$mod" || die "Mod validation failed for $mod"
  done
fi

# Install cognivisor layout and clean up legacy mesh layout files if present
mkdir -p "$layouts_dir"
for stale_layout in "$layouts_dir/mesh.json" "$layouts_dir/.state/mesh.json"; do
  if [ -f "$stale_layout" ]; then
    rm -f "$stale_layout"
    say "Removed legacy layout file $stale_layout"
  fi
done
say "Installing cognivisor layout: $layouts_dir/cognivisor.json"
cp "$layout_src" "$layouts_dir/cognivisor.json"

# Invalidate stale layout cache state if present
if [ -f "$layouts_dir/.state/cognivisor.json" ]; then
  rm -f "$layouts_dir/.state/cognivisor.json"
  say "Refreshed layout cache state for cognivisor.json"
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
print("herdr-cognivisor: Registered Ctrl+P and Alt+F in keys.json")
'
fi

# Activate cognivisor layout and select initial panel safely if herdr-app is reachable
if [ -n "$HERDR_BIN" ]; then
  say "Activating cognivisor layout in Herdr..."
  "$HERDR_BIN" do layout.switch '{"name":"cognivisor"}' 2>/dev/null || true
  "$HERDR_BIN" do layout.select --stack panel-body --child files 2>/dev/null || true
  "$HERDR_BIN" do layout.show --id panel 2>/dev/null || true
fi

say "✓ Herdr Cognivisor layout and ${#MODS[@]} mods installed successfully!"
