#!/usr/bin/env bash
# Build system for distributable gnosis-foliate artifacts.
#
#   ./build.sh native   - meson/ninja build, packaged as a relocatable tarball
#   ./build.sh flatpak  - self-contained Flatpak bundle
#   ./build.sh install  - build and install straight into ~/.local (no sudo)
#   ./build.sh clean    - remove all build/ dist/ artifacts
#
# Output artifacts are written to dist/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_ID="com.github.mavenried.Gnosis"
VERSION="$(sed -nE "s/.*version: *'([^']+)'.*/\1/p" "$ROOT_DIR/meson.build" | head -1)"
ARCH="$(uname -m)"

usage() {
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: '$1' is required but not installed. $2" >&2
        exit 1
    }
}

cmd_native() {
    require meson "Install it (e.g. sudo pacman -S meson / apt install meson)."
    require ninja "Install it (e.g. sudo pacman -S ninja / apt install ninja-build)."
    require gjs "This build also needs the gtk4, libadwaita, and webkitgtk-6.0 runtime/dev packages installed."

    local build_dir="$ROOT_DIR/build"
    local destdir="$ROOT_DIR/.destdir"
    rm -rf "$build_dir" "$destdir"

    meson setup "$build_dir" "$ROOT_DIR" --prefix=/usr --buildtype=release
    ninja -C "$build_dir"
    DESTDIR="$destdir" ninja -C "$build_dir" install

    mkdir -p "$DIST_DIR"
    local archive="$DIST_DIR/gnosis-foliate-$VERSION-$ARCH.tar.gz"
    tar -C "$destdir" -czf "$archive" usr
    rm -rf "$destdir"

    echo
    echo "Built: $archive"
    echo "Install system-wide with:"
    echo "  sudo tar -C / -xzf $archive"
    echo "Then run: gnosis"
}

cmd_flatpak() {
    require flatpak-builder "Install it (e.g. sudo pacman -S flatpak-builder / apt install flatpak-builder)."
    require flatpak "Install it (e.g. sudo pacman -S flatpak / apt install flatpak)."

    if ! flatpak info org.gnome.Sdk//49 >/dev/null 2>&1; then
        echo "error: org.gnome.Sdk//49 is not installed." >&2
        echo "Install it with: flatpak install flathub org.gnome.Sdk//49 org.gnome.Platform//49" >&2
        exit 1
    fi

    local build_dir="$ROOT_DIR/.flatpak-builder-build"
    local repo_dir="$ROOT_DIR/.flatpak-repo"
    rm -rf "$build_dir"

    flatpak-builder --force-clean --repo="$repo_dir" "$build_dir" "$ROOT_DIR/$APP_ID.json"

    mkdir -p "$DIST_DIR"
    local bundle="$DIST_DIR/gnosis-foliate-$VERSION-$ARCH.flatpak"
    flatpak build-bundle "$repo_dir" "$bundle" "$APP_ID"

    echo
    echo "Built: $bundle"
    echo "Install with:"
    echo "  flatpak install --user $bundle"
}

cmd_install() {
    require meson "Install it (e.g. sudo pacman -S meson / apt install meson)."
    require ninja "Install it (e.g. sudo pacman -S ninja / apt install ninja-build)."
    require gjs "This build also needs the gtk4, libadwaita, and webkitgtk-6.0 runtime/dev packages installed."

    local build_dir="$ROOT_DIR/build"
    local prefix="$HOME/.local"
    rm -rf "$build_dir"

    meson setup "$build_dir" "$ROOT_DIR" --prefix="$prefix" --buildtype=release
    ninja -C "$build_dir"
    ninja -C "$build_dir" install

    echo
    echo "Installed to $prefix"
    echo "Binary: $prefix/bin/gnosis"
    case ":$PATH:" in
        *":$prefix/bin:"*) ;;
        *)
            echo
            echo "Note: $prefix/bin is not on your PATH. Add it to your shell profile:"
            echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            ;;
    esac
}

cmd_clean() {
    rm -rf "$ROOT_DIR/build" "$ROOT_DIR/.destdir" \
        "$ROOT_DIR/.flatpak-builder-build" "$ROOT_DIR/.flatpak-repo" \
        "$DIST_DIR"
    echo "Cleaned."
}

case "${1:-}" in
    native) cmd_native ;;
    flatpak) cmd_flatpak ;;
    install) cmd_install ;;
    clean) cmd_clean ;;
    *) usage; exit 1 ;;
esac
