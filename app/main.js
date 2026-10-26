const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  nativeImage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Wan, validate, download, merge, run } = require("./engine");
const {
  storyboard,
  Comfy,
  checkServices,
  prepareWorkflow,
} = require("./local-ai");
const { finish } = require("./finish");
const { Runtime, workflow: defaultWorkflow } = require("./runtime");
const { FlowEditor } = require("./flow-editor");
const { FlowJobs, FlowGateway, videoWorkflow } = require("./flow-gateway");
const { planCleanup, cleanupCandidate } = require("./model-cleanup");
let gateway, flowJobs;
const { localBase } = require("./local-ai");
let flowEditor;
let runtime;
async function ensureManaged() {
  const state = await read(path.join(root(), "setup.json"), null);
  if (state?.installed) {
    if (!state.ready) throw Error("请先完成一键环境配置");
    await runtime.start();
  }
}
let win,
  busy = false;
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
};
const root = () => app.getPath("userData");
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
async function settings() {
  return {
    ...defaults,
    ...(await read(path.join(root(), "settings.json"), {})),
  };
}
const emit = (message) => win?.webContents.send("progress", message);
function projectPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid project");
  return path.join(root(), "projects", id, "project.json");
}
const ownsInstance = app.requestSingleInstanceLock();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
if (!ownsInstance) app.quit();
else
  app.whenReady().then(async () => {
    await fs.mkdir(root(), { recursive: true });
    runtime = new Runtime(root(), emit);
    win = new BrowserWindow({
      width: 1180,
      minWidth: 960,
      minHeight: 650,
      height: 850,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    flowEditor = new FlowEditor(win, WebContentsView);
    flowJobs = new FlowJobs({
      root: root(),
      settings,
      getKey: async () =>
        safeStorage.decryptString(
          await fs.readFile(path.join(root(), "key.bin")),
        ),
      approve: async ({ count, estimate, project, cfg }) => {
        win.show();
        win.focus();
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["取消", "批准付费生成"],
          defaultId: 0,
          cancelId: 0,
          message: `Wan：${count} 张图片 → 每张 5 秒视频`,
          detail: `预计新增费用 ${estimate.toFixed(2)}，已预留 ${Number(project.reserved).toFixed(2)}，项目预算 ${cfg.budget}。币种与填写的每秒价格一致。图片会上传阿里云临时存储。以实际账单为准。`,
        });
        return result.response === 1;
      },
      report: emit,
      normalizeImage: async (bytes) => {
        if (
          bytes.length < 24 ||
          bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16000000
        )
          throw Error("PNG 分辨率过大");
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw Error("无法读取 PNG 图片");
        return image.toPNG();
      },
    });
    gateway = new FlowGateway({
      root: root(),
      handle: async (route, input) => {
        if (busy) throw Error("程序有其他任务正在执行，请稍后恢复");
        busy = true;
        try {
          return route === "/clips"
            ? await flowJobs.clips(input)
            : await flowJobs.combine(input);
        } catch(error) {
          emit("Flow 任务失败："+error.message);
          throw error;
        } finally {
          busy = false;
        }
      },
    });
    await gateway.start();
    win.on("close", (e) => {
      if (busy) {
        e.preventDefault();
        emit("生成任务尚未结束，请保持窗口开启。");
      }
    });
    win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    ipcMain.handle("editor:show", async () => {
      await ensureManaged();
      const config = await settings();
      const base = localBase(config.comfyUrl);
      let response;
      try {
        response = await fetch(base + "/system_stats", {
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw Error(
          "ComfyUI 尚未启动，请先运行一键环境配置，或保存正确的 ComfyUI 地址。",
        );
      }
      if (!response.ok) throw Error("ComfyUI 连接失败，请检查本地服务。");
      await flowEditor.show(base);
      return true;
    });
    ipcMain.handle("editor:video", async () => {
      if (busy) throw Error("请等待当前任务完成");
      await ensureManaged();
      const cfg = await settings(),
        base = localBase(cfg.comfyUrl);
      let info;
      try {
        const response = await fetch(
          base + "/object_info/VG_WanFiveSecondClips",
          { signal: AbortSignal.timeout(15000) },
        );
        info = await response.json();
      } catch {
        throw Error("ComfyUI 未连接，请先完成环境配置");
      }
      if (!info.VG_WanFiveSecondClips)
        throw Error(
          "视频节点尚未加载。请完全关闭旧版程序与旧 ComfyUI，再打开新版并启动环境。",
        );
      if (flowEditor.view) {
        await save(
          path.join(root(), "flow-backups", Date.now() + ".json"),
          await flowEditor.snapshot(),
        );
      }
      await flowEditor.show(base);
      await flowEditor.loadPrompt(videoWorkflow());
      return true;
    });
    ipcMain.handle("models:cleanup", async () => {
      if (busy) throw Error("请等待生成任务完成再清理模型");
      busy = true;
      try {
        const comfy = path.join(
          root(),
          "tools",
          "comfy",
          "ComfyUI_windows_portable",
          "ComfyUI",
        );
        const collect = async () => {
          const cfg = await settings();
          const managed = "http://127.0.0.1:18188";
          if (
            localBase(cfg.comfyUrl) !== managed ||
            flowEditor.base !== managed
          )
            throw Error(
              "清理只适用于程序托管的 ComfyUI。请保存地址 http://127.0.0.1:18188 并打开对应 Flow，再进行清理。",
            );
          const response = await fetch(localBase(cfg.comfyUrl) + "/queue", {
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw Error("无法检查 ComfyUI 队列，已停止清理");
          const queue = await response.json();
          if (
            !Array.isArray(queue.queue_running) ||
            !Array.isArray(queue.queue_pending) ||
            queue.queue_running.length ||
            queue.queue_pending.length
          )
            throw Error("ComfyUI 仍有任务或队列不可确认，请稍后再清理");
          return [
            await read(path.join(root(), "workflow.json"), {}),
            await flowEditor.snapshot(),
          ];
        };
        const candidates = await planCleanup(comfy, await collect());
        if (!candidates.length)
          return {
            removed: [],
            message:
              "没有可安全清理的旧基础模型：可能仍被工作流引用、已被移除，或文件不是程序原版。其他模型不会删除。",
          };
        const result = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["保留", "移到回收站"],
          defaultId: 0,
          cancelId: 0,
          message: "清理未引用的旧基础模型",
          detail:
            candidates
              .map(
                (c) =>
                  c.name + " · " + (c.bytes / 1024 ** 3).toFixed(2) + " GB",
              )
              .join("\n") +
            "\n已检查当前画布、程序工作流和 ComfyUI 保存的 JSON。若其他未保存的标签页仍需旧模型，请先取消并保存这些工作流。旧备份恢复时可能需要从回收站还原模型。写实模型、VAE、自行添加的模型和项目均保留。",
        });
        if (result.response !== 1)
          return { removed: [], message: "已保留旧模型" };
        const removed = [];
        for (const candidate of candidates) {
          const refs = await collect();
          removed.push(
            await cleanupCandidate(comfy, candidate, refs, {
              refreshReferences: collect,
              trashItem: (file) => shell.trashItem(file),
            }),
          );
        }
        return {
          removed,
          message:
            "旧基础模型已移到回收站，可恢复。确认不再需要后可自行清空回收站以释放空间。",
        };
      } finally {
        busy = false;
      }
    });
    ipcMain.handle("editor:hide", () => {
      flowEditor.hide();
      return true;
    });
    ipcMain.handle("editor:load", async () => {
      if (busy) throw Error("请等当前任务完成再更换画布");
      const graph = await read(
        path.join(root(), "workflow.json"),
        defaultWorkflow(),
      );
      await flowEditor.loadPrompt(graph);
      return true;
    });
    ipcMain.handle("editor:use", async () => {
      if (busy) throw Error("请等当前任务结束再修改自动流程");
      const graph = await flowEditor.currentPrompt();
      try {
        if (
          Object.values(graph).some((n) =>
            String(n.class_type).startsWith("VG_"),
          )
        )
          throw Error("完整视频 Flow 请直接在画布运行，不能保存为生图子流程。");
        prepareWorkflow(graph, "check");
      } catch (e) {
        throw Error(
          "当前 Flow 可以直接运行；若要用于自动短剧，请在正向提示词中加入 {{PROMPT}}，并保留 SaveImage 节点。" +
            e.message,
        );
      }
      const file = path.join(root(), "workflow.json");
      if (
        await fs.access(file).then(
          () => true,
          () => false,
        )
      )
        await fs.copyFile(file, file + ".before-flow-" + Date.now() + ".bak");
      await save(file, graph);
      return true;
    });
    ipcMain.handle("settings:get", async () => ({
      ...(await settings()),
      setupReady: !!(await read(path.join(root(), "setup.json"), null))?.ready,
      hasKey: await fs.access(path.join(root(), "key.bin")).then(
        () => true,
        () => false,
      ),
    }));
    ipcMain.handle("setup:install", async (_, mode) => {
      if (busy) throw Error("请等待当前任务结束");
      busy = true;
      try {
        const result = await dialog.showMessageBox(win, {
          type: "info",
          buttons: ["取消", "下载并配置"],
          defaultId: 0,
          cancelId: 0,
          message: "一键配置完整短剧环境",
          detail:
            "将下载约 10 GB 的工具和模型，首次需要至少 25 GB 空闲空间，建议 16 GB 内存。自动下载 Ollama、ComfyUI、FFmpeg、7-Zip、Qwen2.5 1.5B 和 Realistic Vision 5.1 写实模型及 VAE，并配置本地连接与默认工作流。CPU 模式无需 NVIDIA，但生图会较慢。会备份并替换现有的本地连接配置及工作流，不更改 API Key 和项目。下载与使用须遵守这些项目的许可证（见 README）。不会发起付费 Wan 请求。",
        });
        if (result.response !== 1) return { canceled: true };
        const config = await runtime.install(mode);
        for (const name of ["settings.json", "workflow.json"]) {
          const original = path.join(root(), name);
          if (
            await fs.access(original).then(
              () => true,
              () => false,
            )
          )
            await fs.copyFile(
              original,
              original + ".before-setup-" + Date.now() + ".bak",
            );
        }
        await save(path.join(root(), "settings.json"), {
          ...(await settings()),
          ...config,
        });
        await save(path.join(root(), "workflow.json"), defaultWorkflow());
        emit(
          "环境已连接！填写并保存 Wan Key、区域、价格和预算后，即可输入故事一键生成。",
        );
        return { ready: true };
      } finally {
        busy = false;
      }
    });
    ipcMain.handle("settings:save", async (_, value) => {
      if (busy) throw Error("Wait until generation finishes");
      const config = {};
      for (const k of Object.keys(defaults))
        config[k] = value[k] ?? defaults[k];
      if (value.key) {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === "linux" &&
            safeStorage.getSelectedStorageBackend() === "basic_text")
        )
          throw Error("Secure credential storage unavailable");
        await fs.writeFile(
          path.join(root(), "key.bin"),
          safeStorage.encryptString(value.key),
          { mode: 0o600 },
        );
      }
      await save(path.join(root(), "settings.json"), config);
      return true;
    });
    ipcMain.handle("projects:list", async () => {
      const dir = path.join(root(), "projects");
      await fs.mkdir(dir, { recursive: true });
      const names = await fs.readdir(dir);
      const projects = [];
      for (const id of names) {
        projects.push(await read(projectPath(id), null));
      }
      return projects.filter(Boolean);
    });
    ipcMain.handle("project:create", async (_, input) => {
      if (busy) throw Error("Generation is running");
      const p = {
        id: crypto.randomUUID(),
        name: String(input.name || "Untitled").slice(0, 100),
        scenes: input.scenes.map((s) => ({
          prompt: s.prompt,
          image: s.image || "",
          imagePrompt: s.imagePrompt || "",
          narration: s.narration || "",
          localImage: s.localImage || "",
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
        if (scene.localImage) {
          const target = path.join(folder, `image-${i}.png`);
          const img = nativeImage.createFromPath(scene.localImage);
          if (img.isEmpty()) throw Error("Cannot read selected image");
          await fs.writeFile(target, img.toPNG());
          scene.localImage = target;
        }
      }
      await save(projectPath(p.id), p);
      return p;
    });
    ipcMain.handle("local:check", async () => {
      await ensureManaged();
      return checkServices(await settings());
    });
    ipcMain.handle("story:generate", async (_, idea, count) => {
      if (busy) throw Error("Another operation is running");
      busy = true;
      try {
        await ensureManaged();
        emit("Ollama is generating the screenplay…");
        return await storyboard(idea, Number(count), await settings());
      } finally {
        busy = false;
      }
    });
    ipcMain.handle("image:pick", async () => {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
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
    ipcMain.handle("project:update", async (_, id, scenes) => {
      if (busy) throw Error("Generation is running");
      const file = projectPath(id),
        p = await read(file, null);
      if (!p) throw Error("Missing project");
      if (scenes.length !== p.scenes.length)
        throw Error("Scene count cannot change in saved projects");
      for (let i = 0; i < scenes.length; i++) {
        const old = p.scenes[i],
          next = scenes[i];
        if (old.taskId || old.uncertain) {
          if (
            next.prompt !== old.prompt ||
            next.image !== (old.image || "") ||
            next.imagePrompt !== (old.imagePrompt || "") ||
            next.localImage !== (old.localImage || "")
          )
            throw Error(
              "Submitted scene visuals are locked; create a new project to change them",
            );
        } else {
          if (next.imagePrompt !== old.imagePrompt) {
            delete old.comfyId;
            if (!next.localImage) old.localImage = "";
          }
          old.prompt = next.prompt;
          old.image = next.image;
          old.imagePrompt = next.imagePrompt;
          if (next.localImage && next.localImage !== old.localImage) {
            const target = path.join(
              path.dirname(file),
              `image-${i}-${crypto.randomUUID()}.png`,
            );
            const img = nativeImage.createFromPath(next.localImage);
            if (img.isEmpty()) throw Error("Cannot read selected image");
            await fs.writeFile(target, img.toPNG());
            old.localImage = target;
          } else old.localImage = next.localImage || "";
        }
        old.narration = String(next.narration || "").slice(0, 2000);
      }
      await save(file, p);
      return p;
    });
    ipcMain.handle("project:open", async (_, id) => {
      await shell.openPath(path.dirname(projectPath(id)));
    });
    ipcMain.handle("project:run", async (_, id) => {
      if (busy) throw Error("Another project is running");
      busy = true;
      try {
        const file = projectPath(id),
          p = await read(file, null);
        if (!p) throw Error("Project not found");
        const cfg = await settings();
        const estimate = validate(p, cfg);
        await run(cfg.ffmpeg, ["-version"]);
        await run(cfg.ffprobe, ["-version"]);
        const needsComfy = p.scenes.some(
          (s) => !s.taskId && !s.clip && !s.localImage && !s.image,
        );
        if (needsComfy) await ensureManaged();
        const workflow = needsComfy
          ? await read(path.join(root(), "workflow.json"), null)
          : null;
        if (needsComfy && !workflow)
          throw Error("Import a ComfyUI API workflow first, or provide images");
        if (workflow) prepareWorkflow(workflow, "preflight");
        const needsCloud = p.scenes.some((s) => !s.clip);
        const key = needsCloud
          ? safeStorage.decryptString(
              await fs.readFile(path.join(root(), "key.bin")),
            )
          : "";
        const count = p.scenes.filter((s) => !s.taskId && !s.clip).length;
        if (count) {
          const result = await dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["Cancel", "Approve paid generation"],
            defaultId: 0,
            cancelId: 0,
            message: `Submit ${count} paid Wan jobs?`,
            detail: `Estimated additional cost: ${estimate.toFixed(2)}. Project reserved: ${Number(p.reserved).toFixed(2)}. Budget: ${cfg.budget}. Local/generated images will be uploaded to Alibaba temporary storage (48-hour validity). All amounts use the currency of your entered unit price. Estimates are not billing guarantees. Verify current provider pricing.`,
          });
          if (result.response !== 1) return { canceled: true };
        }
        const wan = new Wan(cfg, key),
          folder = path.dirname(file);
        for (let i = 0; i < p.scenes.length; i++) {
          const s = p.scenes[i];
          if (s.clip) {
            await fs.access(path.join(folder, s.clip));
            continue;
          }
          if (s.uncertain)
            throw Error(
              `Scene ${i + 1} has an uncertain submission. Check Alibaba console before creating a replacement project.`,
            );
          if (!s.taskId) {
            if (!s.localImage && !s.image) {
              const comfy = new Comfy(cfg);
              if (!s.comfyId) {
                emit(`ComfyUI: generating scene ${i + 1}…`);
                s.comfyId = await comfy.submit(workflow, s.imagePrompt);
                await save(file, p);
              }
              const target = path.join(folder, `image-${i}.png`);
              await comfy.image(s.comfyId, target);
              s.localImage = target;
              await save(file, p);
            }
            let remoteImage = s.image;
            if (s.localImage) {
              emit(`Uploading scene ${i + 1} image…`);
              remoteImage = await wan.upload(s.localImage);
            }
            s.uncertain = true;
            p.reserved += 5 * Number(cfg.pricePerSecond);
            await save(file, p);
            emit(`Submitting scene ${i + 1}…`);
            s.taskId = await wan.submit({ ...s, image: remoteImage });
            s.region = cfg.region;
            s.model = cfg.model;
            s.uncertain = false;
            await save(file, p);
          }
          if (s.region !== cfg.region)
            throw Error(
              "Switch settings back to the region used for this task",
            );
          const url = await wan.poll(s.taskId, (status) =>
            emit(`Scene ${i + 1}/${p.scenes.length}: ${status}`),
          );
          emit(`Downloading scene ${i + 1}…`);
          s.clip = `clip-${i + 1}.mp4`;
          try {
            await download(url, path.join(folder, s.clip));
          } catch (e) {
            delete s.clip;
            throw e;
          }
          await save(file, p);
        }
        emit("Merging clips with FFmpeg…");
        p.output = await merge(
          p.scenes.map((s) => path.join(folder, s.clip)),
          folder,
          cfg,
        );
        if (p.scenes.some((s) => s.narration?.trim())) {
          emit("Adding subtitles and optional Windows narration…");
          p.output = await finish(p, folder, cfg);
        }
        await save(file, p);
        emit("Finished: " + p.output);
        return p;
      } finally {
        busy = false;
      }
    });
  });
app.on("before-quit", (e) => {
  if (busy) {
    e.preventDefault();
    emit(
      "A job is active. Keep this window open until it finishes or reports an error.",
    );
  }
});
app.on("window-all-closed", () => {
  if (!busy) app.quit();
});

app.on("will-quit", () => {
  gateway?.stop();
  runtime?.stop();
});
