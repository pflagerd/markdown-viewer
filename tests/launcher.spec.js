// The `markdown-viewer` launcher as a process.
//
// The browser is a stub script (MARKDOWN_VIEWER_BROWSER) that records its
// arguments; HOME, XDG_DATA_HOME and XDG_RUNTIME_DIR are private temp dirs and
// each worker has its own port (8160-8199), see proc-helpers.js. Tests tagged
// @negative check that something that must not happen does not happen.

const { test, expect } = require('./helpers');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  ROOT, LAUNCHER, APP_DIR,
  delay, waitFor, listening, alive, cmdline, sandbox, cleanEnv, startServer, raw, openStream, appId,
} = require('./proc-helpers');

const NEG = { tag: '@negative' };
const END = '__END_OF_CALL__';

let box;
test.beforeEach(() => {
  box = sandbox();
  box.calls = path.join(box.dir, 'browser-calls');
  box.stub = writeStub('browser');
  box.work = path.join(box.dir, 'work');
  fs.mkdirSync(box.work);
});
test.afterEach(async () => { await box.cleanup(); });

/** A fake browser: appends each argument on its own line, then END. */
function writeStub(name, callsFile = box.calls) {
  const file = path.join(box.dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '%s\\n' '${END}'; } >>'${callsFile}'\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function launcherEnv(extra = {}) {
  const env = cleanEnv({
    HOME: box.home,
    XDG_DATA_HOME: box.data,
    XDG_RUNTIME_DIR: box.run,
    MARKDOWN_VIEWER_PORT: String(box.port),
    MARKDOWN_VIEWER_BROWSER: box.stub,
    ...extra,
  });
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

/** Runs the launcher to completion: { code, signal, stdout, stderr }. */
function launch(args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.launcher || LAUNCHER, args, {
      cwd: options.cwd || box.work,
      env: launcherEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    box.children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const INSTALLED = { MARKDOWN_VIEWER_INSTALLED: '1' };

/** Argument lists of the stub browser's calls so far, once there are `count`. */
async function browserCalls(count = 1, file = box.calls) {
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  await waitFor(() => read().split(`${END}\n`).length - 1 >= count, `${count} browser call(s)`);
  const calls = read().split(`${END}\n`);
  expect(calls.pop()).toBe('');
  return calls.map((text) => text.split('\n').slice(0, -1));
}

const browserCalled = (file = box.calls) => fs.existsSync(file);

/** Pid in the pid file, once the server has written it. */
async function serverPid() {
  await waitFor(() => fs.existsSync(box.pidFile) && fs.readFileSync(box.pidFile, 'utf8').trim(), 'the pid file');
  return Number(fs.readFileSync(box.pidFile, 'utf8').trim());
}

/**
 * --stop, then wait until the old server has really released the port. Tests
 * that are not about replacing/stopping use this between launches, because
 * the launcher itself does not wait for that (see "replaces our running
 * server").
 */
async function stopAndWait() {
  const pid = fs.existsSync(box.pidFile) ? Number(fs.readFileSync(box.pidFile, 'utf8')) : 0;
  const result = await launch(['--stop']);
  await waitFor(async () => !(pid && alive(pid)) && !(await listening(box.port)), 'the port to be released');
  return result;
}

const serverGone = (pid) => waitFor(async () => !alive(pid) && !(await listening(box.port)), `server ${pid} to exit`);

function file(name, dir = box.work) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `# ${name}\n`);
  return full;
}

function desktopEntry(dir, id, exec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `chrome-${id}-Default.desktop`), [
    '#!/usr/bin/env xdg-open', '[Desktop Entry]', 'Version=1.0', 'Terminal=false', 'Type=Application',
    'Name=Markdown Viewer', `Exec=${exec}`, `Icon=chrome-${id}-Default`, `StartupWMClass=crx_${id}`, '',
  ].join('\n'));
}

const expectedId = () => appId(`http://localhost:${box.port}/`);

/* ---------- app id ---------- */

