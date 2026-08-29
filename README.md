
# Gnosis

Gnosis is a GTK4/libadwaita EPUB reader built on top of
[Foliate](https://github.com/johnfactotum/foliate) — John Factotum's reader —
adding the library-management features from
[gnosis](https://github.com/mavenried/gnosis-rust), a from-scratch Rust
reader this project replaces.

The idea: Foliate's actual reading experience (pagination, annotations,
text-to-speech, dictionary/Wikipedia lookup, footnotes) is more mature than
what the Rust app had. What the Rust app had that Foliate didn't was
opinionated library organization — browsing by author/series like a music
library, watching folders for new books, sorting, and a "mark as read"
concept. Gnosis adds those on top of Foliate's codebase rather than
rebuilding a reader from scratch.

## What Gnosis adds on top of Foliate

- **Sort & filter**: Sort By (Title, Author, Series, Recently Added,
  Recently Read) and Filter (All/Unread/Reading/Read) in the library menu.
- **Browse by author or series**: sidebar entries list every author/series
  in your library with book counts; click through to a filtered grid.
- **Mark as read/unread**: a toggle in each book's context menu.
- **Pie-shaped progress badge** on grid covers, and author subtitles.
- **Library Folders**: point Gnosis at folders (recursively) and it finds
  and imports EPUBs automatically — on launch, on demand (<kbd>Ctrl</kbd>+<kbd>R</kbd>),
  or whenever you add a folder.
- **Automatic refresh**: if a book's underlying EPUB file changes (re-exported,
  edited), its cover and metadata are refreshed automatically next time it's
  scanned — no need to remove and re-add it.
- **Settings**: library folders live in a Settings dialog (sidebar →
  Settings…), alongside a "Refresh Now" action that reloads metadata and
  cover art for any book whose source file has changed, with a progress
  indicator in the corner of the library while it runs.
- **One-time migration** from a legacy gnosis (Rust) library: "Import from
  Legacy Gnosis…" in the primary menu reads its SQLite database directly and
  re-imports each book, carrying over reading progress and position.
- **Reader tweaks**: the side panel no longer stays pinned open across
  books; there's an always-visible back-to-library button; Escape closes
  the side panel first, then goes back to the library.
- Renamed application ID (`com.github.mavenried.Gnosis`), so it doesn't
  collide with a real Foliate install's data/config/cache directories.
- OPDS remote-catalog browsing has been removed — not something this project
  needs, since directory scanning covers the "get books into the library"
  use case instead.

Everything else — reading, annotations, TTS, dictionary/Wikipedia/translate
lookups, themes, fonts, keyboard shortcuts — comes from Foliate unchanged.

## Installing

### Prebuilt releases

Tagged releases publish a native tarball and a Flatpak bundle on the
[Releases page](https://github.com/mavenried/gnosis/releases) — see the
tarball/Flatpak install steps below for how to use them.

### Build dependencies

- `meson` (>= 0.59), `ninja`, `pkg-config`, `gettext`

### Runtime dependencies

- `gjs` (>= 1.82), `gtk4` (>= 4.12), `libadwaita` (>= 1.8),
  `webkitgtk-6.0` (>= 2.40.1)

On Arch Linux: `sudo pacman -S gjs gtk4 libadwaita webkitgtk-6.0 meson ninja`

### Getting the source

This repo uses a git submodule (vendored `foliate-js`). Clone with:

```sh
git clone --recurse-submodules https://github.com/mavenried/gnosis.git
cd gnosis
```

### Install to your user profile (recommended, no sudo)

```sh
./build.sh install
```

Installs to `~/.local` — binary at `~/.local/bin/gnosis`, data/schemas/icons
under `~/.local/share`. Make sure `~/.local/bin` is on your `PATH`, then run:

```sh
gnosis
```

### Build a distributable tarball

```sh
./build.sh native
```

Produces `dist/gnosis-foliate-<version>-<arch>.tar.gz`, a `usr/`-rooted
tree you can extract system-wide:

```sh
sudo tar -C / -xzf dist/gnosis-foliate-*.tar.gz
```

### Build a Flatpak bundle

```sh
./build.sh flatpak
```

Requires `flatpak-builder` and the `org.gnome.Sdk`/`org.gnome.Platform`
runtimes (version 49):

```sh
flatpak install flathub org.gnome.Sdk//49 org.gnome.Platform//49
```

Produces `dist/gnosis-foliate-<version>-<arch>.flatpak`:

```sh
flatpak install --user dist/gnosis-foliate-*.flatpak
```

### Run without installing (for development)

```sh
glib-compile-schemas data
GSETTINGS_SCHEMA_DIR=data gjs -m src/main.js
```

### Clean build artifacts

```sh
./build.sh clean
```

## Using it

- **First run**: use *Open…* or *Import from Legacy Gnosis…* (primary menu)
  if you have an existing gnosis Rust library, or add a **Library Folder**
  from Settings (sidebar → Settings…) to have Gnosis find your EPUBs
  automatically.
- **Sorting/filtering** your library and **browsing by author/series** are
  in the library menu and sidebar respectively.
- **<kbd>Ctrl</kbd>+<kbd>R</kbd>** in the library rescans your folders for
  new books and refreshes any book whose file has changed since it was last
  scanned.
- Everything else works the same as in Foliate — see its own
  [documentation](https://github.com/johnfactotum/foliate) and
  [FAQ](https://github.com/johnfactotum/foliate/blob/gtk4/docs/faq.md) for
  reading/annotation/TTS features not covered above.

## License

GPL-3.0-or-later, same license as Foliate. See [COPYING](COPYING).

Built on [Foliate](https://github.com/johnfactotum/foliate) by John
Factotum, including its vendored copies of
[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT),
[zip.js](https://github.com/gildas-lormeau/zip.js) (BSD-3-Clause),
[fflate](https://github.com/101arrowz/fflate) (MIT), and
[PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0).
