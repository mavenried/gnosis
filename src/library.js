import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gdk from 'gi://Gdk'
import GdkPixbuf from 'gi://GdkPixbuf'
import Pango from 'gi://Pango'
import cairo from 'gi://cairo'
import { gettext as _, ngettext } from 'gettext'
import * as utils from './utils.js'
import * as format from './format.js'
import { exportAnnotations } from './annotations.js'
import { formatLanguageMap, formatAuthors, makeBookInfoWindow } from './book-info.js'
import { SettingsDialog, runLibraryRefresh, refreshStatus } from './library-scan.js'

const getURIFromTracker = identifier => {
    const connection = imports.gi.Tracker.SparqlConnection.bus_new(
        'org.freedesktop.Tracker3.Miner.Files', null, null)
    const statement = connection.query_statement(`
        SELECT ?uri
        WHERE {
            GRAPH tracker:Documents {
                ?u rdf:type nfo:EBook .
                ?u nie:isStoredAs ?uri .
                ?u nie:identifier ~identifier .
            }
        }`, null)
    statement.bind_string('identifier', identifier)
    const cursor = statement.execute(null)
    cursor.next(null)
    const uri = cursor.get_string(0)[0]
    cursor.close()
    connection.close()
    return uri
}

const showCovers = utils.settings('library')?.get_boolean('show-covers') ?? true

const listBooks = function* (path) {
    const ls = utils.listDir(path, 'standard::name,time::modified')
    for (const { file, name, info } of ls) try {
        if (!/\.json$/.test(name)) continue
        const modified = new Date(info.get_attribute_uint64('time::modified') * 1000)
        yield { file, modified }
    } catch (e) {
        console.error(e)
    }
}

class URIStore {
    #storage = new utils.JSONStorage(pkg.datapath('library'), 'uri-store')
    #map = new Map(this.#storage.get('uris'))
    get(id) {
        try {
            const uri = getURIFromTracker(id)
            if (uri) return uri
        } catch (e) {
            console.warn(e)
        }
        return this.#map.get(id)
    }
    set(id, uri) {
        this.#map.set(id, uri)
        this.#storage.set('uris', Array.from(this.#map.entries()))
    }
    delete(id) {
        this.#map.delete(id)
        this.#storage.set('uris', Array.from(this.#map.entries()))
    }
    findIdentifierByPath(path) {
        const home = GLib.get_home_dir()
        const short = path.startsWith(home) ? path.replace(home, '~') : path
        const uri = Gio.File.new_for_path(path).get_uri()
        for (const [id, value] of this.#map)
            if (value === short || value === uri) return id
        return null
    }
}

export const getURIStore = utils.memoize(() => new URIStore())

const BookList = GObject.registerClass({
    GTypeName: 'FoliateBookList',
    Properties: utils.makeParams({
        // total number of books in the library, including any not yet
        // scrolled into view (unlike get_n_items(), which only counts what's
        // been lazily loaded so far); kept in sync by delete() and update()
        'total-count': 'uint',
    }),
}, class extends Gio.ListStore {
    #uriStore = getURIStore()
    #files = Array.from(listBooks(pkg.datadir) ?? [])
        .sort((a, b) => b.modified - a.modified)
        .map(x => x.file)
    #iter = this.#files.values()
    constructor(params) {
        super(params)
        this.total_count = this.#files.length
        this.readFile = utils.memoize(utils.readJSONFile)
        // don't use utils.memoize here: it would cache a failed load (e.g. if
        // the cover hasn't finished being written yet) as permanently null
        const coverCache = new Map()
        this.readCover = identifier => {
            if (coverCache.has(identifier)) return coverCache.get(identifier)
            const path = pkg.cachepath(`${encodeURIComponent(identifier)}.png`)
            try {
                const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
                coverCache.set(identifier, pixbuf)
                return pixbuf
            } catch {
                return null
            }
        }
    }
    loadMore(n) {
        for (let i = 0; i < n; i++) {
            const { value, done } = this.#iter.next()
            if (done) return true
            else if (value) this.append(value)
        }
    }
    getBook(file) {
        const { identifier } = this.readFile(file)?.metadata ?? {}
        return this.getBookFromIdentifier(identifier)
    }
    getBookFromIdentifier(identifier) {
        const uri = this.#uriStore.get(identifier)
        return !uri ? null : uri.startsWith('~')
            ? Gio.File.new_for_path(uri.replace('~', GLib.get_home_dir()))
            : Gio.File.new_for_uri(uri)
    }
    delete(file) {
        const name = file.get_basename()
        const cover = Gio.File.new_for_path(pkg.cachepath(name.replace('.json', '.png')))
        const id = decodeURIComponent(name.replace('.json', ''))
        this.#uriStore.delete(id)
        for (const f of [file, cover]) try { f.delete(null) } catch {}
        for (const [i, el] of utils.gliter(this)) if (el === file) this.remove(i)
        this.total_count--
    }
    update(path) {
        // remove it from the queue if it's not yet loaded
        const i = this.#files.findIndex(f => f?.get_path() === path)
        // a book not found in either place is genuinely new, rather than a
        // refresh of one we already know about
        let isNew = i === -1
        // set to null instead of removing it so we don't mess up the iterator
        if (i !== -1) this.#files[i] = null
        // remove it from the list if it has been loaded
        for (const [i, el] of utils.gliter(this)) if (el.get_path() === path) {
            isNew = false
            this.remove(i)
        }
        if (isNew) this.total_count++
        this.insert(0, Gio.File.new_for_path(path))
    }
})

let gotBooks // don't create book list just to update it
const getBooks = utils.memoize(() => (gotBooks = true, new BookList()))
export const getBookList = () => gotBooks ? getBooks() : null

const width = 256
const height = width * 1.5
const surface = new cairo.ImageSurface(cairo.Format.ARGB32, width, height)
const defaultPixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, width, height)

