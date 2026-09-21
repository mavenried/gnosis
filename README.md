<h1 align="center">Gnosis</h1>
<p align="center">
Gnosis is a simple EPUB library and reader for Linux. It helps you keep your
books organized while providing a comfortable reading experience.
</p>

## Features

- Open and read EPUB books.
- Organize books by author and series.
- Add one or more folders to your library and let Gnosis find the books
  inside them.
- Search your library by title, author, or other book information.
- Sort books by title, author, series, recently added, or recently read.
- Filter books by reading status:
  - **Unread**
  - **Reading**
  - **Read**
- Select several books at once to mark them read, mark them unread, or remove
  them from the library.
- Track reading progress and return to the place where you stopped.
- Add bookmarks and annotations.
- Look up words in a dictionary or Wikipedia.
- Use text-to-speech.
- Choose reading themes, fonts, and layout options.
- Use a pure black theme for OLED displays.

## Getting started

On the first launch, you can:

1. Choose **Open…** to add an EPUB file.
2. Add a **Library Folder** in **Settings** to import books from a folder.
3. Choose **Import from Legacy Gnosis…** if you are moving from the older
   Gnosis application.

When a library folder is configured, Gnosis can find new books automatically.
You can also refresh the library at any time with <kbd>Ctrl</kbd>+<kbd>R</kbd>.

## Library controls

- Use the library menu to change sorting and open the status filter.
- The status filter is a checklist, so you can show more than one status at
  the same time. With no statuses selected, all books are shown.
- Press <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> to search your library.
- Hold <kbd>Ctrl</kbd> while clicking to select individual books.
- Hold <kbd>Shift</kbd> while clicking to select a range of books.
- Press <kbd>Escape</kbd> to clear the selection.
- Right-click a book, or use its <kbd>…</kbd> menu, for book actions.

## Installing

Prebuilt releases are available on the
[Releases page](https://github.com/mavenried/gnosis/releases). Download the
package for your system and follow the instructions included with that
release.

Gnosis can also be installed from source. This is intended for developers and
people who want to run the latest unreleased version:

```sh
git clone --recurse-submodules https://github.com/mavenried/gnosis.git
cd gnosis
./build.sh install
```

The installed application can then be started with:

```sh
gnosis
```

## Support

Gnosis is based on [Foliate](https://github.com/johnfactotum/foliate).
Foliate's documentation covers many of the reading features, including
annotations, text-to-speech, dictionaries, and reading preferences.

Please report bugs and request features in the
[GitHub issue tracker](https://github.com/mavenried/gnosis/issues).

## License

Gnosis is licensed under the GPL-3.0-or-later license. See [COPYING](COPYING).
