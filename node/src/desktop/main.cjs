/**
 * Electron entry point: a real desktop window, no browser involved.
 *
 * The HTTP server still does the work — it is how the canvas UI talks to the
 * filesystem — but it is bound to a random loopback port chosen by the OS and
 * the window is the only client. Nothing is exposed to the network and there is
 * no browser chrome.
 *
 * How a dataset is opened:
 *   * Started from the command line with paths, or with a folder next to the
 *     executable: that dataset opens immediately.
 *   * Otherwise the server starts empty and the page shows the picker. The
 *     window asks the main process for the native dialogs (a web page cannot
 *     read a filesystem path), then POSTs the result to the server.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A bundled app has no terminal, so anything written to stdout is lost. Fatal
 * startup errors are written here as well, which is the only practical way to
 * diagnose a packaged build that will not open.
 */
const logFile = path.join(os.tmpdir(), 'yolo-annotator-desktop.log');
// Written before anything else so even a failing require leaves a trace.
try {
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] main.cjs loading\n`);
} catch {
  // ignore
}
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // Logging must never be the reason the app fails.
  }
}
process.on('uncaughtException', (error) => log(`UNCAUGHT: ${error?.stack ?? error}`));
process.on('unhandledRejection', (reason) => log(`UNHANDLED: ${reason?.stack ?? reason}`));

/*
 * The server sources are TypeScript and Node strips the types on require, so
 * there is no build step between these files and the packaged app.
 *
 * The paths are relative to this file, which lives at the *root* of the staged
 * app (alongside src/ and web/), not in src/desktop. `scripts/build-desktop.mjs`
 * copies it there, and the packaged asar has the same shape.
 */
const { startServer } = require('./src/server/server.ts');
const { DatasetHost } = require('./src/server/dataset.ts');
const { Workspace } = require('./src/server/workspace.ts');

const here = __dirname;
const projectRoot = path.resolve(here, '..', '..');

/** Resolves a dataset before the window opens, or null to show the picker. */
async function resolveInitialDataset() {
  const [imagesDir, classesFile] = process.argv
    .slice(1)
    .filter((argument) => !argument.startsWith('-'));

  if (imagesDir !== undefined && classesFile !== undefined) {
    const workspace = await Workspace.open(imagesDir, classesFile);
    return new DatasetHost(workspace);
  }
  return new DatasetHost();
}

async function createWindow() {
  log('createWindow: resolving the initial dataset');
  const dataset = await resolveInitialDataset();
  log(`createWindow: dataset open = ${dataset.isOpen}`);
  const started = await startServer({
    workspace: dataset,
    host: '127.0.0.1',
    port: 0, // the OS picks a free port; nothing else can be listening there
    log: (message) => process.stdout.write(`${message}\n`),
  });

  log(`createWindow: server listening on ${started.url}`);

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0f19',
    title: 'YOLO Annotator',
    // `titleBarStyle: 'hiddenInset'` keeps the traffic lights and gives the
    // toolbar the space, which is what a native document window looks like.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => {
    log('window ready-to-show');
    window.show();
  });
  window.webContents.on('did-fail-load', (_e, code, description, url) => {
    log(`did-fail-load ${code} ${description} ${url}`);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
  });
  await window.loadURL(started.url);
  log('window.loadURL resolved');

  /* ------------------------------------------------------------- dialogs */

  ipcMain.handle('dataset:choose-images', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the folder that contains your images',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose folder',
    });
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });

  ipcMain.handle('dataset:choose-classes', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select your classes file (for example obj.names)',
      properties: ['openFile'],
      buttonLabel: 'Choose file',
      filters: [
        { name: 'Classes', extensions: ['names', 'txt', 'labels'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });

  ipcMain.handle('dataset:run-in-browser', async () => {
    await shell.openExternal(started.url);
  });

  /*
   * Closing the window must not lose the last edit.
   *
   * The page autosaves 150 ms after each change, so a close (or Cmd+W) in that
   * window used to discard the box that was just drawn. `beforeunload` cannot
   * fix it — the save is asynchronous and the window is already closing — so the
   * close is intercepted, the page is asked to flush, and only then does the
   * window actually close.
   */
  let allowClose = false;
  let closing = false;

  const flush = (timeoutMs = 5000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ saved: false, timedOut: true }), timeoutMs);
      ipcMain.once('app:flushed', (_event, result) => {
        clearTimeout(timer);
        resolve(result ?? { saved: false });
      });
      window.webContents.send('app:flush');
    });

  window.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        const result = await flush();
        if (result?.timedOut) log('flush timed out; closing anyway');
        else log(`flushed before close: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`flush failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        allowClose = true;
        closing = false;
        window.close();
      }
    })();
  });

  window.on('closed', () => {
    void started.close().catch(() => undefined);
  });
}

/**
 * Starts the app. Exported so a test driver can load this file, then create the
 * window itself and inspect it — which is how the packaged UI is verified.
 */
function start() {
  return app.whenReady().then(() => {
    void createWindow().catch((error) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      log(`createWindow FAILED: ${message}`);
      dialog.showErrorBox('YOLO Annotator could not start', message);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // On macOS apps normally stay in the Dock, but this one is a single window
  // whose whole purpose is the server it is hosting, so it should exit.
  app.quit();
});

module.exports = { start, createWindow };

// Only self-start when Electron was pointed at this file directly.
if (require.main === module) start();
