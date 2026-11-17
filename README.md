# markdown-viewer

A Progressive Web App that views Markdown files, for Chrome/Chromium on Linux.
Requirements are tracked in [issue 1](https://github.com/pflagerd/markdown-viewer/issues/1).

- GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks)
- Syntax-highlighted code blocks
- Mermaid diagrams (` ```mermaid ` fenced blocks)
- Math with KaTeX (`$…$`, `$$…$$`, ` ```math ` fenced blocks)
- Light and dark appearance, following the desktop colour scheme
- No build step; every library is vendored under `app/vendor/`

## Install

Needs `python3` (to serve the app on localhost) and Chrome or Chromium.

1. Put the launcher on your `PATH`:

   ```bash
   ln -s "$PWD/markdown-viewer" ~/.local/bin/markdown-viewer
   ```

   `ln -s TARGET LINK` creates a symbolic link named `LINK` that points at `TARGET`
   ([ln(1)](https://man7.org/linux/man-pages/man1/ln.1.html)). The launcher resolves the link to
   find the `app/` directory, so the repository has to stay where it is.

2. Run it once with no arguments:

   ```bash
   markdown-viewer
   ```

   This starts a static file server on `127.0.0.1:8137` and opens the app in a browser window.

3. Click **Install** in the app's toolbar and confirm Chrome's prompt.

## Use

```bash
markdown-viewer notes.md
```

```bash
markdown-viewer a.md b.md c.md
```

Each run of the launcher opens one app window. Several file names open as tabs in that window, one
per file, with the first one showing; a single file shows no tab bar. The first time, Chrome asks
whether the app may open the files; tick *Remember my choice* to stop it asking.

Installing the app also registers it as a handler for `.md`, `.markdown`, `.mdown` and `.mkd`
files, so it should appear in the file manager's *Open With* menu.

### File menu

| Item | What it does |
|------|--------------|
| **Open…** (`o`) | File picker; each chosen file opens in a new tab. |
| **Recently Viewed** | The last 10 files viewed, newest first; choosing one opens it. **Clear** at the bottom empties the list. |
| **Reload** (`F5`, `Ctrl+R`, `r`) | Reads the current file from disk again, keeping the scroll position. |
| **Close** | Closes the current file. Tabs also have their own × and close on middle-click. |
| **Close All** | Closes every file in the window. |
| **Exit** | Closes the window. |

### Launcher environment variables

| Variable | Meaning |
|----------|---------|
| `MARKDOWN_VIEWER_PORT` | Port on localhost that serves the app. Default `8137`. The port is part of the app's identity, so changing it means installing again. |
| `MARKDOWN_VIEWER_BROWSER` | Chrome/Chromium executable to use. Default: the one that installed the app, otherwise the first of `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser` on `PATH`. |
| `MARKDOWN_VIEWER_INSTALLED` | Set to `1` to skip the launcher's check that the app is installed. |

## How it works

- `markdown-viewer` (the launcher script at the top level) makes sure `python3 -m http.server` is serving `app/` on the loopback
  interface, then starts Chrome with `--app-id=<id> FILE…`. Chrome hands the files to the app
  through the File Handling API (`launchQueue`), the same path the *Open With* menu uses. The
  server only ever serves the app's own static files, never your documents.
- A service worker caches the app, so an installed app still starts when the server is not running.
- Markdown is converted by marked, the resulting HTML is sanitized by DOMPurify, and only then are
  math, code highlighting and diagrams applied. Scripts in a document do not run.

## What has and has not been tested

Tested with Chrome for Testing 153 on Linux: rendering of every feature above in light and dark
mode, that Chrome offers the app for installation, installing it, opening files through the
launcher (one file, three files as tabs, and a path with spaces), every File menu item in the
installed app, and starting the installed app with the server stopped.

Not tested, because the test machine had no desktop environment and no `xdg-utils`:

- That Chrome writes `~/.local/share/applications/chrome-<id>-<profile>.desktop` on install. The
  launcher looks for that file to decide whether the app is installed and which browser and
  profile own it. If the launcher keeps saying the app is not installed, set
  `MARKDOWN_VIEWER_INSTALLED=1`.
- The *Open With* entry in Dolphin.
- Chromium installed as a snap. Snap confinement may restrict which files it can read.

## Known limitations

- Relative links and relative images in a document are not followed: the app receives a handle to
  one file, not to its directory.
- Images are loaded from `http:`/`https:` URLs if the document references them.
- The file is not watched; use **File → Reload** after editing.
- `F5` and `Ctrl+R` are captured and re-read the current file. Reloading the page itself
  (`Ctrl+Shift+R`, `Ctrl+F5`, or *Reload* in Chrome's own ⋮ menu) cannot be intercepted and
  forgets the open files; they stay in **Recently Viewed**.
- **Recently Viewed** shows file names only, because the browser does not tell the app a file's
  directory. After Chrome restarts it may ask again for permission when a recent file is chosen.

## Vendored libraries

| Library | Version | Licence |
|---------|---------|---------|
| [marked](https://github.com/markedjs/marked) | 18.2.0 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | MPL-2.0 OR Apache-2.0 |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.19.1 | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) | 12.3.0 | MIT |

Each library's licence file is next to it in `app/vendor/`.
