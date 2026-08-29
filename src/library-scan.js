// Directory-based library scanning, matching gnosis (the app this reader was
// forked to replace): point Foliate at folders and it recursively finds and
// imports any EPUBs in them, skipping files already in the library.
import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { gettext as _, ngettext } from 'gettext'
import * as utils from './utils.js'
import * as format from './format.js'
import { getURIStore, getBookList } from './library.js'
import { importFiles } from './book-viewer.js'
import { getFingerprintAsync } from './data.js'

const folderStore = new utils.JSONStorage(pkg.datapath('library'), 'folders')

// how many directories/books are checked concurrently when scanning or
// refreshing; keeps a large library from blocking the UI on one slow stat()
// at a time, without opening unbounded numbers of file handles
const CONCURRENCY = 8

// same home-relative-path-or-URI convention BookData.saveURI() already uses
const toStoredValue = file => {
    const path = file.get_path()
    if (!path) return file.get_uri()
    const home = GLib.get_home_dir()
    return path.startsWith(home) ? path.replace(home, '~') : file.get_uri()
}

const toFile = value => value.startsWith('~')
    ? Gio.File.new_for_path(value.replace('~', GLib.get_home_dir()))
    : Gio.File.new_for_uri(value)

export const listLibraryFolders = () => folderStore.get('folders', []).map(toFile)

export const addLibraryFolder = file => {
    const value = toStoredValue(file)
    const folders = folderStore.get('folders', [])
    if (folders.includes(value)) return false
    folders.push(value)
    folderStore.set('folders', folders)
    return true
}

export const removeLibraryFolder = file => {
    const value = toStoredValue(file)
    folderStore.set('folders', folderStore.get('folders', []).filter(f => f !== value))
}

// reports library-wide background work (folder scans, metadata/cover
// refreshes) so any part of the UI can show a progress indicator for it
export const RefreshStatus = GObject.registerClass({
    GTypeName: 'FoliateRefreshStatus',
    Properties: utils.makeParams({
        'active': 'boolean',
        'label': 'string',
    }),
}, class extends GObject.Object {})

export const refreshStatus = new RefreshStatus()

// runs `fn`, reflecting its progress in `refreshStatus`; refuses to run
// concurrently with another tracked refresh (folder scan, stale check, full
// refresh all share the same indicator and shouldn't overlap)
const withRefreshStatus = async (label, fn) => {
    if (refreshStatus.active) return null
    refreshStatus.active = true
    refreshStatus.label = label
    try {
        return await fn()
    } finally {
        refreshStatus.active = false
        refreshStatus.label = ''
    }
}

// lists a single directory's children asynchronously, so many directories
// can be read concurrently (via GIO's own thread pool) instead of one at a
// time on the main thread
const listDirAsync = async path => {
    const dir = Gio.File.new_for_path(path)
    const entries = []
    try {
        const enumerator = await dir.enumerate_children_async(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null)
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null)
            if (!infos.length) break
            for (const info of infos)
                entries.push({ file: dir.get_child(info.get_name()), name: info.get_name(), info })
        }
    } catch (e) {
        console.debug(e)
    }
    return entries
}

// recursively finds EPUBs under the configured folders and imports any that
// aren't already in the library; each depth level is scanned concurrently
export const scanLibraryFolders = async (onProgress) => {
    const folders = listLibraryFolders()
    if (!folders.length) return { added: 0, scanned: 0 }

    const uriStore = getURIStore()
    const newFiles = []

    let level = folders
    while (level.length) {
        const nextLevel = []
        await utils.mapLimit(level, CONCURRENCY, async dir => {
            const path = dir.get_path()
            if (!path) return
            for (const { file, name, info } of await listDirAsync(path)) {
                if (info.get_file_type() === Gio.FileType.DIRECTORY) nextLevel.push(file)
                else if (name.toLowerCase().endsWith('.epub')) {
                    const filePath = file.get_path()
                    if (filePath && !uriStore.findIdentifierByPath(filePath)) newFiles.push(file)
                }
            }
        })
        level = nextLevel
    }

    if (!newFiles.length) return { added: 0, scanned: 0 }
    const results = await importFiles(newFiles, { onProgress })
    const added = results.filter(([, result]) => result === true).length
    return { added, scanned: newFiles.length }
}

// checks every book already in the library for a source-file mtime/size
// deviation (an EPUB edited/re-exported in place) and re-extracts its
// metadata and cover if so; unlike scanLibraryFolders() this doesn't look
// for new files, only refreshes ones already known. the staleness check
// itself runs with many books in flight at once via async stat() calls
export const refreshStaleBooks = async (onProgress) => {
    const books = getBookList()
    if (!books) return { refreshed: 0 }
    books.loadMore(Infinity) // this is a lazily-loaded list; force it all in first
    const uriStore = getURIStore()

    const jsonFiles = Array.from(utils.gliter(books), ([, file]) => file)
    const stale = []
    let checked = 0
    await utils.mapLimit(jsonFiles, CONCURRENCY, async jsonFile => {
        try {
            const data = books.readFile(jsonFile)
            const identifier = data?.metadata?.identifier
            if (identifier) {
                const uri = uriStore.get(identifier)
                const sourceFile = uri ? toFile(uri) : null
                const fp = sourceFile ? await getFingerprintAsync(sourceFile) : null
                if (fp) {
                    const stored = data.sourceFingerprint
                    if (!stored || stored.size !== fp.size || stored.mtime !== fp.mtime)
                        stale.push({ sourceFile, jsonPath: jsonFile.get_path() })
                }
            }
        } finally {
            checked++
            onProgress?.(checked, jsonFiles.length)
        }
    })

    if (!stale.length) return { refreshed: 0 }
    await importFiles(stale.map(x => x.sourceFile))
    for (const { jsonPath } of stale) if (jsonPath) books.update(jsonPath)
    return { refreshed: stale.length }
}

