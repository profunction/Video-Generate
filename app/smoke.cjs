// Windows CI smoke test: real Electron, OS-backed encryption and renderer loading.
const { app, BrowserWindow, safeStorage, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
app.whenReady().then(async () => {
  let folder;
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
    const encrypted = safeStorage.encryptString('smoke-test-placeholder');
    assert.equal(safeStorage.decryptString(encrypted), 'smoke-test-placeholder');
    assert.equal(encrypted.includes(Buffer.from('smoke-test-placeholder')), false);
    folder = await fs.mkdtemp(path.join(os.tmpdir(), '短剧 studio '));
    await fs.writeFile(path.join(folder, 'key.bin'), encrypted);
    assert.equal(safeStorage.decryptString(await fs.readFile(path.join(folder, 'key.bin'))), 'smoke-test-placeholder');
    ipcMain.handle('settings:get', () => ({ region: 'china', model: 'wan2.2-i2v-flash', pricePerSecond: 0, budget: 10, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', hasKey: false }));
    ipcMain.handle('projects:list', () => []);
    const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, 'index.html'));
    const result = await win.webContents.executeJavaScript(`({ title: document.title, bridge: typeof window.studio.run, node: typeof window.require, sections: document.querySelectorAll('section').length })`);
    assert.equal(result.title, 'Video Generate');
    assert.equal(result.bridge, 'function');
    assert.equal(result.node, 'undefined');
    assert.equal(result.sections, 3);
    console.log('Electron smoke passed: secure storage, Unicode paths, renderer and sandbox bridge.');
    await fs.rm(folder, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (folder) await fs.rm(folder, { recursive: true, force: true });
    app.exit(1);
  }
});
