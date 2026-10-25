// Windows CI smoke test: real Electron, OS-backed encryption and renderer loading.
const {
  app,
  BrowserWindow,
  WebContentsView,
  safeStorage,
  ipcMain,
} = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { FlowEditor, TOOLBAR_HEIGHT } = require("./flow-editor");
app.whenReady().then(async () => {
  let folder, flow, server, savedFlow;
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
    let setupReady = false;
    ipcMain.handle("setup:install", (_, mode) => {
      assert.equal(mode, "cpu");
      setupReady = true;
      return { ready: true };
    });
    ipcMain.handle("settings:get", () => ({
      setupReady,
      ollamaModel: "qwen2.5:1.5b",
      ollamaUrl: "http://127.0.0.1:11435",
      comfyUrl: "http://127.0.0.1:18188",
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
    // Small frontend fixture tests the native embedded view and bridge, not actual ComfyUI models.
    server = http.createServer((req, res) => {
      if (req.url === "/scripts/app.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(
          `let graph={};export const app={loadApiJson:async(data)=>{graph=data;document.getElementById('graph').textContent=JSON.stringify(data);},graphToPrompt:async()=>({output:graph})};`,
        );
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<html><body><div id="graph">Frontend fixture</div><script type="module">import {app} from '/scripts/app.js';document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',async e=>{e.preventDefault();await app.loadApiJson(JSON.parse(await e.dataTransfer.files[0].text()));});</script></body></html>`,
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    flow = new FlowEditor(win, WebContentsView);
    ipcMain.handle("editor:show", async () => {
      await flow.show("http://127.0.0.1:" + server.address().port);
      return true;
    });
    ipcMain.handle("editor:hide", () => {
      flow.hide();
      return true;
    });
    ipcMain.handle("editor:load", async () => {
      await flow.loadPrompt({
        1: { class_type: "SaveImage", inputs: { text: "{{PROMPT}}" } },
      });
      return true;
    });
    ipcMain.handle("editor:use", async () => {
      savedFlow = await flow.currentPrompt();
      return true;
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
    await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('setup').click();
      await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(document.getElementById('setupStatus').textContent==='已配置并连接'){clearInterval(timer);resolve();}else if(Date.now()-started>10000){clearInterval(timer);reject(new Error(document.getElementById('status').textContent));}},50);});
    })()`);
    assert.equal(setupReady, true);
    async function clickAndWait(id, condition) {
      await win.webContents.executeJavaScript(
        `(async()=>{document.getElementById(${JSON.stringify(id)}).click();await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve();}else if(Date.now()-start>10000){clearInterval(timer);reject(new Error(document.getElementById('flowStatus').textContent));}},50);});})()`,
      );
    }
    await clickAndWait(
      "flowTab",
      "document.body.classList.contains('flow-mode')",
    );
    assert.equal(flow.visible, true);
    const originalView = flow.view;
    assert.ok(win.contentView.children.includes(originalView));
    assert.equal(originalView.getBounds().y, TOOLBAR_HEIGHT);
    assert.deepEqual(
      await originalView.webContents.executeJavaScript(
        "({node:typeof require,bridge:typeof window.studio})",
      ),
      { node: "undefined", bridge: "undefined" },
    );
    await clickAndWait(
      "loadFlow",
      "document.getElementById('flowStatus').textContent.startsWith('已载入')",
    );
    assert.equal((await flow.currentPrompt())["1"].class_type, "SaveImage");
    await originalView.webContents.executeJavaScript(
      `(async()=>{const files=new DataTransfer();files.items.add(new File([JSON.stringify({'2':{class_type:'SaveImage',inputs:{text:'edited {{PROMPT}}'}}})],'flow.json',{type:'application/json'}));document.dispatchEvent(new DragEvent('drop',{dataTransfer:files,bubbles:true,cancelable:true}));await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(document.getElementById('graph').textContent.includes('edited')){clearInterval(timer);resolve();}else if(Date.now()-start>5000){clearInterval(timer);reject(new Error('Fixture drop did not complete'));}},25);});})()`,
    );
    await clickAndWait(
      "useFlow",
      "document.getElementById('flowStatus').textContent.startsWith('当前 Flow 已保存')",
    );
    assert.equal(savedFlow["2"].inputs.text, "edited {{PROMPT}}");
    await clickAndWait(
      "workbenchTab",
      "!document.body.classList.contains('flow-mode')",
    );
    assert.equal(flow.visible, false);
    await clickAndWait(
      "flowTab",
      "document.body.classList.contains('flow-mode')",
    );
    assert.equal(flow.view, originalView);
    assert.equal(
      (await flow.currentPrompt())["2"].inputs.text,
      "edited {{PROMPT}}",
    );
    win.setContentSize(1060, 780);
    flow.resize();
    assert.equal(originalView.getBounds().height, 780 - TOOLBAR_HEIGHT);
    flow.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(
      "Electron smoke passed: secure storage, Unicode paths, renderer and sandbox bridge.",
    );
    await fs.rm(folder, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    flow?.destroy();
    server?.closeAllConnections();
    server?.close();
    if (folder) await fs.rm(folder, { recursive: true, force: true });
    app.exit(1);
  }
});
