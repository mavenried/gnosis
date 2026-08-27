// Directory-based library scanning, matching gnosis (the app this reader was
// forked to replace): point Foliate at folders and it recursively finds and
// imports any EPUBs in them, skipping files already in the library.
import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { gettext as _ } from 'gettext'
import * as utils from './utils.js'
import { getURIStore, getBookList } from './library.js'
import { importFiles } from './book-viewer.js'
import { BookData } from './data.js'

const folderStore = new utils.JSONStorage(pkg.datapath('library'), 'folders')

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

// recursively finds EPUBs under the configured folders and imports any that
// aren't already in the library; yields to the main loop between directories
// so a large library doesn't block the UI while scanning
export const scanLibraryFolders = async () => {
    const folders = listLibraryFolders()
    if (!folders.length) return { added: 0, scanned: 0 }

    const uriStore = getURIStore()
    const pendingDirs = [...folders]
    const newFiles = []

    while (pendingDirs.length) {
        const dir = pendingDirs.shift()
        const path = dir.get_path()
        if (!path) continue
        for (const { file, name, info } of utils.listDir(path, 'standard::name,standard::type')) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) pendingDirs.push(file)
            else if (name.toLowerCase().endsWith('.epub')) {
                const filePath = file.get_path()
                if (filePath && !uriStore.findIdentifierByPath(filePath)) newFiles.push(file)
            }
        }
        await utils.wait(0)
    }

    if (!newFiles.length) return { added: 0, scanned: 0 }
    const results = await importFiles(newFiles)
    const added = results.filter(([, result]) => result === true).length
    return { added, scanned: newFiles.length }
}

// checks every book already in the library for a source-file mtime/size
// deviation (an EPUB edited/re-exported in place) and re-extracts its
// metadata and cover if so; unlike scanLibraryFolders() this doesn't look
// for new files, only refreshes ones already known
export const refreshStaleBooks = async () => {
    const books = getBookList()
    if (!books) return { refreshed: 0 }
    books.loadMore(Infinity) // this is a lazily-loaded list; force it all in first
    const uriStore = getURIStore()

    const stale = []
    for (const [, jsonFile] of utils.gliter(books)) {
        const identifier = books.readFile(jsonFile)?.metadata?.identifier
        if (!identifier) continue
        const uri = uriStore.get(identifier)
        if (!uri) continue
        const sourceFile = toFile(uri)
        if (!sourceFile.query_exists(null)) continue
        if (new BookData(identifier).isSourceStale(sourceFile))
            stale.push({ sourceFile, jsonPath: jsonFile.get_path() })
        await utils.wait(0)
    }

    if (!stale.length) return { refreshed: 0 }
    await importFiles(stale.map(x => x.sourceFile))
    for (const { jsonPath } of stale) if (jsonPath) books.update(jsonPath)
    return { refreshed: stale.length }
}

export const LibraryFoldersDialog = GObject.registerClass({
    GTypeName: 'FoliateLibraryFoldersDialog',
    Template: pkg.moduleuri('ui/library-folders-dialog.ui'),
    InternalChildren: ['folders-list', 'add-button'],
}, class extends Adw.PreferencesDialog {
    constructor(params) {
        super(params)
        this._add_button.connect('clicked', () => this.addFolder())
        this.refresh()
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
