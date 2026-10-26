const fs = require("node:fs/promises");
const nodefs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { run } = require("./engine");
const {PHOTO,photoWorkflow,ensurePhotoAssets}=require("./photo-model");
const SOURCES = {
  ollama: {
    url: "https://github.com/ollama/ollama/releases/download/v0.40.9/ollama-windows-amd64.zip",
    sha: "c35019c95679eae1cb28fda4732a7c97978b9fbcbd8adfb5cbcc8fe7c161ea0b",
  },
  comfy: {
    url: "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.42.1/ComfyUI_windows_portable_nvidia.7z",
    sha: "496afd18790ec685d99ebba2edf200d7371a29fbdd3a992bb0f4f52f244a6874",
  },
  ffmpeg: {
    url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
    sha: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
  },
  seven: {
    url: "https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe",
    sha: "9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7",
  },
  imageModel: PHOTO.checkpoint,
};
const MODEL = "qwen2.5:1.5b",
  CHECKPOINT = "v1-5-pruned-emaonly.safetensors";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of nodefs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function asset(source, target, report = () => {}, fetcher = fetch) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) {
    if ((await digest(target)) === source.sha) return target;
    throw Error(
      "Installed download checksum mismatch: " + path.basename(target),
    );
  }
  const part = target + ".part";
  let size = await fs.stat(part).then(
    (s) => s.size,
    () => 0,
  );
  if (size && (await digest(part)) === source.sha) {
    await fs.rename(part, target);
    return target;
  }
  const response = await fetcher(source.url, {
    headers: size ? { Range: `bytes=${size}-` } : {},
    signal: AbortSignal.timeout(7200000),
  });
  if (!response.ok)
    throw Error(
      `Download failed (${response.status}): ${new URL(source.url).hostname}. Retry setup to continue.`,
    );
  if (size && response.status === 206) {
    if (!response.headers.get("content-range")?.startsWith(`bytes ${size}-`))
      throw Error("Invalid download resume response");
  } else size = 0;
  const total = Number(response.headers.get("content-length") || 0) + size;
  const handle = await fs.open(part, size ? "a" : "w");
  let last = 0;
  try {
    for await (const chunk of response.body) {
      await handle.writeFile(chunk);
      size += chunk.length;
      if (Date.now() - last > 1000) {
        report(
          `下载 ${path.basename(target)}: ${(size / 1048576).toFixed(0)} / ${total ? (total / 1048576).toFixed(0) : "?"} MB`,
        );
        last = Date.now();
      }
    }
  } finally {
    await handle.close();
  }
  report("校验 " + path.basename(target) + "…");
  if ((await digest(part)) !== source.sha) {
    await fs.rm(part, { force: true });
    throw Error("Download checksum failed; retry setup");
  }
  await fs.rename(part, target);
  return target;
}
function managedSettings(root) {
  const tools = path.join(root, "tools");
  return {
    ollamaUrl: "http://127.0.0.1:11435",
    ollamaModel: MODEL,
    comfyUrl: "http://127.0.0.1:18188",
    ffmpeg: path.join(
      tools,
      "ffmpeg",
      "ffmpeg-9.0.2-essentials_build",
      "bin",
      "ffmpeg.exe",
    ),
    ffprobe: path.join(
      tools,
      "ffmpeg",
      "ffmpeg-9.0.2-essentials_build",
      "bin",
      "ffprobe.exe",
    ),
  };
}
function workflow(){return photoWorkflow();}