GObject.registerClass({
    GTypeName: 'FoliateBookImage',
    Template: pkg.moduleuri('ui/book-image.ui'),
    InternalChildren: ['image', 'generated', 'title', 'progress-pie'],
}, class extends Gtk.Overlay {
    load(pixbuf, title) {
        if (pixbuf) {
            this._generated.visible = false
            this._image.set_pixbuf(pixbuf)
            this._image.opacity = 1
        } else {
            this._image.set_pixbuf(defaultPixbuf)
            this._image.opacity = 0
            this._title.label = title
            this._generated.visible = true
        }
        this._image.tooltip_text = title
    }
    setProgress(status, frac) {
        const visible = status !== 'unread'
        this._progress_pie.visible = visible
        if (!visible) return
        this._progress_pie.set_draw_func((_, cr, width, height) =>
            drawProgressBadge(cr, width, height, status, frac))
        this._progress_pie.queue_draw()
    }
})

const fraction = p => !isNaN(p?.[1]) && p?.[1] > 0 ? p[0] / p[1] : null

const READ_THRESHOLD = 0.97
const readingStatus = p => {
    const frac = fraction(p)
    if (frac == null || frac <= 0) return 'unread'
    if (frac >= READ_THRESHOLD) return 'read'
    return 'reading'
}

// a small pie-shaped progress badge on the corner of the cover: a wedge
// showing how much of the book has been read, or a checkmark once finished
const drawProgressBadge = (cr, width, height, status, frac) => {
    const cx = width / 2, cy = height / 2
    const radius = Math.min(width, height) / 2

    cr.arc(cx, cy, radius, 0, 2 * Math.PI)
    cr.setSourceRGBA(0.35, 0.35, 0.37, 0.92)
    cr.fill()

    cr.setSourceRGBA(1, 1, 1, 0.95)
    if (status === 'read') {
        cr.setLineWidth(Math.max(1.5, radius * 0.22))
        cr.setLineCap(cairo.LineCap.ROUND)
        cr.setLineJoin(cairo.LineJoin.ROUND)
        cr.moveTo(cx - radius * 0.45, cy + radius * 0.05)
        cr.lineTo(cx - radius * 0.12, cy + radius * 0.4)
        cr.lineTo(cx + radius * 0.5, cy - radius * 0.35)
        cr.stroke()
    } else {
        const start = -Math.PI / 2
        const end = start + (frac ?? 0) * 2 * Math.PI
        cr.moveTo(cx, cy)
        cr.arc(cx, cy, radius - 2.5, start, end)
        cr.lineTo(cx, cy)
        cr.closePath()
        cr.fill()
    }
}

