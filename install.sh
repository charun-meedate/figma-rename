#!/usr/bin/env bash
# Installs this repo's skill into a project (or the current user).
#
#   ./install.sh ~/dev/my-project          copy into <project>/.claude/skills/
#   ./install.sh ~/dev/my-project --link   symlink instead of copying
#   ./install.sh --global                  install into ~/.claude/skills/
#   ./install.sh --list                    show what this repo ships
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"

usage() {
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

available_skills() {
  find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
}

[[ $# -eq 0 ]] && usage 1

LINK=false
TARGET_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --link) LINK=true ;;
    --global) TARGET_ROOT="$HOME" ;;
    --list)
      echo "Skills in this repo:"
      available_skills | sed 's/^/  /'
      exit 0
      ;;
    -h|--help) usage 0 ;;
    -*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) TARGET_ROOT="$1" ;;
  esac
  shift
done

if [[ -z "$TARGET_ROOT" ]]; then
  echo "Error: pass a project directory, or --global." >&2
  usage 1
fi
if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "Error: $TARGET_ROOT does not exist." >&2
  exit 1
fi

DEST_DIR="$TARGET_ROOT/.claude/skills"
mkdir -p "$DEST_DIR"

for SKILL_NAME in $(available_skills); do
  SRC="$SKILLS_DIR/$SKILL_NAME"
  DEST="$DEST_DIR/$SKILL_NAME"

  # Report what is being replaced before replacing it — an existing skill may
  # be a local edit someone has not pushed back to this repo yet.
  if [[ -e "$DEST" || -L "$DEST" ]]; then
    if [[ -L "$DEST" ]]; then
      echo "Replacing existing symlink: $DEST -> $(readlink "$DEST")"
    else
      echo "Replacing existing directory: $DEST"
      if command -v diff >/dev/null && ! diff -rq "$SRC" "$DEST" >/dev/null 2>&1; then
        echo "  Note: the installed copy differs from this repo. Differences:"
        diff -rq "$SRC" "$DEST" 2>/dev/null | sed 's/^/    /' || true
        printf "  Continue and overwrite? [y/N] "
        read -r reply
        [[ "$reply" =~ ^[Yy]$ ]] || { echo "Skipped $SKILL_NAME."; continue; }
      fi
    fi
    rm -rf "$DEST"
  fi

  if $LINK; then
    ln -s "$SRC" "$DEST"
    echo "Linked  $DEST -> $SRC"
  else
    cp -R "$SRC" "$DEST"
    echo "Copied  $SRC -> $DEST"
  fi
done

cat <<EOF

Next:
  cp "$DEST_DIR/figma-rename/scripts/rename.config.example.json" "$TARGET_ROOT/rename.config.json"

Point it at your team's standard and override only this repo's facts:

  { "extends": "aurora",              // or "../design-system/naming.json"
    "figma": { "fileKey": "…" },
    "code":  { "cssPrefix": "", "flutterPrefix": "App" } }

The naming rules belong in the file you extend, not in this one — a convention
copied into every project is several standards that agree today. Then ask for
the rename in Claude Code.
EOF