// re-extracts metadata and cover art for every book whose source file's
// mtime has changed since it was last refreshed (the mtime is stamped on
// every import, so this also covers books that have never been checked);
// used by the "Refresh Now" action in Settings
export const refreshAllBooks = async (onProgress) => {
    const books = getBookList()
    if (!books) return { refreshed: 0 }
    books.loadMore(Infinity)
    const uriStore = getURIStore()

    const candidates = []
    for (const [, jsonFile] of utils.gliter(books)) {
        const data = books.readFile(jsonFile)
        const identifier = data?.metadata?.identifier
        const uri = identifier ? uriStore.get(identifier) : null
        if (uri) candidates.push({
            sourceFile: toFile(uri),
            jsonPath: jsonFile.get_path(),
            mtime: data.sourceFingerprint?.mtime,
        })
    }
    if (!candidates.length) return { refreshed: 0 }

    // only reimport books whose source mtime differs from the one stored
    // at their last refresh, checked concurrently
    const targets = []
    await utils.mapLimit(candidates, CONCURRENCY, async candidate => {
        const fp = await getFingerprintAsync(candidate.sourceFile)
        if (fp && fp.mtime !== candidate.mtime) targets.push(candidate)
    })
    if (!targets.length) return { refreshed: 0 }

    await importFiles(targets.map(x => x.sourceFile), { onProgress })
    for (const { jsonPath } of targets) books.update(jsonPath)
    return { refreshed: targets.length }
}

// runs the lightweight startup/Ctrl+R refresh: pick up any source-file
// changes for existing books, then look for newly added files
export const runLibraryRefresh = () => withRefreshStatus(_('Checking library…'), async () => {
    const { refreshed } = await refreshStaleBooks((done, total) =>
        refreshStatus.label = format.vprintf(_('Checking books… (%d/%d)'), [done, total]))
    refreshStatus.label = _('Scanning library folders…')
    const { added } = await scanLibraryFolders((done, total) =>
        refreshStatus.label = format.vprintf(_('Importing books… (%d/%d)'), [done, total]))
    return { refreshed, added }
})

// runs a metadata + cover refresh of every book whose source has changed
// since it was last refreshed
export const runFullLibraryRefresh = () => withRefreshStatus(_('Refreshing library…'), async () => {
    const { refreshed } = await refreshAllBooks((done, total) =>
        refreshStatus.label = format.vprintf(_('Refreshing books… (%d/%d)'), [done, total]))
    return { refreshed }
})

export const SettingsDialog = GObject.registerClass({
    GTypeName: 'FoliateSettingsDialog',
    Template: pkg.moduleuri('ui/settings-dialog.ui'),
    InternalChildren: [
        'folders-list', 'add-button',
        'refresh-row', 'refresh-spinner', 'refresh-button',
    ],
}, class extends Adw.PreferencesDialog {
    #defaultSubtitle
    constructor(params) {
        super(params)
        this._add_button.connect('clicked', () => this.addFolder())
        this._refresh_button.connect('clicked', () => this.refreshAll())
        this.#defaultSubtitle = this._refresh_row.subtitle

        utils.connectWith(this, refreshStatus, {
            'notify::active': () => this.#syncRefreshStatus(),
            'notify::label': () => this.#syncRefreshStatus(),
        })
        this.connect('closed', () => utils.disconnectWith(this, refreshStatus))
        this.#syncRefreshStatus()

        this.refresh()
    }
    #syncRefreshStatus() {
        const active = refreshStatus.active
        this._refresh_spinner.visible = active
        this._refresh_button.sensitive = !active
        this._refresh_row.subtitle = active && refreshStatus.label
            ? refreshStatus.label : this.#defaultSubtitle
    }
    async refreshAll() {
        try {
            const result = await runFullLibraryRefresh()
            if (!result) return
            const { refreshed } = result
            const title = refreshed
                ? format.vprintf(ngettext(
                    'Refreshed %d book', 'Refreshed %d books', refreshed), [refreshed])
                : _('No books to refresh')
            this.root?.add_toast(new Adw.Toast({ title }))
        } catch (e) {
            console.error(e)
        }
    }
    refresh() {
        let child = this._folders_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._folders_list.remove(child)
            child = next
        }
        const folders = listLibraryFolders()
        if (!folders.length) {
            this._folders_list.append(new Adw.ActionRow({
                title: _('No folders added yet'),
            }))
            return
        }
        for (const file of folders) {
            const row = new Adw.ActionRow({ title: file.get_parse_name() })
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Remove'),
            })
            removeButton.connect('clicked', () => {
                removeLibraryFolder(file)
                this.refresh()
            })
            row.add_suffix(removeButton)
            this._folders_list.append(row)
        }
    }
    addFolder() {
        const dialog = new Gtk.FileDialog()
        dialog.select_folder(this.root, null, (_, res) => {
            try {
                const folder = dialog.select_folder_finish(res)
                if (addLibraryFolder(folder)) {
                    this.refresh()
                    scanLibraryFolders().catch(e => console.error(e))
                }
            } catch (e) {
                if (e instanceof Gtk.DialogError) console.debug(e)
                else console.error(e)
            }
        })
    }
})