class Runtime {
  constructor(root, report = () => {}) {
    this.root = root;
    this.report = report;
    this.children = [];
    this.starting = null;
  }
  async ready(url) {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      return false;
    }
  }
  launch(binary, args, env = {}) {
    const log = nodefs.openSync(
      path.join(this.root, "local-services.log"),
      "a",
    );
    const child = spawn(binary, args, {
      cwd: path.dirname(binary),
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env },
    });
    nodefs.closeSync(log);
    child.on("error", (error) => {
      child.launchError = error;
      this.report("本地服务未能启动，请重新运行环境配置。");
    });
    this.children.push(child);
    return child;
  }
  async wait(url, child) {
    for (let i = 0; i < 120; i++) {
      if (await this.ready(url)) return;
      if (child.launchError || child.exitCode !== null)
        throw Error(
          "Local AI exited. See local-services.log in the application data folder.",
        );
      await pause(2000);
    }
    throw Error("Local AI startup timed out; retry. Check local-services.log.");
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async startInternal() {
    const setupFile = path.join(this.root, "setup.json");
    if (!(await exists(setupFile))) return;
    const state = JSON.parse(await fs.readFile(setupFile, "utf8"));
    if (!state.installed) return;
    const tools = path.join(this.root, "tools"),
      cfg = managedSettings(this.root);
    if (!(await this.ready(cfg.ollamaUrl + "/api/tags"))) {
      this.report("正在启动内置 Ollama 服务…");
      const child = this.launch(
        path.join(tools, "ollama", "ollama.exe"),
        ["serve"],
        {
          OLLAMA_HOST: "127.0.0.1:11435",
          OLLAMA_MODELS: path.join(tools, "ollama-models"),
        },
      );
      await this.wait(cfg.ollamaUrl + "/api/tags", child);
    }
    if (!(await this.ready(cfg.comfyUrl + "/system_stats"))) {
      this.report("正在启动内置 ComfyUI 服务…");
      const portable = path.join(tools, "comfy", "ComfyUI_windows_portable");
      const child = this.launch(
        path.join(portable, "python_embeded", "python.exe"),
        [
          "-s",
          path.join(portable, "ComfyUI", "main.py"),
          "--windows-standalone-build",
          "--listen",
          "127.0.0.1",
          "--port",
          "18188",
          ...(state.mode === "nvidia" ? [] : ["--cpu"]),
        ],
      );
      await this.wait(cfg.comfyUrl + "/system_stats", child);
    }
  }
  async install(mode = "cpu") {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw Error("Automatic setup requires Windows x64");
    if (!["cpu", "nvidia"].includes(mode)) throw Error("Invalid hardware mode");
    await fs.mkdir(this.root, { recursive: true });
    const space = await fs.statfs(this.root);
    if (
      !(await exists(path.join(this.root, "tools"))) &&
      Number(space.bavail) * Number(space.bsize) < 25 * 1024 ** 3
    )
      throw Error("Setup requires at least 25 GB free disk space");
    const tools = path.join(this.root, "tools"),
      cache = path.join(tools, "downloads");
    await fs.mkdir(cache, { recursive: true });
    for (const [name, ext] of [
      ["ollama", "zip"],
      ["ffmpeg", "zip"],
      ["comfy", "7z"],
    ]) {
      const folder = path.join(tools, name),
        marker = path.join(folder, ".installed");
      const expected = {
        ollama: ["ollama.exe"],
        ffmpeg: [
          "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe",
          "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe",
        ],
        comfy: [
          "ComfyUI_windows_portable/python_embeded/python.exe",
          "ComfyUI_windows_portable/ComfyUI/main.py",
        ],
      }[name];
      const intact = async () =>
        (
          await Promise.all(
            expected.map((file) => exists(path.join(folder, file))),
          )
        ).every(Boolean);
      if ((await exists(marker)) && (await intact())) continue;
      const archive = await asset(
        SOURCES[name],
        path.join(cache, name + "." + ext),
        this.report,
      );
      await fs.mkdir(folder, { recursive: true });
      this.report("解压 " + name + "，请稍候…");
      if (ext === "7z") {
        const exe = await asset(
          SOURCES.seven,
          path.join(cache, "7zr.exe"),
          this.report,
        );
        await run(exe, ["x", archive, "-o" + folder, "-y"]);
      } else await run("tar.exe", ["-xf", archive, "-C", folder]);
      if (!(await intact()))
        throw Error("Archive layout changed or extraction incomplete: " + name);
      await fs.writeFile(marker, SOURCES[name].sha);
      await fs.rm(archive, { force: true });
    }
    await ensurePhotoAssets(path.join(tools,"comfy","ComfyUI_windows_portable","ComfyUI"),{download:asset,report:this.report});
    // Installed records only mean files exist; ready is written after services and model pull succeed.
    await fs.writeFile(
      path.join(this.root, "setup.json"),
      JSON.stringify({ installed: true, ready: false, mode }),
    );
    await this.start();
    const cfg = managedSettings(this.root);
    this.report("正在下载 Ollama 剧本模型（首次约 1 GB）…");
    const response = await fetch(cfg.ollamaUrl + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream: true }),
      signal: AbortSignal.timeout(7200000),
    });
    if (!response.ok) throw Error("Ollama model download failed; retry setup");
    let pending = "",
      last = 0,
      success = false;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.error) throw Error("Ollama: " + item.error);
        if (item.status === "success") success = true;
        if (Date.now() - last > 1000) {
          this.report(
            `剧本模型: ${item.status}${item.total ? " " + Math.round((100 * (item.completed || 0)) / item.total) + "%" : ""}`,
          );
          last = Date.now();
        }
      }
    }
    if (!success) throw Error("Model pull did not complete; retry setup");
    await fs.writeFile(
      path.join(this.root, "setup.json"),
      JSON.stringify({ installed: true, ready: true, mode }),
    );
    return cfg;
  }
  stop() {
    for (const child of this.children)
      if (child.exitCode === null) child.kill();
    this.children = [];
  }
}
module.exports = { Runtime, asset, workflow, managedSettings, SOURCES };
