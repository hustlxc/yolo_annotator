/**
 * The only bridge between the page and the desktop shell.
 *
 * Deliberately tiny: the page can ask for two native dialogs, and nothing else.
 * `contextIsolation` is on and `nodeIntegration` is off, so the canvas UI keeps
 * running exactly as it does in a browser — it just gains a way to learn a
 * filesystem path, which a web page otherwise cannot do.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yolo', {
  /** Native folder picker; resolves to '' when cancelled. */
  chooseImagesFolder: () => ipcRenderer.invoke('dataset:choose-images'),
  /** Native file picker; resolves to '' when cancelled. */
  chooseClassesFile: () => ipcRenderer.invoke('dataset:choose-classes'),
  /** Escape hatch: open the same session in the system browser. */
  openInBrowser: () => ipcRenderer.invoke('dataset:run-in-browser'),

  /**
   * Registers the "save everything now" handler the main process calls before
   * closing the window. The page resolves the returned promise once the pending
   * annotation has been written, so a close cannot race the 150 ms autosave
   * debounce and lose the last edit.
   */
  onFlushRequest: (handler) => {
    ipcRenderer.on('app:flush', async (_event) => {
      try {
        const result = await handler();
        ipcRenderer.send('app:flushed', result ?? { saved: false });
      } catch (error) {
        ipcRenderer.send('app:flushed', { saved: false, error: String(error) });
      }
    });
  },
  platform: process.platform,
});
