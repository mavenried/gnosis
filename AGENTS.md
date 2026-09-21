# AGENTS.md — Gnosis (gnosis-foliate)

Developer/agent orientation for the [gnosis-foliate](https://github.com/mavenried/gnosis) codebase.

## What this project is

Gnosis is a GTK4/libadwaita EPUB reader. It is a fork of
[Foliate](https://github.com/johnfactotum/foliate) that replaces Foliate's
OPDS-based catalog model with a local **library management** system: watched
folders, author/series browsing, sort/filter, mark-as-read, automatic refresh
when an EPUB file changes on disk, and a one-time migration from the
predecessor [gnosis-rust](https://github.com/mavenried/gnosis-rust) app.

The reading engine itself (pagination, annotations, TTS, dictionary lookups,
themes) is inherited from Foliate unchanged.

## Stack

| Layer        | Technology                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| Language     | GJS (GNOME JavaScript, ES modules via `gjs -m`)                                               |
| UI toolkit   | GTK4 + libadwaita                                                                             |
| Rendering    | WebKitGTK — book content is rendered in a `WebView`                                           |
| Book parsing | [`foliate-js`](https://github.com/johnfactotum/foliate-js) (git submodule, `src/foliate-js/`) |
| Build        | Meson + `build.sh` wrapper                                                                    |
| Data format  | JSON files per-book in `$XDG_DATA_HOME/me.mavenried.Gnosis/`                                  |

There is no database. Each book's metadata, progress, annotations, and
bookmarks live in a single JSON file named `<encodeURIComponent(identifier)>.json`.
Identifiers are derived deterministically from the SHA-256 hash of the normalized file
path (`gnosis:<sha256>`), ensuring every unique file on disk maps to its own entry.
Each book JSON also stores `lastReadAt` (milliseconds since the Unix epoch), which
is updated when a book is opened and drives the Recently Read sorter.
Cover art is cached as `<encodeURIComponent(identifier)>.png` in
`$XDG_CACHE_HOME/…`.

## Key source files

| File                   | Purpose                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.js`          | GJS entry point — creates the `Gio.Application`                                                                                |
| `src/app.js`           | `ApplicationWindow`, primary menu, file-open, window management                                                                |
| `src/library.js`       | `BookList` (the in-memory list model), `LibraryView` (GTK list/grid), `Library` widget (sidebar + search + browse), `URIStore` |
| `src/library-scan.js`  | Folder watching, `scanLibraryFolders`, `refreshStaleBooks`, `refreshAllBooks`, `runLibraryRefresh`, `SettingsDialog`           |
| `src/data.js`          | `BookData` (per-book storage: progress, annotations, bookmarks, cover, fingerprint), `BookDataStore`                           |
| `src/book-viewer.js`   | `BookViewer` widget, `importFiles` pipeline (extract metadata → save cover → write JSON)                                       |
| `src/gnosis-import.js` | One-time migration from gnosis-rust's SQLite database                                                                          |
| `src/utils.js`         | Shared utilities: `memoize`, `JSONStorage`, `mapLimit`, GTK helpers                                                            |
| `src/format.js`        | Number/string formatting helpers                                                                                               |
| `src/annotations.js`   | Annotation and bookmark models                                                                                                 |
| `src/webview.js`       | `WebView` wrapper around WebKitGTK                                                                                             |
| `src/foliate-js/`      | Vendored book-parsing submodule (do not edit)                                                                                  |

## Architecture notes

### Library data flow

```
Disk JSON files
  → BookList (#files array, lazy-loaded into Gio.ListStore)
    → Gtk.FilterListModel / Gtk.SortListModel
      → Gtk.GridView / Gtk.ListView (SignalListItemFactory)
        → BookItem / BookRow widgets
```

`BookList` is a singleton (`getBooks()` / `getBookList()`). It is memoized —
create it once on first library access; `getBookList()` returns `null` if it
hasn't been created yet (avoids constructing it just to update it from the
reader side).

### Caches inside `BookList`

- **`#readFileMemo`** — `utils.memoize(utils.readJSONFile)`, keyed by
  `Gio.File` object identity. Caches parsed JSON for each book's data file.
  Cache entries must be evicted (via `#readFileMemo.cache.delete(file)`) whenever
  the JSON is rewritten so progress, annotations, bookmarks, and `lastReadAt`
  changes are visible to the library models.
- **`#coverCache`** — `Map<identifier, GdkPixbuf.Pixbuf>`. Must be evicted
  (`#coverCache.delete(identifier)`) at the same time so the newly written PNG
  is read from disk on the next `bind`.

### `BookList.update(path, { invalidateCache })`

Called whenever a book's JSON file changes. Removes the old `Gio.File` entry
from the list store and inserts a fresh one at position 0 (most-recently-updated).
This remove/reinsert behavior currently resets a GTK list/grid scroll anchor;
in-place model updates are a future improvement.
Pass `{ invalidateCache: true }` **only** when the EPUB source file was
actually re-imported (metadata/cover may have changed). Do **not** pass it for
ordinary progress/annotation/read-status saves; the JSON cache is still evicted,
but the cover cache does not need to be.

Call sites that pass `invalidateCache: true`:

- `refreshStaleBooks` (stale EPUB detected, re-imported)
- `refreshAllBooks` (full refresh via Settings → Refresh Now)
- `importFromGnosis` (first-time migration import)

Call sites that use the default (`false`):

- `JSONStorage 'modified'` signal in `data.js` (progress/annotation save)
- `toggleRead` in `library.js`

`LibraryView` uses `Gtk.MultiSelection` for both grid and list views. Ctrl-click
adds/removes individual books and Shift-click selects a range; opening a book
clears the selection. Batch read/unread/remove actions are exposed in the library
header. Each card/row retains its `…` menu, which also opens on right-click.

Status filtering is a dedicated checklist popover with independent Unread,
Reading, and Read toggles. With no status selected, all books are shown.

### Refresh pipeline

`runLibraryRefresh()` (Ctrl+R / startup) runs two steps in sequence:

1. **`refreshStaleBooks`** — stat every known book's source EPUB; if
   size or mtime differs from the stored fingerprint, re-import it. Also
   deletes books whose source file no longer exists on disk.
2. **`scanLibraryFolders`** — recursively walk configured library folders,
   import any EPUB not already in the URI store.

`runFullLibraryRefresh()` (Settings → Refresh Now) runs `refreshAllBooks`
instead of step 1: same mtime check but covers all books unconditionally
(not just ones flagged stale).

Both report progress via `refreshStatus` (a GObject singleton with `active`
and `label` properties), which the `Library` widget binds to a banner.

### `utils.memoize`

Returns a memoized function with a `.cache` property exposing the internal
`Map`, so callers can surgically evict entries:

```js
const memo = utils.memoize(fn);
memo.cache.delete(key); // evict one entry
```

### `utils.mapLimit(items, limit, fn)`

Runs an async function over `items` with at most `limit` calls in flight at
once. Used by scan/refresh to keep large libraries from blocking the UI on
unbounded concurrent `stat()` calls. `CONCURRENCY = 8` in `library-scan.js`.

## Development workflow

### Run without installing

```sh
glib-compile-schemas data
GSETTINGS_SCHEMA_DIR=data gjs -m src/main.js
```

### Install to user profile

```sh
./build.sh install   # installs to ~/.local
gnosis
```

### Lint

```sh
npx eslint src/
```

ESLint config is in `eslint.config.js`. The project uses standard ES2022+
syntax; GObject/GLib imports come from `gi://` URIs.

## Conventions

- **GObject registration**: use `GObject.registerClass({ GTypeName, Template, InternalChildren, Properties, Signals }, class extends … { … })`. `InternalChildren` names use underscores and are accessed as `this._name`.
- **Signals**: snake-case names, e.g. `'remove-book'`. Handlers receive the emitting object as the first argument.
- **Settings**: accessed via `utils.settings('library')` (schema `me.mavenried.Gnosis.library`). Bind with `utils.bindSettings(name, target, propArray)`.
- **i18n**: `gettext as _` and `ngettext` from the `'gettext'` module; format strings via `format.vprintf`.
- **No top-level `await`**: GJS ES modules don't support top-level await; async work is kicked off in constructors or signal handlers.
- **Async I/O**: prefer `_async` GIO variants promisified via `Gio._promisify` (see top of `utils.js`) rather than blocking calls on the main thread, especially in scan/refresh loops.

## What _not_ to touch

- `src/foliate-js/` — vendored submodule. Upstream changes go there; don't edit locally unless fixing a Gnosis-specific bug that can't live elsewhere.
- `src/webview.js` / book rendering internals — inherited from Foliate; changes here risk breaking the reading experience in subtle ways.
