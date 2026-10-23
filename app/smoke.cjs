// Windows CI smoke test: real Electron, OS-backed encryption and renderer loading.
const { app, BrowserWindow, safeStorage, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
app.whenReady().then(async () => {
  let folder;
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    if (process.platform === "linux")
      assert.notEqual(safeStorage.getSelectedStorageBackend(), "basic_text");
    const encrypted = safeStorage.encryptString("smoke-test-placeholder");
    assert.equal(
      safeStorage.decryptString(encrypted),
      "smoke-test-placeholder",
    );
    assert.equal(
      encrypted.includes(Buffer.from("smoke-test-placeholder")),
      false,
    );
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "短剧 studio "));
    await fs.writeFile(path.join(folder, "key.bin"), encrypted);
    assert.equal(
      safeStorage.decryptString(
        await fs.readFile(path.join(folder, "key.bin")),
      ),
      "smoke-test-placeholder",
    );
    ipcMain.handle("settings:get", () => ({
      region: "china",
      model: "wan2.2-i2v-flash",
      pricePerSecond: 0,
      budget: 10,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      hasKey: false,
    }));
    let created = null,
      runs = 0;
    ipcMain.handle("projects:list", () => (created ? [created] : []));
    ipcMain.handle("story:generate", (_, idea, count) => ({
      name: "Smoke story",
      scenes: Array.from({ length: count }, () => ({
        prompt: "Camera moves",
        imagePrompt: "Clockmaker",
        narration: "A letter arrives",
        image: "",
      })),
    }));
    ipcMain.handle("project:create", (_, draft) => {
      created = { ...draft, id: "smoke", reserved: 0 };
      return created;
    });
    ipcMain.handle("project:run", () => {
      runs++;
      return { canceled: true };
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript(
      `({ title: document.title, bridge: typeof window.studio.run, node: typeof window.require, sections: document.querySelectorAll('section').length })`,
    );
    assert.equal(result.title, "Video Generate");
    assert.equal(result.bridge, "function");
    assert.equal(result.node, "undefined");
    assert.equal(result.sections, 3);
    await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('idea').value='Clockmaker story';
      document.getElementById('automatic').click();
      await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(document.getElementById('status').textContent.includes('已取消')){clearInterval(timer);resolve();}else if(Date.now()-started>10000){clearInterval(timer);reject(new Error(document.getElementById('status').textContent));}},50);});
    })()`);
    assert.equal(created.scenes.length, 4);
    assert.equal(runs, 1);
    console.log(
      "Electron smoke passed: secure storage, Unicode paths, renderer and sandbox bridge.",
    );
    await fs.rm(folder, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (folder) await fs.rm(folder, { recursive: true, force: true });
    app.exit(1);
  }
});
