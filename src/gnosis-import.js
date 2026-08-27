// One-time migration of a gnosis (https://github.com/mavenried/gnosis) library
// into this Foliate library: reads gnosis's SQLite database directly (there's
// no shared live database between the two apps) and re-imports each book
// through Foliate's own import pipeline, so identifiers/metadata/covers are
// derived exactly the way a normal import would produce them. Reading
// progress and the last-location CFI are then copied over, since both apps
// render through the same vendored foliate-js and use compatible CFIs.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as utils from './utils.js'
import { getURIStore, getBookList } from './library.js'
import { importFiles } from './book-viewer.js'

const GNOSIS_PROGRESS_TOTAL = 1000

export const findGnosisDatabase = () => {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnosis', 'library.db'])
    return Gio.File.new_for_path(path).query_exists(null) ? path : null
}

const runSqliteJSON = (dbPath, sql) => new Promise((resolve, reject) => {
    try {
        if (!GLib.find_program_in_path('sqlite3'))
            throw new Error('sqlite3 is not installed')
        const proc = Gio.Subprocess.new(['sqlite3', '-json', dbPath, sql],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
        proc.communicate_utf8_async(null, null, (proc, res) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res)
                if (!proc.get_successful())
                    throw new Error(stderr?.trim() || 'sqlite3 exited with an error')
                resolve(stdout.trim() ? JSON.parse(stdout) : [])
            } catch (e) {
                reject(e)
            }
        })
    } catch (e) {
        reject(e)
    }
})

// runs the migration; returns a summary for the caller to report to the user
export const importFromGnosis = async dbPath => {
    const rows = await runSqliteJSON(dbPath,
        'SELECT path, added_at, progress, locator, last_opened_at FROM books')

    const uriStore = getURIStore()
    const toImport = []
    let missing = 0, alreadyPresent = 0

    for (const row of rows) {
        const file = Gio.File.new_for_path(row.path)
        if (!file.query_exists(null)) {
            missing++
            continue
        }
        if (uriStore.findIdentifierByPath(row.path)) {
            alreadyPresent++
            continue
        }
        toImport.push({ file, row })
    }

    let imported = 0, failed = 0
    if (toImport.length) {
        const results = await importFiles(toImport.map(x => x.file))
        results.forEach(([, result], i) => {
            const { row } = toImport[i]
            if (result instanceof Error) {
                failed++
                return
            }
            const identifier = uriStore.findIdentifierByPath(row.path)
            if (!identifier) {
                failed++
                return
            }
            const storage = new utils.JSONStorage(pkg.datadir, identifier)
            const fraction = Math.max(0, Math.min(1, row.progress || 0))
            storage.set('progress',
                [Math.round(fraction * GNOSIS_PROGRESS_TOTAL), GNOSIS_PROGRESS_TOTAL], false)
            if (row.locator) storage.set('lastLocation', row.locator, false)
            if (row.added_at) storage.set('added', row.added_at * 1000, false)
            storage.saveNow()

            // backdate the file so "recently added"/"recently read" sort
            // order reflects gnosis's timestamps instead of "just now"
            const mtime = row.last_opened_at || row.added_at
            if (mtime) try {
                Gio.File.new_for_path(storage.path).set_attribute_uint64(
                    'time::modified', mtime, Gio.FileQueryInfoFlags.NONE, null)
            } catch (e) {
                console.warn(e)
            }
            getBookList()?.update(storage.path)
            imported++
        })
    }
    return { imported, failed, missing, alreadyPresent, total: rows.length }
}