test.describe('app id', () => {
  test('the reference implementation in this test gives the known id for port 8137', () => {
    expect(appId('http://localhost:8137/')).toBe('fccdijiiknbadgcigbgjmjdmpcdnkkld');
  });

  test('the launcher passes --app-id for its own port', async () => {
    const id = expectedId();
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).not.toBe('fccdijiiknbadgcigbgjmjdmpcdnkkld');
    const result = await launch([], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${id}`]]);
  });
});

/* ---------- argument handling ---------- */

test.describe('usage', () => {
  for (const flag of ['-h', '--help']) {
    test(`${flag} prints the usage and starts nothing`, async () => {
      const result = await launch([flag]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toMatch(/^Usage: markdown-viewer \[--devtools\] \[--\] \[FILE\.\.\.\]/);
      for (const word of ['--headless', '--devtools', '--stop', '--help', 'MARKDOWN_VIEWER_PORT', 'MARKDOWN_VIEWER_BROWSER']) {
        expect(result.stdout).toContain(word);
      }
      expect(result.stdout).not.toMatch(/^#|set -euo/m);
      expect(await listening(box.port)).toBe(false);
      expect(browserCalled()).toBe(false);
      expect(fs.readdirSync(box.run)).toEqual([]);
    });
  }

  test('--help wins even after files', async () => {
    const result = await launch([file('a.md'), '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage:/);
    expect(browserCalled()).toBe(false);
  });

  for (const args of [['--bogus'], ['-x'], ['--port', '1'], ['--devtool'], ['--headles'], ['a.md', '--frobnicate'],
    ['--stop', '--bogus'], ['---']]) {
    test(`unknown option in "${args.join(' ')}": exit 2, nothing started`, NEG, async () => {
      file('a.md');
      const result = await launch(args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^markdown-viewer: unknown option: /);
      expect(await listening(box.port)).toBe(false);
      expect(browserCalled()).toBe(false);
      expect(fs.readdirSync(box.run)).toEqual([]);
    });
  }

  for (const [name, args] of [
    ['a missing file', ['missing.md']],
    ['a missing file among existing ones', ['a.md', 'missing.md', 'b.md']],
    ['a directory', ['subdir']],
    ['an empty file name', ['']],
    ['a missing file after --', ['--', '--devtools']],
  ]) {
    test(`${name}: exit 1, no server, no browser`, NEG, async () => {
      file('a.md');
      file('b.md');
      fs.mkdirSync(path.join(box.work, 'subdir'));
      const result = await launch(args, { env: INSTALLED });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^markdown-viewer: no such file: /);
      expect(await listening(box.port)).toBe(false);
      expect(browserCalled()).toBe(false);
      expect(fs.readdirSync(box.run)).toEqual([]);
    });
  }

  test('a missing file does not disturb a running server or the devtools flag', NEG, async () => {
    await launch(['--devtools'], { env: INSTALLED });
    const pid = await serverPid();
    await browserCalls(1);
    const result = await launch(['missing.md'], { env: INSTALLED });
    expect(result.code).toBe(1);
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(box.devtoolsFile)).toBe(true);
    expect((await browserCalls(1)).length).toBe(1);
  });

  for (const args of [['--headless', 'a.md'], ['a.md', '--headless'], ['--headless', '--devtools', 'a.md'],
    ['--headless', '--', 'a.md']]) {
    test(`"${args.join(' ')}": --headless with files is exit 2, nothing started`, NEG, async () => {
      file('a.md');
      const result = await launch(args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^markdown-viewer: .*--headless/);
      expect(await listening(box.port)).toBe(false);
      expect(browserCalled()).toBe(false);
      expect(fs.readdirSync(box.run)).toEqual([]);
    });
  }

  test('a non-numeric MARKDOWN_VIEWER_PORT is refused', NEG, async () => {
    const result = await launch([], { env: { ...INSTALLED, MARKDOWN_VIEWER_PORT: `${box.port};id` } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/MARKDOWN_VIEWER_PORT/);
    expect(await listening(box.port)).toBe(false);
    expect(browserCalled()).toBe(false);
  });
});

/* ---------- opening files in the installed app ---------- */

test.describe('installed app', () => {
  test('without files: only --app-id', async () => {
    const result = await launch([], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`]]);
  });

  test('passes one file as an absolute path', async () => {
    const a = file('a.md');
    const result = await launch([a], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
  });

  test('makes relative paths absolute against the working directory', async () => {
    const a = file('a.md');
    const nested = file('docs/deep/b.md');
    const sibling = file('c.md', path.join(box.dir, 'elsewhere'));
    await launch(['a.md', './docs/deep/b.md', 'docs/../docs/deep/b.md', '../elsewhere/c.md'], { env: INSTALLED });
    const [args] = await browserCalls();
    expect(args).toEqual([`--app-id=${expectedId()}`, a, nested, nested, sibling]);
    for (const arg of args.slice(1)) expect(path.isAbsolute(arg)).toBe(true);
  });

  test('keeps several files in the order given', async () => {
    const names = ['z.md', 'a.md', 'm.md', 'b.markdown', 'notes.txt'];
    const paths = names.map((n) => file(n));
    await launch(names, { env: INSTALLED });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, ...paths]]);
  });

  test('keeps paths with spaces and shell characters as single arguments', async () => {
    const names = ['my notes.md', 'dir with space/read me.md', ' leading.md', 'trailing .md', 'a  b   c.md',
      'quote\'s.md', 'dq".md', '$HOME.md', 'star*.md', 'semi;colon.md', 'tab\there.md', 'ünï©ødé.md',
      '`id`.md', '$(id).md', 'back\\slash.md', '&amp.md', '#hash.md', '~tilde.md', '[b]racket?.md'];
    const paths = names.map((n) => file(n));
    const result = await launch(paths.map((p) => path.relative(box.work, p)).map((p) => `./${p}`), { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, ...paths]]);
  });

  test('does not expand globs or run substitutions found in file names', NEG, async () => {
    file('one.md');
    file('two.md');
    const star = file('*.md');
    const subst = file('$(touch pwned).md');
    await launch(['*.md', '$(touch pwned).md'], { env: INSTALLED });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, star, subst]]);
    expect(fs.existsSync(path.join(box.work, 'pwned'))).toBe(false);
  });

  test('-- makes option-like names files', async () => {
    const names = ['--devtools', '--stop', '-h', '--headless', '--', '-'];
    const paths = names.map((n) => file(n));
    const result = await launch(['--', ...names], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, ...paths]]);
    // None of them was taken as the option.
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
    expect(alive(await serverPid())).toBe(true);
  });

  test('options are recognised after files too', async () => {
    const a = file('a.md');
    await launch(['a.md', '--devtools'], { env: INSTALLED });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
    expect(fs.existsSync(box.devtoolsFile)).toBe(true);
  });

  test('passes no --app=, URL or profile argument', NEG, async () => {
    file('a.md');
    await launch(['a.md'], { env: INSTALLED });
    const [args] = await browserCalls();
    expect(args.filter((a) => /^--app=|^https?:|^--profile-directory/.test(a))).toEqual([]);
    expect(args.filter((a) => a.startsWith('--'))).toEqual([`--app-id=${expectedId()}`]);
  });

  test('works when started through a symlink from another directory', async () => {
    const bin = path.join(box.dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(LAUNCHER, path.join(bin, 'mdview'));
    // A second hop, relative, to make sure the link is resolved fully.
    fs.symlinkSync('mdview', path.join(bin, 'mdv'));
    const a = file('a.md');
    const result = await launch(['a.md'], { launcher: path.join(bin, 'mdv'), env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
    // The server it started is the real one, serving the real app.
    const pid = await serverPid();
    expect(cmdline(pid)).toContain(path.join(ROOT, 'server.js'));
    const res = await raw(box.port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(fs.readFileSync(path.join(APP_DIR, 'index.html'), 'latin1'));
  });

  test('works when found through PATH', async () => {
    const bin = path.join(box.dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(LAUNCHER, path.join(bin, 'markdown-viewer'));
    const a = file('a.md');
    const result = await launch(['a.md'], {
      launcher: 'markdown-viewer', env: { ...INSTALLED, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
  });

  test('does not need python3', async () => {
    // A PATH with exactly the tools the launcher uses, and no python.
    const bin = path.join(box.dir, 'tools');
    fs.mkdirSync(bin);
    const tools = ['bash', 'readlink', 'dirname', 'sed', 'tr', 'seq', 'sleep', 'setsid', 'grep', 'cut', 'rm', 'timeout'];
    for (const tool of tools) {
      const real = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(real, path.join(bin, tool));
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const env = { ...INSTALLED, PATH: bin };
    expect(() => execFileSync('/bin/sh', ['-c', 'command -v python3 || command -v python'], { env: launcherEnv(env) })).toThrow();

    const a = file('a.md');
    const result = await launch(['--devtools', 'a.md'], { env });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
    const pid = await serverPid();
    expect(cmdline(pid).some((arg) => /python/.test(arg))).toBe(false);
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: true });

    const stop = await launch(['--stop'], { env });
    expect(stop).toMatchObject({ code: 0, stderr: '' });
    await serverGone(pid);
    const headless = await launch(['--headless'], { env });
    expect(headless).toMatchObject({ code: 0, stdout: `${box.origin}/\n`, stderr: '' });
  });
});

/* ---------- install detection ---------- */

test.describe('install detection', () => {
  test('not installed: opens the app URL with --app= and prints a hint', async () => {
    const result = await launch([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^markdown-viewer: the app is not installed yet\./);
    expect(result.stderr).toMatch(/Install/);
    expect(await browserCalls()).toEqual([[`--app=${box.origin}/`]]);
    // The URL it opens is being served.
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('not installed: files are not passed, and no --app-id', NEG, async () => {
    file('a.md');
    const result = await launch(['a.md']);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/not installed yet/);
    expect(await browserCalls()).toEqual([[`--app=${box.origin}/`]]);
  });

  test('detects the desktop entry in $XDG_DATA_HOME/applications and passes its profile on', async () => {
    const id = expectedId();
    desktopEntry(path.join(box.data, 'applications'), id,
      `${box.stub} --profile-directory="Profile 1" --app-id=${id} %U`);
    const a = file('a.md');
    const result = await launch(['a.md']);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([['--profile-directory=Profile 1', `--app-id=${id}`, a]]);
  });

  test('detects the desktop entry in ~/.local/share/applications when XDG_DATA_HOME is unset', async () => {
    const id = expectedId();
    desktopEntry(path.join(box.home, '.local/share/applications'), id,
      `${box.stub} --profile-directory=Default --app-id=${id} %U`);
    const a = file('a.md');
    const result = await launch(['a.md'], { env: { XDG_DATA_HOME: undefined } });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls()).toEqual([['--profile-directory=Default', `--app-id=${id}`, a]]);
  });

  test('an entry without a profile adds no --profile-directory', NEG, async () => {
    const id = expectedId();
    desktopEntry(path.join(box.data, 'applications'), id, `${box.stub} --app-id=${id} %U`);
    await launch([]);
    expect(await browserCalls()).toEqual([[`--app-id=${id}`]]);
  });

  test('uses the browser named in the desktop entry when MARKDOWN_VIEWER_BROWSER is unset', async () => {
    const id = expectedId();
    const otherCalls = path.join(box.dir, 'other-calls');
    const other = writeStub('other-browser', otherCalls);
    desktopEntry(path.join(box.data, 'applications'), id, `${other} --profile-directory="Profile 2" --app-id=${id} %U`);
    const a = file('a.md');
    const result = await launch(['a.md'], { env: { MARKDOWN_VIEWER_BROWSER: undefined } });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await browserCalls(1, otherCalls)).toEqual([['--profile-directory=Profile 2', `--app-id=${id}`, a]]);
    expect(browserCalled()).toBe(false);
  });

  test('MARKDOWN_VIEWER_BROWSER wins over the browser in the desktop entry', async () => {
    const id = expectedId();
    const otherCalls = path.join(box.dir, 'other-calls');
    const other = writeStub('other-browser', otherCalls);
    desktopEntry(path.join(box.data, 'applications'), id, `${other} --profile-directory=Work --app-id=${id} %U`);
    await launch([]);
    expect(await browserCalls()).toEqual([['--profile-directory=Work', `--app-id=${id}`]]);
    expect(browserCalled(otherCalls)).toBe(false);
  });

  test('ignores desktop entries of other apps, other ports and other directories', NEG, async () => {
    const id = expectedId();
    const apps = path.join(box.data, 'applications');
    // The same app on the default port, an unrelated PWA, a near miss, and
    // the right entry in a directory that is not searched.
    desktopEntry(apps, appId('http://localhost:8137/'), `${box.stub} --profile-directory=A --app-id=x %U`);
    desktopEntry(apps, 'abcdefghijklmnopabcdefghijklmnop', `${box.stub} --profile-directory=B --app-id=x %U`);
    fs.writeFileSync(path.join(apps, `${id}.desktop`), `Exec=${box.stub} --profile-directory=C\n`);
    fs.writeFileSync(path.join(apps, `chrome-${id}.desktop`), `Exec=${box.stub} --profile-directory=D\n`);
    desktopEntry(path.join(box.home, '.local/share/applications'), id, `${box.stub} --profile-directory=E --app-id=${id} %U`);
    desktopEntry(path.join(box.data, 'other'), id, `${box.stub} --profile-directory=F --app-id=${id} %U`);
    file('a.md');
    const result = await launch(['a.md']);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/not installed yet/);
    expect(await browserCalls()).toEqual([[`--app=${box.origin}/`]]);
  });

  test('MARKDOWN_VIEWER_INSTALLED=1 skips detection; other values do not', async () => {
    await launch([], { env: { MARKDOWN_VIEWER_INSTALLED: '0' } });
    await browserCalls(1);
    await launch([], { env: { MARKDOWN_VIEWER_INSTALLED: '' } });
    await browserCalls(2);
    const installed = await launch([], { env: INSTALLED });
    expect(installed.stderr).toBe('');
    expect(await browserCalls(3)).toEqual([[`--app=${box.origin}/`], [`--app=${box.origin}/`], [`--app-id=${expectedId()}`]]);
  });

  test('no browser at all: fails with a message naming MARKDOWN_VIEWER_BROWSER', NEG, async () => {
    const bin = path.join(box.dir, 'tools');
    fs.mkdirSync(bin);
    for (const tool of ['bash', 'readlink', 'dirname', 'sed', 'tr', 'seq', 'sleep', 'setsid', 'grep', 'cut', 'rm', 'timeout']) {
      fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const result = await launch([], { env: { ...INSTALLED, PATH: bin, MARKDOWN_VIEWER_BROWSER: undefined } });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/MARKDOWN_VIEWER_BROWSER/);
    expect(browserCalled()).toBe(false);
  });
});

/* ---------- the server behind the launcher ---------- */

test.describe('server', () => {
  test('starts node server.js --port P, detached, and it outlives the launcher', async () => {
    expect(await listening(box.port)).toBe(false);
    const result = await launch([], { env: INSTALLED });
    expect(result.code).toBe(0);
    // Already listening when the launcher returns, without waiting.
    expect(await listening(box.port)).toBe(true);
    const pid = await serverPid();
    const args = cmdline(pid);
    expect(path.basename(args[0])).toBe('node');
    expect(args.slice(1)).toEqual([path.join(ROOT, 'server.js'), '--port', String(box.port)]);
    expect(alive(pid)).toBe(true);
    // Its own session: not tied to the launcher's terminal or process group.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    expect(Number(fields[3])).toBe(pid);   // session id
    expect((await raw(box.port, '/api/config')).status).toBe(200);
  });

  test('the server left behind exits by itself when no window attaches', async () => {
    const result = await launch([], { env: { ...INSTALLED, MARKDOWN_VIEWER_IDLE_SECONDS: '2' } });
    expect(result.code).toBe(0);
    const pid = await serverPid();
    expect(alive(pid)).toBe(true);
    await waitFor(async () => !alive(pid) && !(await listening(box.port)), 'the idle server to exit', 12_000);
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  test('the server left behind stays while a window holds its event stream', async () => {
    await launch([], { env: { ...INSTALLED, MARKDOWN_VIEWER_IDLE_SECONDS: '1' } });
    const pid = await serverPid();
    const stream = await openStream(box.port);
    await delay(2500);                     // 2.5 idle periods
    expect(alive(pid)).toBe(true);
    await stream.close();
    await waitFor(async () => !alive(pid) && !(await listening(box.port)), 'the idle server to exit', 12_000);
  });

  test('reuses our server when it is already running: same pid, no second server', async () => {
    const a = file('a.md');
    const b = file('b.md');
    await launch(['a.md'], { env: INSTALLED });
    const pid = await serverPid();
    for (let i = 0; i < 3; i++) {
      const again = await launch(['b.md'], { env: INSTALLED });
      expect(again).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(await serverPid()).toBe(pid);
    expect(alive(pid)).toBe(true);
    expect(fs.readdirSync(box.run)).toEqual([`markdown-viewer-${box.port}.pid`]);
    const id = `--app-id=${expectedId()}`;
    expect(await browserCalls(4)).toEqual([[id, a], [id, b], [id, b], [id, b]]);
  });

  test('reuses a server of ours that was started by hand, without a pid file', async () => {
    const server = await startServer(box);
    fs.unlinkSync(box.pidFile);
    const a = file('a.md');
    const result = await launch(['a.md'], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(server.running()).toBe(true);
    expect(fs.existsSync(box.pidFile)).toBe(false);
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
  });

  for (const [name, handler] of [
    ['an HTTP server that answers 404 to everything', (req, res) => { res.writeHead(404); res.end('nope\n'); }],
    ['an HTTP server that answers 200 with a page to everything', (req, res) => { res.end('<html>devtools are great</html>'); }],
    ['an HTTP server with an /api/config of its own', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"version":3}'); }],
  ]) {
    test(`port held by ${name}: exit 1, browser not started`, NEG, async () => {
      const foreign = http.createServer(handler);
      await new Promise((resolve) => foreign.listen(box.port, '127.0.0.1', resolve));
      let requests = 0;
      foreign.on('request', () => { requests++; });
      try {
        file('a.md');
        const result = await launch(['a.md'], { env: INSTALLED });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(
          `markdown-viewer: port ${box.port} is in use by another program; stop it or set MARKDOWN_VIEWER_PORT\n`);
        expect(browserCalled()).toBe(false);
        // No server of ours was started beside it, and the foreign one lives.
        expect(fs.existsSync(box.pidFile)).toBe(false);
        expect(foreign.listening).toBe(true);
        expect(requests).toBeGreaterThan(0);
      } finally {
        foreign.closeAllConnections();
        await new Promise((resolve) => foreign.close(resolve));
      }
    });
  }

  test('port held by a listener that is not HTTP: exit 1, browser not started', NEG, async () => {
    const sockets = new Set();
    const foreign = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.resume();
      socket.end('220 hello\r\n');
    });
    await new Promise((resolve) => foreign.listen(box.port, '127.0.0.1', resolve));
    try {
      const result = await launch([], { env: INSTALLED });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`^markdown-viewer: port ${box.port} is in use by another program`));
      expect(browserCalled()).toBe(false);
      expect(fs.existsSync(box.pidFile)).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });

  test('port held by a foreign program: not installed makes no difference', NEG, async () => {
    const foreign = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((resolve) => foreign.listen(box.port, '127.0.0.1', resolve));
    try {
      const result = await launch([]);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(/not installed/);
      expect(browserCalled()).toBe(false);
    } finally {
      foreign.closeAllConnections();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });
});

/* ---------- --devtools ---------- */

test.describe('--devtools', () => {
  test('creates the state file, and the server reports it', async () => {
    const result = await launch(['--devtools'], { env: INSTALLED });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(fs.existsSync(box.devtoolsFile)).toBe(true);
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: true });
    // It is not passed to the browser.
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`]]);
  });

  test('a launch without it removes the state file again', async () => {
    await launch(['--devtools'], { env: INSTALLED });
    expect(fs.existsSync(box.devtoolsFile)).toBe(true);
    const pid = await serverPid();
    await launch([file('a.md')], { env: INSTALLED });
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: false });
    // Same server throughout; only the flag changed.
    expect(await serverPid()).toBe(pid);
  });

  test('a launch without it creates no state file', NEG, async () => {
    await launch([], { env: INSTALLED });
    await serverPid();
    expect(fs.readdirSync(box.run)).toEqual([`markdown-viewer-${box.port}.pid`]);
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: false });
  });

  test('applies when the app is not installed yet, too', async () => {
    await launch(['--devtools']);
    expect(fs.existsSync(box.devtoolsFile)).toBe(true);
    expect(await browserCalls()).toEqual([[`--app=${box.origin}/`]]);
  });

  test('touches only the state file of its own port', NEG, async () => {
    const other = path.join(box.run, 'markdown-viewer-8137.devtools');
    fs.writeFileSync(other, '');
    await launch(['--devtools'], { env: INSTALLED });
    await launch([], { env: INSTALLED });
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });
});

/* ---------- --headless ---------- */

test.describe('--headless', () => {
  test('starts only the server and prints its URL', async () => {
    const result = await launch(['--headless']);
    expect(result).toMatchObject({ code: 0, stdout: `${box.origin}/\n`, stderr: '' });
    const pid = await serverPid();
    expect(cmdline(pid).slice(1)).toEqual([path.join(ROOT, 'server.js'), '--port', String(box.port), '--headless']);
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('starts no browser, installed or not', NEG, async () => {
    expect((await launch(['--headless'])).code).toBe(0);
    await stopAndWait();
    expect((await launch(['--headless'], { env: INSTALLED })).code).toBe(0);
    await stopAndWait();
    desktopEntry(path.join(box.data, 'applications'), expectedId(), `${box.stub} --app-id=${expectedId()} %U`);
    expect((await launch(['--headless'])).code).toBe(0);
    await serverPid();
    expect(browserCalled()).toBe(false);
  });

  test('its server does not exit when idle', NEG, async () => {
    await launch(['--headless'], { env: { MARKDOWN_VIEWER_IDLE_SECONDS: '1' } });
    const pid = await serverPid();
    await delay(3000);                     // three idle periods
    expect(alive(pid)).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('replaces our running server', async () => {
    // Regression: the old server removes its pid file a moment before it
    // releases the port, and the launcher used to see the port as taken by
    // another program. It was a race, hence several rounds.
    for (let round = 1; round <= 8; round++) {
      await launch([], { env: INSTALLED });
      const first = await serverPid();
      expect(cmdline(first)).not.toContain('--headless');
      const result = await launch(['--headless']);
      expect(result, `round ${round}`).toMatchObject({ code: 0, stdout: `${box.origin}/\n`, stderr: '' });
      const second = await serverPid();
      expect(second).not.toBe(first);
      expect(alive(first)).toBe(false);
      expect(cmdline(second)).toContain('--headless');
      expect((await raw(box.port, '/')).status).toBe(200);
      await stopAndWait();
    }
  });

  test('a failed or successful replace never leaves two servers or kills a bystander', NEG, async () => {
    // Whatever the outcome of the race above: the old server is gone, and at
    // most one server of ours exists afterwards.
    await launch([], { env: INSTALLED });
    const first = await serverPid();
    const result = await launch(['--headless']);
    await waitFor(() => !alive(first), 'the replaced server to exit');
    if (result.code === 0) {
      const second = await serverPid();
      expect(second).not.toBe(first);
      expect(cmdline(second)).toContain('--headless');
    } else {
      expect(result.stdout).toBe('');
    }
    expect(browserCalled() ? (await browserCalls(1)).length : 0).toBe(1);
  });

  test('--headless --devtools sets the flag; plain --headless clears it', async () => {
    const result = await launch(['--headless', '--devtools']);
    expect(result).toMatchObject({ code: 0, stdout: `${box.origin}/\n` });
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: true });
    await stopAndWait();
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
    expect((await launch(['--headless'])).code).toBe(0);
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: false });
  });

  test('a later normal launch reuses the headless server', async () => {
    await launch(['--headless']);
    const pid = await serverPid();
    const a = file('a.md');
    await launch(['a.md'], { env: INSTALLED });
    expect(await serverPid()).toBe(pid);
    expect(await browserCalls()).toEqual([[`--app-id=${expectedId()}`, a]]);
  });

  test('refuses a port held by another program and leaves that program alone', NEG, async () => {
    const foreign = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((resolve) => foreign.listen(box.port, '127.0.0.1', resolve));
    try {
      const result = await launch(['--headless']);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(new RegExp(`port ${box.port} is in use by another program`));
      expect(foreign.listening).toBe(true);
      expect(fs.existsSync(box.pidFile)).toBe(false);
    } finally {
      foreign.closeAllConnections();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });
});

/* ---------- --stop ---------- */

test.describe('--stop', () => {
  test('stops the server a launch started, and removes the state files', async () => {
    await launch(['--devtools'], { env: INSTALLED });
    const pid = await serverPid();
    await browserCalls(1);
    const result = await launch(['--stop']);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe(`markdown-viewer: stopped the server on port ${box.port}\n`);
    await serverGone(pid);
    expect(fs.readdirSync(box.run)).toEqual([]);
    expect((await browserCalls(1)).length).toBe(1);
  });

  test('stops a --headless server', async () => {
    await launch(['--headless']);
    const pid = await serverPid();
    const result = await launch(['--stop']);
    expect(result.code).toBe(0);
    await serverGone(pid);
  });

  test('with nothing running: exit 0, says so, starts nothing', NEG, async () => {
    const result = await launch(['--stop']);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe(`markdown-viewer: no server was running on port ${box.port}\n`);
    expect(await listening(box.port)).toBe(false);
    expect(browserCalled()).toBe(false);
    expect(fs.readdirSync(box.run)).toEqual([]);
  });

  test('removes a leftover devtools file even when no server runs', async () => {
    fs.writeFileSync(box.devtoolsFile, '');
    const result = await launch(['--stop']);
    expect(result.code).toBe(0);
    expect(fs.existsSync(box.devtoolsFile)).toBe(false);
  });

  test('twice in a row is fine', async () => {
    await launch([], { env: INSTALLED });
    await serverPid();
    expect((await stopAndWait()).code).toBe(0);
    const again = await launch(['--stop']);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).toMatch(/no server was running/);
  });

  for (const [name, command, args] of [
    ['a sleep', 'sleep', ['60']],
    ['a node program that is not server.js', process.execPath, ['-e', 'setInterval(() => {}, 1000)']],
    ['a shell script called server.js', '/bin/sh', ['@DIR@/server.js']],
  ]) {
    test(`does not kill ${name} that the pid file points at`, NEG, async () => {
      fs.writeFileSync(path.join(box.dir, 'server.js'), 'sleep 60\n');
      const unrelated = spawn(command, args.map((a) => a.replace('@DIR@', box.dir)), { stdio: 'ignore' });
      const exited = new Promise((resolve) => unrelated.once('exit', (code, signal) => resolve({ code, signal })));
      try {
        await new Promise((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject); });
        fs.writeFileSync(box.pidFile, `${unrelated.pid}\n`);
        fs.writeFileSync(box.devtoolsFile, '');
        const result = await launch(['--stop']);
        expect(result).toMatchObject({ code: 0, stderr: '' });
        expect(result.stdout).toMatch(/no server was running/);
        expect(fs.existsSync(box.devtoolsFile)).toBe(false);
        // A signal would have arrived long before this.
        expect(await Promise.race([exited, delay(500).then(() => 'still running')])).toBe('still running');
        // --headless must not kill it either when replacing "the" server.
        const headless = await launch(['--headless']);
        expect(headless.code).toBe(0);
        expect(await Promise.race([exited, delay(500).then(() => 'still running')])).toBe('still running');
        expect(await serverPid()).not.toBe(unrelated.pid);
      } finally {
        unrelated.kill('SIGKILL');
        await exited;
      }
    });
  }

  for (const [name, content] of [
    ['a pid that no longer exists', '@DEAD@\n'],
    ['garbage', 'not a pid\n'],
    ['nothing', ''],
    ['pid 1', '1\n'],
    ['a negative pid', '-1\n'],
    ['pid 0', '0\n'],
  ]) {
    test(`pid file containing ${name}: exit 0, nothing killed`, NEG, async () => {
      // A pid that existed and is gone for sure.
      const dead = spawn('true', { stdio: 'ignore' });
      await new Promise((resolve) => dead.once('exit', resolve));
      // "-1" / "0" would signal every process / the whole group if passed to kill.
      const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
      const exited = new Promise((resolve) => bystander.once('exit', (code, signal) => resolve({ code, signal })));
      try {
        fs.writeFileSync(box.pidFile, content.replace('@DEAD@', dead.pid));
        const result = await launch(['--stop']);
        // (With "0" the launcher also prints a bash error about /proc/0/cmdline
        // to stderr; harmless, so stderr is not checked here.)
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/no server was running/);
        expect(await Promise.race([exited, delay(300).then(() => 'still running')])).toBe('still running');
        expect(alive(1)).toBe(true);
      } finally {
        bystander.kill('SIGKILL');
        await exited;
      }
    });
  }

  test('does not stop a server on another port', NEG, async () => {
    await launch(['--headless']);
    const pid = await serverPid();
    // 8159 is reserved for "a port nobody serves" in these tests.
    const result = await launch(['--stop'], { env: { MARKDOWN_VIEWER_PORT: '8159' } });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no server was running on port 8159/);
    expect(alive(pid)).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('a launch after --stop starts a fresh server', async () => {
    await launch([], { env: INSTALLED });
    const first = await serverPid();
    await stopAndWait();
    await launch([], { env: INSTALLED });
    const second = await serverPid();
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);
    expect((await browserCalls(2)).length).toBe(2);
  });
});

