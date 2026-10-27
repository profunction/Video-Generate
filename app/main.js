const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  nativeImage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Wan, validate, merge, run } = require("./engine");
const {
  storyboard,
  Comfy,
  checkServices,
  prepareWorkflow,
  builtInWorkflow,
  builtInWorkflowUi,
} = require("./local-ai");
const { finish } = require("./finish");
const { produce } = require("./pipeline");
let win,
  busy = false,
  // Only paid generation must keep the window open; leaving while a script is written is harmless.
  guarded = false;
const defaults = {
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 0,
  budget: 10,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5:7b",
  comfyUrl: "http://127.0.0.1:8188",
  narration: false,
  voice: "",
  // Alibaba Cloud writes the script and draws pictures, so a key is all a customer needs.
  scriptSource: "cloud",
  imageSource: "cloud",
  textModel: "qwen-plus",
  imageModel: "wan2.2-t2i-flash",
};
const root = () => app.getPath("userData");
const text = (value) => String(value ?? "").trim();
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
async function read(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + ".tmp", JSON.stringify(value, null, 2));
  await fs.rename(file + ".tmp", file);
}
// An imported file wins, then the copy edited in ComfyUI, then the built-in SD1.5 graph.
async function workflow(cfg) {
  const imported = await read(path.join(root(), "workflow.json"), null);
  if (imported) return { graph: imported, source: "imported" };
  let edited = null;
  try {
    edited = await new Comfy(cfg).edited();
  } catch (e) {
    // Without ComfyUI the built-in graph stands in; the ComfyUI check reports the outage.
    if (!/Cannot reach|timed out/.test(e.message)) throw e;
  }
  if (edited) return { graph: edited, source: "comfyui" };
  return { graph: builtInWorkflow, source: "built-in" };
}
const SOURCES = {
  imported: "imported",
  comfyui: "Video Generate (edited in ComfyUI)",
  "built-in": "built-in SD1.5",
};
async function saved() {
  return {
    ...defaults,
    ...(await read(path.join(root(), "settings.json"), {})),
  };
}
// The installer ships FFmpeg; a path the user entered still wins.
async function settings() {
  const cfg = await saved();
  if (app.isPackaged)
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const shipped = path.join(process.resourcesPath, "ffmpeg", `${tool}.exe`);
      if (cfg[tool] === tool && (await exists(shipped))) cfg[tool] = shipped;
    }
  return cfg;
}
async function readKey() {
  let data;
  try {
    data = await fs.readFile(path.join(root(), "key.bin"));
  } catch (e) {
    if (e.code === "ENOENT") throw Error("请先在设置中保存阿里云 API Key");
    throw e;
  }
  try {
    return safeStorage.decryptString(data);
  } catch {
    throw Error("无法解密已保存的 API Key，请重新输入并保存设置");
  }
}
// Some Wan models reject images over 2000 px per side, and 720P output gains nothing from more.
async function importImage(source, target) {
  let img = nativeImage.createFromPath(source);
  if (img.isEmpty()) throw Error("无法读取所选图片，请使用 PNG 或 JPEG");
  const { width, height } = img.getSize();
  if (Math.max(width, height) > 1920)
    img = img.resize(
      width >= height
        ? { width: 1920, quality: "best" }
        : { height: 1920, quality: "best" },
    );
  await fs.writeFile(target, img.toPNG());
  return target;
}
const emit = (message) => win?.webContents.send("progress", message);
const PROJECT_ID = /^[a-f0-9-]{36}$/;
function projectPath(id) {
  if (!PROJECT_ID.test(id)) throw Error("Invalid project");
  return path.join(root(), "projects", id, "project.json");
}
// A second instance could run the same project and submit paid jobs twice.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(async () => {
  if (!primary) return;
  await fs.mkdir(root(), { recursive: true });
  win = new BrowserWindow({
    width: 1180,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("close", (e) => {
    if (guarded) {
      e.preventDefault();
      emit("生成任务尚未结束，请保持窗口开启。");
    }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  ipcMain.handle("settings:get", async () => ({
    ...(await saved()),
    hasKey: await exists(path.join(root(), "key.bin")),
  }));
  ipcMain.handle("settings:save", async (_, value) => {
    if (busy) throw Error("Wait until generation finishes");
    const config = {};
    for (const k of Object.keys(defaults)) config[k] = value[k] ?? defaults[k];
    const key = text(value.key);
    if (key) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw Error("Secure credential storage unavailable");
      await fs.writeFile(
        path.join(root(), "key.bin"),
        safeStorage.encryptString(key),
        { mode: 0o600 },
      );
    }
    await save(path.join(root(), "settings.json"), config);
    return true;
  });
  ipcMain.handle("projects:list", async () => {
    const dir = path.join(root(), "projects");
    await fs.mkdir(dir, { recursive: true });
    const projects = [];
    for (const id of await fs.readdir(dir)) {
      // Skip desktop.ini, Thumbs.db and other files Windows puts in folders.
      if (!PROJECT_ID.test(id)) continue;
      try {
        const p = await read(projectPath(id), null);
        if (p) projects.push(p);
      } catch (e) {
        // List a damaged project (e.g. a hand-edited JSON typo) instead of hiding all projects.
        projects.push({
          id,
          name: `无法读取的项目（${e.message}）`,
          scenes: [],
          reserved: 0,
          broken: true,
        });
      }
    }
    return projects.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    );
  });
  ipcMain.handle("project:create", async (_, input) => {
    if (busy) throw Error("Generation is running");
    const p = {
      id: crypto.randomUUID(),
      name: String(input.name || "Untitled").slice(0, 100),
      scenes: input.scenes.map((s, i) => ({
        prompt: text(s.prompt),
        image: text(s.image),
        imagePrompt: text(s.imagePrompt),
        narration: text(s.narration).slice(0, 2000),
        localImage: s.localImage || "",
        continuePrevious: i > 0 && Boolean(s.continuePrevious),
      })),
      reserved: 0,
      createdAt: new Date().toISOString(),
    };
    if (!p.scenes.length || p.scenes.length > 50)
      throw Error("Provide 1–50 scenes");
    const folder = path.dirname(projectPath(p.id));
    await fs.mkdir(folder, { recursive: true });
    for (let i = 0; i < p.scenes.length; i++) {
      const scene = p.scenes[i];
      if (scene.localImage)
        scene.localImage = await importImage(
          scene.localImage,
          path.join(folder, `image-${i}.png`),
        );
    }
    await save(projectPath(p.id), p);
    return p;
  });
  ipcMain.handle("local:check", async () => {
    const cfg = await settings();
    const report = [await checkServices(cfg)].filter(Boolean);
    if (cfg.scriptSource === "cloud" || cfg.imageSource === "cloud")
      report.push(
        ((await exists(path.join(root(), "key.bin")))
          ? "阿里云：API Key 已保存"
          : "阿里云：还没有保存 API Key，请在上面填写后点保存设置") +
          (cfg.scriptSource === "cloud" ? ` · 剧本 ${cfg.textModel}` : "") +
          (cfg.imageSource === "cloud" ? ` · 图片 ${cfg.imageModel}` : ""),
      );
    if (cfg.imageSource !== "cloud") {
      let line = "ComfyUI workflow: ";
      try {
        const flow = await workflow(cfg);
        line += SOURCES[flow.source];
        try {
          const used = await new Comfy(cfg).ready(flow.graph);
          if (used.length) line += ` · model ${used.join(", ")}`;
        } catch (e) {
          // The ComfyUI line above already reports an unreachable service.
          if (!/Cannot reach|timed out/.test(e.message))
            line += ` · ${e.message}`;
        }
      } catch (e) {
        line += e.message;
      }
      report.push(line);
    }
    for (const [name, binary] of [
      ["FFmpeg", cfg.ffmpeg],
      ["FFprobe", cfg.ffprobe],
    ])
      report.push(
        await run(binary, ["-version"]).then(
          (out) => `${name}: ${out.split(/\r?\n/)[0]}`,
          (e) => `${name}: ${e.message}`,
        ),
      );
    return report.join("\n");
  });
  ipcMain.handle("story:generate", async (_, idea, count, continuous) => {
    if (busy) throw Error("Another operation is running");
    busy = true;
    try {
      const cfg = await settings();
      const cloud = cfg.scriptSource === "cloud";
      emit(cloud ? "阿里云正在写剧本…" : "Ollama 正在生成剧本…");
      return await storyboard(
        idea,
        Number(count),
        cfg,
        fetch,
        Boolean(continuous),
        cloud ? await readKey() : "",
      );
    } finally {
      busy = false;
    }
  });
  ipcMain.handle("image:pick", async () => {
    // nativeImage decodes PNG and JPEG only.
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("workflow:import", async () => {
    if (busy) throw Error("Generation is running");
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "ComfyUI API workflow", extensions: ["json"] }],
    });
    if (r.canceled) return false;
    const graph = JSON.parse(await fs.readFile(r.filePaths[0], "utf8"));
    prepareWorkflow(graph, "test");
    await save(path.join(root(), "workflow.json"), graph);
    return true;
  });
  ipcMain.handle("workflow:edit", async () => {
    if (busy) throw Error("Generation is running");
    const comfy = new Comfy(await settings());
    // Adds the built-in graph to ComfyUI's workflow list unless the user already has a copy there.
    await comfy.publish(builtInWorkflowUi);
    // From now on the copy in ComfyUI is the one used.
    await fs.rm(path.join(root(), "workflow.json"), { force: true });
    await shell.openExternal(comfy.base);
  });
  ipcMain.handle("workflow:reset", async () => {
    if (busy) throw Error("Generation is running");
    await fs.rm(path.join(root(), "workflow.json"), { force: true });
    // Also restore the copy in ComfyUI's workflow list when ComfyUI is running.
    try {
      return await new Comfy(await settings()).publish(builtInWorkflowUi, true);
    } catch {
      return false;
    }
  });
  ipcMain.handle("project:update", async (_, id, scenes) => {
    if (busy) throw Error("Generation is running");
    const file = projectPath(id),
      p = await read(file, null);
    if (!p) throw Error("Missing project");
    if (scenes.length !== p.scenes.length)
      throw Error("Scene count cannot change in saved projects");
    for (let i = 0; i < scenes.length; i++) {
      const old = p.scenes[i],
        next = {
          prompt: text(scenes[i].prompt),
          image: text(scenes[i].image),
          imagePrompt: text(scenes[i].imagePrompt),
          localImage: scenes[i].localImage || "",
          continuePrevious: i > 0 && Boolean(scenes[i].continuePrevious),
        };
      // Compare trimmed text: the editor trims, but stored Ollama output may not be.
      if (old.taskId || old.uncertain) {
        if (
          next.prompt !== text(old.prompt) ||
          next.image !== text(old.image) ||
          next.imagePrompt !== text(old.imagePrompt) ||
          next.localImage !== (old.localImage || "") ||
          next.continuePrevious !== Boolean(old.continuePrevious)
        )
          throw Error(
            "Submitted scene visuals are locked; create a new project to change them",
          );
      } else {
        if (
          next.imagePrompt !== text(old.imagePrompt) ||
          (old.localImage && !next.localImage)
        ) {
          // A new prompt for a ComfyUI picture, or a cleared picture, asks for a fresh image.
          if (old.comfyId && next.localImage === (old.localImage || ""))
            next.localImage = "";
          delete old.comfyId;
        }
        old.prompt = next.prompt;
        old.image = next.image;
        old.imagePrompt = next.imagePrompt;
        old.continuePrevious = next.continuePrevious;
        if (next.localImage && next.localImage !== old.localImage)
          old.localImage = await importImage(
            next.localImage,
            path.join(
              path.dirname(file),
              `image-${i}-${crypto.randomUUID()}.png`,
            ),
          );
        else old.localImage = next.localImage;
      }
      old.narration = text(scenes[i].narration).slice(0, 2000);
    }
    await save(file, p);
    return p;
  });
  ipcMain.handle("project:open", async (_, id) => {
    await shell.openPath(path.dirname(projectPath(id)));
  });
  ipcMain.handle("project:run", async (_, id) => {
    if (busy) throw Error("Another project is running");
    busy = guarded = true;
    try {
      const file = projectPath(id),
        p = await read(file, null);
      if (!p) throw Error("Project not found");
      const cfg = await settings();
      // Stop before the approval dialog, so no other scene is paid for first.
      const unsure = p.scenes.findIndex((s) => s.uncertain);
      if (unsure >= 0)
        throw Error(
          `镜头 ${unsure + 1} 的付费提交结果不确定。请先在阿里云控制台核实（见 README“数据与费用保护”），不要直接创建替代项目。`,
        );
      const estimate = validate(p, cfg);
      await run(cfg.ffmpeg, ["-version"]);
      await run(cfg.ffprobe, ["-version"]);
      // Scenes whose first frame still has to be drawn, by ComfyUI or Alibaba Cloud.
      const pictures = p.scenes.filter(
        (s, i) =>
          !s.taskId &&
          !s.clip &&
          !s.localImage &&
          !s.image &&
          !(i > 0 && s.continuePrevious),
      ).length;
      const cloudPictures = cfg.imageSource === "cloud" ? pictures : 0;
      const graph =
        pictures && !cloudPictures ? (await workflow(cfg)).graph : null;
      // Check ComfyUI and its model before the approval dialog, so nothing is paid for first.
      if (graph) {
        emit("正在检查 ComfyUI 和模型…");
        await new Comfy(cfg).ready(graph);
      }
      const folder = path.dirname(file);
      // A deleted clip is downloaded again from its task, which needs the key too.
      let needsCloud = false;
      for (const s of p.scenes)
        if (!s.clip || !(await exists(path.join(folder, s.clip))))
          needsCloud = true;
      const key = needsCloud ? await readKey() : "";
      const count = p.scenes.filter((s) => !s.taskId && !s.clip).length;
      if (count) {
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["取消", "批准付费生成"],
          defaultId: 0,
          cancelId: 0,
          title: "确认付费生成",
          message: `提交 ${count} 个付费 Wan 视频任务？`,
          detail: `预计新增视频费用：${estimate.toFixed(2)}。本项目已预留：${Number(p.reserved || 0).toFixed(2)}。预算：${cfg.budget}。${cloudPictures ? `另外会用阿里云画 ${cloudPictures} 张图，按张计费（失败不收费，价格见百炼控制台）。` : ""}图片会上传到阿里云临时存储（有效期 48 小时）。所有金额使用你填写的单价币种；估算不代表实际账单，请核对阿里云当前报价。`,
        });
        if (result.response !== 1) return { canceled: true };
      }
      await produce(p, folder, cfg, {
        wan: new Wan(cfg, key),
        comfy: graph ? new Comfy(cfg) : null,
        workflow: graph,
        persist: () => save(file, p),
        emit,
      });
      emit("正在用 FFmpeg 合并视频…");
      p.output = await merge(
        p.scenes.map((s) => path.join(folder, s.clip)),
        folder,
        cfg,
      );
      if (p.scenes.some((s) => s.narration?.trim())) {
        emit("正在添加字幕和可选的 Windows 配音…");
        p.output = await finish(p, folder, cfg);
      }
      await save(file, p);
      emit("完成：" + p.output);
      return p;
    } finally {
      busy = guarded = false;
    }
  });
});
app.on("before-quit", (e) => {
  if (guarded) {
    e.preventDefault();
    emit("任务正在进行，请保持窗口开启，直到完成或出现错误提示。");
  }
});
app.on("window-all-closed", () => {
  if (!guarded) app.quit();
});
