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

Needs `node` 18 or newer (to serve the app on localhost) and Chrome or Chromium.

1. Put the launcher on your `PATH`:

   ```bash
   ln -s "$PWD/markdown-viewer" ~/.local/bin/markdown-viewer
   ```

   `ln -s TARGET LINK` creates a symbolic link named `LINK` that points at `TARGET`
   ([ln(1)](https://man7.org/linux/man-pages/man1/ln.1.html)). The launcher resolves the link to
   find `server.js` and the `app/` directory, so the repository has to stay where it is.

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

### Keyboard

Only these keys do anything; every other keystroke is suppressed.

| Keys | Effect |
|------|--------|
| `F5`, `Ctrl+R`, `r` | Reload the current file |
| `o` | Open |
| Arrows, `Enter`, `Escape`, `Tab`, `Shift+Tab` | Menus and focus |
| Arrows, `PageUp`, `PageDown`, `Home`, `End`, `Space`, `Shift+Space` | Scrolling |
| `Ctrl+C`, `Ctrl+A` | Copy, select all |
| `Ctrl+F` | Chrome's find bar |
| `Ctrl+P` | Print |
| `Ctrl +`, `Ctrl -`, `Ctrl 0`, `Ctrl`+mouse wheel | Zoom |

Started with `--devtools`, the app also lets through `F12`, `Ctrl+Shift+I`, `Ctrl+Shift+J`,
`Ctrl+Shift+C`, `Ctrl+Shift+R` and `Ctrl+F5`.

### Right-click menu

Chrome's own context menu is replaced by: **Copy** (when text is selected), **Copy Link Address**
(on a link), **Reload** and **Close** (the current file).

### Launcher options

| Option | Meaning |
|--------|---------|
| `--devtools` | Lets the dev-tools keys listed above through, for windows opened from now on. A later launch without it turns that off again. |
| `--headless` | Starts only the server, prints its URL, and exits. A server started this way never stops by itself. |
| `--stop` | Stops the server for this port. |
| `--` | Everything after it is a file name. |
| `-h`, `--help` | Shows usage. |

### Launcher environment variables

| Variable | Meaning |
|----------|---------|
| `MARKDOWN_VIEWER_PORT` | Port on localhost that serves the app. Default `8137`. The port is part of the app's identity, so changing it means installing again. |
| `MARKDOWN_VIEWER_BROWSER` | Chrome/Chromium executable to use. Default: the one that installed the app, otherwise the first of `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser` on `PATH`. |
| `MARKDOWN_VIEWER_INSTALLED` | Set to `1` to skip the launcher's check that the app is installed. |
| `MARKDOWN_VIEWER_IDLE_SECONDS` | How long the server waits with no app window attached before it exits. Default `30`. |

## How it works

- `markdown-viewer` (the bash launcher at the top level) makes sure `node server.js` is serving
  `app/` on the loopback interface, then starts Chrome with `--app-id=<id> FILE…`. Chrome hands the files to the app
  through the File Handling API (`launchQueue`), the same path the *Open With* menu uses. The
  server only ever serves the app's own static files, never your documents.
- Every app window shares one connection to the server. The server exits 30 seconds after the last
  window closes; the launcher starts it again next time. `--headless` servers never exit.
- A service worker caches the app, so an installed app still starts when the server is not running.
- Markdown is converted by marked, the resulting HTML is sanitized by DOMPurify, and only then are
  math, code highlighting and diagrams applied. Scripts in a document do not run.

## Tests

The tests use [Playwright](https://playwright.dev/docs/intro) and live in `tests/`. They are the
only part of the project that needs npm; the app itself has no build step.

```bash
npm install
```

Installs the test runner listed in `package.json` (`@playwright/test`) into `node_modules/`.

```bash
npx playwright install chromium
```

Downloads the Chromium build that this Playwright version drives; `chromium` limits the download
to that one browser.

```bash
npm test
```

Runs `playwright test`: it starts `node server.js --port 8140 --headless` and runs every
`tests/*.spec.js` against it. Set `MARKDOWN_VIEWER_TEST_PORT` to use another port.

| File | Covers |
|------|--------|
| `rendering.spec.js` | Markdown, code highlighting, math, Mermaid, links, colour schemes |
| `sanitizing.spec.js` | Documents cannot run code or restyle the app; the content security policy |
| `file-menu.spec.js`, `tabs.spec.js`, `recent.spec.js` | The File menu, tabs, Recently Viewed |
| `keys.spec.js` | Designed-in keys work; every other keystroke is suppressed; dev-tools mode |
| `context-menu.spec.js` | The right-click menu and nothing beyond it |
| `pwa.spec.js` | Manifest, service worker, offline start, heartbeat |
| `server.spec.js`, `launcher.spec.js` | The node server and the bash launcher as processes |

## What has and has not been tested

Automated (the suite above, Chromium 153 headless on Linux): 730 tests. Headless key presses do not
trigger Chrome's own actions, so for browser shortcuts the suite checks only whether the app
suppresses them.

Checked by hand in an installed app window with real key and mouse events (Chrome for Testing 153,
virtual display): installing; opening one and several files through the launcher; every File menu
item; blocked shortcuts (`F12`, `Ctrl+Shift+I`, `Ctrl+U`, `Ctrl+Shift+R`, `Ctrl+S`, `Ctrl+F5`,
`F1`, `Ctrl+J`, `Ctrl+H`) doing nothing; `F12` opening dev tools after `--devtools`; the
right-click menu; the server exiting 30 seconds after the last window closed.

Not tested, because the test machine had no desktop environment and no `xdg-utils`:

- That Chrome writes `~/.local/share/applications/chrome-<id>-<profile>.desktop` on install. The
  launcher looks for that file to decide whether the app is installed and which browser and
  profile own it. If the launcher keeps saying the app is not installed, set
  `MARKDOWN_VIEWER_INSTALLED=1`.
- The *Open With* entry in Dolphin.
- Chromium installed as a snap. Snap confinement may restrict which files it can read.
- **Recently Viewed** after a browser restart, and Chrome's file picker (the tests stub it).

## Known limitations

- Relative links and relative images in a document are not followed: the app receives a handle to
  one file, not to its directory.
- Images are loaded from `http:`/`https:` URLs if the document references them, including
  through a `style` attribute in raw HTML.
- The file is not watched; use **File → Reload** after editing.
- *Reload* in Chrome's own ⋮ menu cannot be intercepted; it reloads the page and forgets the open
  files, which stay in **Recently Viewed**. The same goes for shortcuts the browser never shows to
  a page, such as `Ctrl+W`.
- If an older version's `python3 -m http.server` is still running on the port, the launcher refuses
  to use it; stop that process once.
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