const BookItem = GObject.registerClass({
    GTypeName: 'FoliateBookItem',
    Template: pkg.moduleuri('ui/book-item.ui'),
    InternalChildren: ['image', 'progress', 'title', 'author'],
    Signals: {
        'open-new-window': { param_types: [Gio.File.$gtype] },
        'remove-book': { param_types: [Gio.File.$gtype] },
        'export-book': { param_types: [Gio.File.$gtype] },
        'book-info': { param_types: [Gio.File.$gtype] },
        'open-external-app': { param_types: [Gio.File.$gtype] },
        'toggle-read': { param_types: [Gio.File.$gtype] },
    },
}, class extends Gtk.Box {
    #item
    constructor(params) {
        super(params)
        this.insert_action_group('book-item', utils.addSimpleActions({
            'open-new-window': () => this.emit('open-new-window', this.#item),
            'remove': () => this.emit('remove-book', this.#item),
            'export': () => this.emit('export-book', this.#item),
            'info': () => this.emit('book-info', this.#item),
            'open-external-app': () => this.emit('open-external-app', this.#item),
            'toggle-read': () => this.emit('toggle-read', this.#item),
        }))
    }
    update(item, data, cover) {
        this.#item = item
        const title = formatLanguageMap(data.metadata?.title)
        this._title.text = title
        this._image.load(cover?.then ? null : cover, title)
        this._progress.label = format.percent(fraction(data.progress))
        this._image.setProgress(readingStatus(data.progress), fraction(data.progress))

        const author = formatAuthors(data.metadata)
        this._author.label = author
        this._author.visible = Boolean(author)
    }
})

const BookRow = GObject.registerClass({
    GTypeName: 'FoliateBookRow',
    Template: pkg.moduleuri('ui/book-row.ui'),
    InternalChildren: ['title', 'author', 'progress-grid', 'progress-bar', 'progress-label'],
    Signals: {
        'open-new-window': { param_types: [Gio.File.$gtype] },
        'remove-book': { param_types: [Gio.File.$gtype] },
        'export-book': { param_types: [Gio.File.$gtype] },
        'book-info': { param_types: [Gio.File.$gtype] },
        'open-external-app': { param_types: [Gio.File.$gtype] },
        'toggle-read': { param_types: [Gio.File.$gtype] },
    },
}, class extends Gtk.Box {
    #item
    constructor(params) {
        super(params)
        this.insert_action_group('book-item', utils.addSimpleActions({
            'open-new-window': () => this.emit('open-new-window', this.#item),
            'remove': () => this.emit('remove-book', this.#item),
            'export': () => this.emit('export-book', this.#item),
            'info': () => this.emit('book-info', this.#item),
            'open-external-app': () => this.emit('open-external-app', this.#item),
            'toggle-read': () => this.emit('toggle-read', this.#item),
        }))
    }
    update(item, data) {
        this.#item = item
        const { metadata, progress } = data
        const title = formatLanguageMap(metadata?.title)
        this._title.label = title

        const author = formatAuthors(metadata)
        this._author.label = author
        this._author.visible = Boolean(author)

        const frac = fraction(progress)
        this._progress_bar.fraction = frac
        this._progress_label.label = format.percent(frac)

        const bookSize = Math.min((progress?.[1] + 1) / 1500, 0.8)
        const steps = 10
        const span = Math.ceil(bookSize * steps)
        const grid = this._progress_grid
        if (isNaN(span)) grid.hide()
        else {
            grid.show()
            grid.remove(this._progress_bar)
            grid.remove(this._progress_label)
            grid.attach(this._progress_bar, 0, 0, span, 1)
            grid.attach(this._progress_label, span, 0, steps - span, 1)
        }
    }
})

const matchString = (x, q) => typeof x === 'string'
    ? x.toLowerCase().includes(q) : false

const compareStrings = (a, b) => (a || '').localeCompare(b || '')

const getFileMTime = file => {
    try {
        return file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint64('time::modified')
    } catch {
        return 0
    }
}

// foliate-js's `belongsTo.series` is an array for real EPUB3
// belongs-to-collection metadata, but a single object for the legacy
// calibre:series fallback (see foliate-js/epub.js) — handle both
const getSeries = metadata => {
    const series = metadata?.belongsTo?.series
    if (!series) return ''
    const item = Array.isArray(series) ? series[0] : series
    return formatLanguageMap(item?.name) || ''
}

const getSeriesIndex = metadata => {
    const series = metadata?.belongsTo?.series
    if (!series) return null
    const item = Array.isArray(series) ? series[0] : series
    // the EPUB3 belongs-to-collection path gives a raw string ("2"), while
    // the legacy calibre:series_index fallback already parses to a number
    const position = typeof item?.position === 'string'
        ? parseFloat(item.position) : item?.position
    return typeof position === 'number' && !isNaN(position) ? position : null
}

// missing index sorts before a defined one, matching gnosis's own
// Option<f64>::partial_cmp semantics (None < Some)
const compareSeriesIndex = (a, b) => {
    if (a == null && b == null) return 0
    if (a == null) return -1
    if (b == null) return 1
    return a - b
}

// all sort keys need the whole library loaded to compare correctly, since
// there's no database index to sort by; see `load-all`/`#applySort()`
const SORTERS = {
    title: (a, b, books) => compareStrings(
        formatLanguageMap(books.readFile(a)?.metadata?.title),
        formatLanguageMap(books.readFile(b)?.metadata?.title)),
    author: (a, b, books) => compareStrings(
        formatAuthors(books.readFile(a)?.metadata),
        formatAuthors(books.readFile(b)?.metadata)),
    added: (a, b, books) =>
        (books.readFile(b)?.added ?? 0) - (books.readFile(a)?.added ?? 0),
    // no per-book "last read" timestamp is tracked; the book's JSON file is
    // rewritten every time reading progress is saved, so its mtime doubles
    // as a "last read" signal without needing to hook into the reader
    read: (a, b) => getFileMTime(b) - getFileMTime(a),
    series: (a, b, books) => {
        const ma = books.readFile(a)?.metadata, mb = books.readFile(b)?.metadata
        const sa = getSeries(ma), sb = getSeries(mb)
        if (Boolean(sa) !== Boolean(sb)) return sa ? -1 : 1
        return compareStrings(sa, sb)
            || compareSeriesIndex(getSeriesIndex(ma), getSeriesIndex(mb))
            || compareStrings(formatLanguageMap(ma?.title), formatLanguageMap(mb?.title))
    },
}

GObject.registerClass({
    GTypeName: 'FoliateLibraryView',
    Template: pkg.moduleuri('ui/library-view.ui'),
    InternalChildren: ['scrolled'],
    Properties: utils.makeParams({
        'view-mode': 'string',
        'sort-by': 'string',
        'status-filter': 'string',
    }),
    Signals: {
        'load-more': { return_type: GObject.TYPE_BOOLEAN },
        'load-all': {},
        'activate': { param_types: [GObject.TYPE_OBJECT] },
    },
}, class extends Gtk.Stack {
    #done = false
    #searchFilter = new Gtk.CustomFilter()
    #statusFilter = new Gtk.CustomFilter()
    #browseFilter = new Gtk.CustomFilter()
    #filter = (() => {
        const filter = new Gtk.EveryFilter()
        filter.append(this.#searchFilter)
        filter.append(this.#statusFilter)
        filter.append(this.#browseFilter)
        return filter
    })()
    #filterModel = utils.connect(new Gtk.FilterListModel({ filter: this.#filter }),
        { 'items-changed': () => this.#update() })
    #sorter = new Gtk.CustomSorter()
    #sortModel = new Gtk.SortListModel({ model: this.#filterModel, sorter: this.#sorter })
    #itemConnections = {
        'open-new-window': (_, file) => this.root.addWindow(getBooks().getBook(file)),
        'remove-book': (_, file) => this.removeBook(file),
        'export-book': (_, file) => {
            const data = getBooks().readFile(file)
            exportAnnotations(this.get_root(), data)
        },
        'book-info': (_, file) => {
            const books = getBooks()
            const { metadata } = books.readFile(file)
            const cover = books.readCover(metadata.identifier)
            makeBookInfoWindow(this.get_root(), metadata, cover)
        },
        'open-external-app': (_, file) => this.openWithExternalApp(getBooks().getBook(file)),
        'toggle-read': (_, file) => this.toggleRead(file),
    }
    actionGroup = utils.addMethods(this, {
        props: ['view-mode', 'sort-by', 'status-filter'],
    })
    constructor(params) {
        super(params)
        utils.connect(this._scrolled.vadjustment, {
            'changed': this.#checkAdjustment.bind(this),
            'value-changed': this.#checkAdjustment.bind(this),
        })
        const show = () => this.view_mode === 'list' ? this.showList() : this.showGrid()
        this.connect('notify::view-mode', show)
        show()
        this.connect('notify::sort-by', () => this.#applySort())
        this.connect('notify::status-filter', () => this.#applyStatus())
    }
    #checkAdjustment(adj) {
        if (this.#done) return
        if (adj.value + adj.page_size * 1.5 >= adj.upper) {
            const done = this.emit('load-more')
            if (done) this.#done = true
            else utils.wait(10).then(() => this.#checkAdjustment(adj))
        }
    }
    #update() {
        this.visible_child_name = !this.#filterModel.model.get_n_items() ? 'empty'
            : !this.#filterModel.get_n_items() ? 'no-results' : 'main'
    }
    setModel(model) {
        this.#filterModel.model = model
        this.#update()
    }
    showGrid() {
        this._scrolled.child?.unparent()
        this._scrolled.child = utils.connect(new Gtk.GridView({
            single_click_activate: true,
            max_columns: 20,
            vscroll_policy: Gtk.ScrollablePolicy.NATURAL,
            model: new Gtk.NoSelection({ model: this.#sortModel }),
            factory: utils.connect(new Gtk.SignalListItemFactory(), {
                'setup': (_, item) => item.child =
                    utils.connect(new BookItem(), this.#itemConnections),
                'bind': (_, { child, item }) => {
                    const { cover, data } = this.#getData(item, showCovers)
                    child.update(item, data, cover)
                    if (cover?.then) cover
                        .then(cover => child.update(item, data, cover))
                        .catch(e => console.warn(e))
                },
            }),
        }), { 'activate': (_, pos) =>
            this.emit('activate', this.#sortModel.get_item(pos)) })
        this._scrolled.child.remove_css_class('view')
    }
    showList() {
        this._scrolled.child?.unparent()
        this._scrolled.child = new Adw.ClampScrollable({
            child: utils.connect(utils.addClass(new Gtk.ListView({
                single_click_activate: true,
                model: new Gtk.NoSelection({ model: this.#sortModel }),
                factory: utils.connect(new Gtk.SignalListItemFactory(), {
                    'setup': (_, item) => item.child = utils.connect(
                        new BookRow(), this.#itemConnections),
                    'bind': (_, { child, item }) => {
                        const { data } = this.#getData(item, false)
                        child.update(item, data)
                    },
                }),
            }), 'book-list'), { 'activate': (_, pos) =>
                this.emit('activate', this.#sortModel.get_item(pos)) }),
        })
    }
    #getData(file, getCover) {
        const books = getBooks()
        const data = books.readFile(file)
        const identifier = data?.metadata?.identifier
        const cover = getCover && identifier ? books.readCover(identifier) : null
        return { cover, data }
    }
    search(text) {
        const q = text.trim().toLowerCase()
        if (!q) {
            this.#searchFilter.set_filter_func(null)
            return
        }
        this.emit('load-all')
        const fields = ['title', 'creator', 'description']
        const { readFile } = this.#filterModel.model
        this.#searchFilter.set_filter_func(file => {
            const { metadata } = readFile(file)
            if (!metadata) return false
            return fields.some(field => matchString(metadata[field], q))
        })
    }
    #applySort() {
        this.emit('load-all')
        const books = getBooks()
        const key = this.sort_by || 'added'
        const compare = SORTERS[key] ?? SORTERS.added
        this.#sorter.set_sort_func((a, b) => {
            const result = compare(a, b, books)
            return result < 0 ? -1 : result > 0 ? 1 : 0
        })
    }
    #applyStatus() {
        const status = this.status_filter || 'all'
        if (status === 'all') {
            this.#statusFilter.set_filter_func(null)
            return
        }
        this.emit('load-all')
        const { readFile } = this.#filterModel.model
        this.#statusFilter.set_filter_func(file =>
            readingStatus(readFile(file)?.progress) === status)
    }
    setBrowseFilter(field, value) {
        this.emit('load-all')
        const { readFile } = this.#filterModel.model
        this.#browseFilter.set_filter_func(file => {
            const { metadata } = readFile(file) ?? {}
            if (!metadata) return false
            return (field === 'authors'
                ? formatAuthors(metadata)
                : getSeries(metadata)) === value
        })
    }
    clearBrowseFilter() {
        this.#browseFilter.set_filter_func(null)
    }
    toggleRead(file) {
        const books = getBooks()
        const data = books.readFile(file)
        const status = readingStatus(data?.progress)
        const total = data?.progress?.[1] || 1
        const identifier = decodeURIComponent(file.get_basename().replace('.json', ''))
        const storage = new utils.JSONStorage(pkg.datadir, identifier)
        storage.set('progress', status === 'read' ? [0, total] : [total, total], false)
        storage.saveNow()
        books.update(storage.path)
    }
    removeBook(file) {
        const dialog = new Adw.AlertDialog({
            heading: _('Remove Book?'),
            body: _('Reading progress, annotations, and bookmarks will be permanently lost'),
        })
        dialog.add_response('cancel', _('_Cancel'))
        dialog.add_response('remove', _('_Remove'))
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.present(this.get_root())
        dialog.connect('response', (_, response) => {
            if (response === 'remove') getBooks().delete(file)
        })
    }
    openWithExternalApp(file) {
        if (!file) return
        const path = file.get_path()
        if (!path) return

        const dialog = new Gtk.AppChooserDialog({
            gfile: file,
            modal: true,
            transient_for: this.root,
        })

        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const app_info = dialog.get_app_info()
                if (app_info) {
                    try {
                        app_info.launch([file], null)
                    } catch (e) {
                        console.error(
                            'Failed to open file with selected application:',
                            e,
                        )
                        this.root.error(
                            _('Failed to Open'),
                            _('Could not open the file with the selected application'),
                        )
                    }
                }
            }
            dialog.destroy()
        })

        dialog.show()
    }
})

const SidebarItem = utils.makeDataClass('FoliateSidebarItem', {
    'type': 'string',
    'icon': 'string',
    'label': 'string',
    'value': 'string',
})

const SidebarRow = GObject.registerClass({
    GTypeName: 'FoliateSidebarRow',
    Properties: utils.makeParams({
        'item': 'object',
    }),
}, class extends Gtk.Box {
    #icon = new Gtk.Image()
    #label = new Gtk.Label({
        ellipsize: Pango.EllipsizeMode.END,
    })
    constructor(params) {
        super(params)
        this.spacing = 12
        this.margin_start = 6
        this.append(this.#icon)
        this.append(this.#label)
        this.item.bindProperties({
            icon: [this.#icon, 'icon-name'],
            label: [this.#label, 'label'],
        })
    }
})

const sidebarListModel = new Gio.ListStore()
sidebarListModel.append(new SidebarItem({
    icon: 'gnosis-library-symbolic',
    label: _('All Books'),
    value: 'library',
}))
sidebarListModel.append(new SidebarItem({
    type: 'browse',
    icon: 'gnosis-author-symbolic',
    label: _('Authors'),
    value: 'authors',
}))
sidebarListModel.append(new SidebarItem({
    type: 'browse',
    icon: 'view-list-symbolic',
    label: _('Series'),
    value: 'series',
}))
sidebarListModel.append(new SidebarItem({
    type: 'action',
    icon: 'preferences-system-symbolic',
    label: _('Settings…'),
    value: 'settings',
}))

export const Library = GObject.registerClass({
    GTypeName: 'FoliateLibrary',
    Template: pkg.moduleuri('ui/library.ui'),
    InternalChildren: [
        'breakpoint-bin', 'split-view',
        'sidebar-list-box', 'main-stack',
        'library-toolbar-view',
        'books-view', 'search-bar', 'search-entry',
        'browse-toolbar-view', 'browse-title', 'browse-list-box',
        'refresh-revealer', 'refresh-label', 'library-title',
    ],
}, class extends Gtk.Overlay {
    #browseField = 'authors'
    constructor(params) {
        super(params)

        refreshStatus.bind_property('active', this._refresh_revealer, 'reveal-child',
            GObject.BindingFlags.SYNC_CREATE)
        refreshStatus.bind_property('label', this._refresh_label, 'label',
            GObject.BindingFlags.SYNC_CREATE)

        this._breakpoint_bin.add_breakpoint(utils.connect(new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 700px'),
        }), {
            'apply': () => this._split_view.collapsed = true,
            'unapply': () => this._split_view.collapsed = false,
        }))

        this._sidebar_list_box.set_header_func((row, before) => {
            if (!before)
                row.set_header(utils.addClass(new Gtk.Label({
                    label: _('Library'),
                    xalign: 0,
                    margin_start: 12,
                    margin_bottom: 6,
                }), 'caption-heading', 'dim-label'))
        })
        this._sidebar_list_box.bind_model(sidebarListModel, item =>
            new Gtk.ListBoxRow({ child: new SidebarRow({ item }) }))
        this._sidebar_list_box.connect('row-activated', (__, row) => {
            const { type, value } = row.child.item
            if (value === 'settings') return this.showSettings()
            if (value === 'library') {
                this._books_view.clearBrowseFilter()
                return this._main_stack.visible_child = this._library_toolbar_view
            }
            if (type === 'browse') return this.showBrowse(value)
        })
        this._sidebar_list_box.select_row(this._sidebar_list_box.get_row_at_index(0))

        this._browse_list_box.connect('row-activated', (__, row) => {
            this._books_view.setBrowseFilter(this.#browseField, row.browseValue)
            this._main_stack.visible_child = this._library_toolbar_view
        })

        const books = getBooks()

        const updateTitle = () => this._library_title.label =
            format.vprintf(_('Library (%d)'), [books.total_count])
        updateTitle()
        books.connect('notify::total-count', updateTitle)

        utils.connect(this._books_view, {
            'activate': (_, item) => this.root.openFile(books.getBook(item)),
            'load-more': () => books.loadMore(1),
            'load-all': () => books.loadMore(Infinity),
        })
        this._books_view.setModel(books)
        this._books_view.view_mode = 'grid'
        utils.bindSettings('library', this._books_view, ['view-mode', 'sort-by'])
        books.loadMore(10)

        this._search_bar.connect_entry(this._search_entry)
        this._search_entry.connect('search-changed', entry =>
            this._books_view.search(entry.text))

        this.insert_action_group('library', this._books_view.actionGroup)
        this.add_controller(utils.addShortcuts({
            '<ctrl>r': () => (this.refreshLibrary(), true),
        }))
        this.refreshLibrary()
    }
    async refreshLibrary() {
        try {
            const result = await runLibraryRefresh()
            if (!result) return
            const { refreshed, added } = result
            const parts = []
            if (refreshed) parts.push(format.vprintf(ngettext(
                'Refreshed %d book', 'Refreshed %d books', refreshed), [refreshed]))
            if (added) parts.push(format.vprintf(ngettext(
                'Added %d book', 'Added %d books', added), [added]))
            if (parts.length) this.root?.add_toast(new Adw.Toast({ title: parts.join(' · ') }))
        } catch (e) {
            console.error(e)
        }
    }
    showSettings() {
        this._sidebar_list_box.select_row(null)
        const dialog = new SettingsDialog()
        dialog.present(this.root)
    }
    showBrowse(kind) {
        this.#browseField = kind
        const books = getBooks()
        books.loadMore(Infinity)
        const counts = new Map()
        for (const [, file] of utils.gliter(books)) {
            const { metadata } = books.readFile(file) ?? {}
            const value = kind === 'authors' ? formatAuthors(metadata) : getSeries(metadata)
            if (!value) continue
            counts.set(value, (counts.get(value) ?? 0) + 1)
        }
        const groups = Array.from(counts, ([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name))

        let child = this._browse_list_box.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._browse_list_box.remove(child)
            child = next
        }
        for (const { name, count } of groups) {
            const box = new Gtk.Box({
                spacing: 12,
                margin_start: 12, margin_end: 12,
                margin_top: 9, margin_bottom: 9,
            })
            box.append(new Gtk.Label({
                label: name, xalign: 0, hexpand: true,
                ellipsize: Pango.EllipsizeMode.END,
            }))
            box.append(utils.addClass(new Gtk.Label({
                label: String(count),
            }), 'dim-label', 'caption'))
            const row = new Gtk.ListBoxRow({ child: box })
            row.browseValue = name
            this._browse_list_box.append(row)
        }

        this._browse_title.label = kind === 'authors' ? _('Authors') : _('Series')
        this._main_stack.visible_child = this._browse_toolbar_view
    }
})
