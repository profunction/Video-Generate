const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Wan, validate, download, merge, run } = require("./engine");
const { photoWorkflow } = require("./photo-model");
const uuid = (id) =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
async function read(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function save(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + ".tmp", JSON.stringify(data, null, 2));
  await fs.rename(file + ".tmp", file);
}
function videoWorkflow(jobKey = crypto.randomUUID()) {
  const graph = photoWorkflow();
  graph["4"].inputs.batch_size = 2;
  graph["9"] = {
    class_type: "VG_WanFiveSecondClips",
    inputs: {
      images: ["7", 0],
      motion_prompt:
        "Slow camera movement, natural subject motion. Preserve the image composition and character appearance.",
      job_key: jobKey,
    },
  };
  graph["10"] = { class_type: "VG_MergeClips", inputs: { manifest: ["9", 0] } };
  return graph;
}
class FlowJobs {
  constructor({
    root,
    settings,
    getKey,
    approve,
    report = () => {},
    normalizeImage,
    wanClass = Wan,
    downloadFile = download,
    mergeFiles = merge,
    checkTools = async (cfg) => {
      await run(cfg.ffmpeg, ["-version"]);
      await run(cfg.ffprobe, ["-version"]);
    },
  }) {
    Object.assign(this, {
      root,
      settings,
      getKey,
      approve,
      report,
      normalizeImage,
      wanClass,
      downloadFile,
      mergeFiles,
      checkTools,
    });
  }
  file(id) {
    if (!uuid(id)) throw Error("Invalid project ID");
    return path.join(this.root, "projects", id, "project.json");
  }
  async clips(input) {
    if (
      typeof input.jobKey !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.jobKey)
    )
      throw Error(
        "job_key must use 1–80 letters, numbers, hyphens or underscores",
      );
    if (
      typeof input.motionPrompt !== "string" ||
      !input.motionPrompt.trim() ||
      input.motionPrompt.length > 2000
    )
      throw Error("Enter a motion prompt up to 2000 characters");
    if (
      !Array.isArray(input.images) ||
      !input.images.length ||
      input.images.length > 20
    )
      throw Error("Provide 1–20 images");
    const images = [];
    for (const image of input.images) {
      if (
        typeof image !== "string" ||
        image.length > 12 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image)
      )
        throw Error("Invalid or oversized PNG");
      const bytes = Buffer.from(image, "base64");
      if (
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error("PNG images are required");
      images.push(await this.normalizeImage(bytes));
    }
    const hash = crypto.createHash("sha256").update(input.motionPrompt);
    for (const bytes of images)
      hash.update(crypto.createHash("sha256").update(bytes).digest());
    const fingerprint = hash.digest("hex");
    const dir = path.join(this.root, "projects");
    await fs.mkdir(dir, { recursive: true });
    let project;
    for (const id of await fs.readdir(dir)) {
      if (!uuid(id)) continue;
      const candidate = await read(this.file(id));
      if (candidate?.flowJobKey === input.jobKey) {
        project = candidate;
        break;
      }
    }
    if (project && project.flowInputHash !== fingerprint)
      throw Error(
        "This job_key already has different images or prompts. Use a new job_key for a new video; resume the existing project in the workbench.",
      );
    if (!project) {
      const id = crypto.randomUUID();
      project = {
        id,
        name: "Flow " + input.jobKey,
        flowJobKey: input.jobKey,
        flowInputHash: fingerprint,
        reserved: 0,
        createdAt: new Date().toISOString(),
        scenes: images.map((_, i) => ({
          prompt: input.motionPrompt,
          image: "",
          narration: "",
          localImage: path.join(dir, id, `image-${i}.png`),
        })),
      };
      await fs.mkdir(path.dirname(this.file(id)), { recursive: true });
      for (let i = 0; i < images.length; i++)
        await fs.writeFile(project.scenes[i].localImage, images[i]);
      await save(this.file(id), project);
    }
    const cfg = await this.settings();
    const estimate = validate(project, cfg);
    await this.checkTools(cfg);
    if (project.scenes.some((s) => s.uncertain))
      throw Error(
        "A paid submission has uncertain status. Check Alibaba console before replacing or resubmitting it.",
      );
    for (const scene of project.scenes)
      if (scene.taskId && scene.region !== cfg.region)
        throw Error("Restore the region used by the existing task");
    const count = project.scenes.filter((s) => !s.taskId && !s.clip).length;
    const needsCloud = project.scenes.some((s) => !s.clip);
    const key = needsCloud ? await this.getKey() : "";
    if (count && !(await this.approve({ count, estimate, project, cfg })))
      throw Error("Paid generation canceled; no new Wan jobs submitted");
    const wan = new this.wanClass(cfg, key),
      folder = path.dirname(this.file(project.id));
    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];
      if (scene.clip) {
        await fs.access(path.join(folder, scene.clip));
        continue;
      }
      if (!scene.taskId) {
        this.report(`Flow: 上传第 ${i + 1} 张图片…`);
        const image = await wan.upload(scene.localImage);
        scene.uncertain = true;
        project.reserved += 5 * Number(cfg.pricePerSecond);
        await save(this.file(project.id), project);
        scene.taskId = await wan.submit({ ...scene, image });
        scene.region = cfg.region;
        scene.model = cfg.model;
        scene.uncertain = false;
        await save(this.file(project.id), project);
      }
      const url = await wan.poll(scene.taskId, (status) =>
        this.report(`Flow ${i + 1}/${project.scenes.length}: ${status}`),
      );
      const clip = `clip-${i + 1}.mp4`;
      await this.downloadFile(url, path.join(folder, clip));
      scene.clip = clip;
      await save(this.file(project.id), project);
    }
    this.report("5 秒片段已就绪，进入 MP4 合并节点…");
    return { projectId: project.id };
  }
  async combine({ projectId }) {
    const file = this.file(projectId),
      project = await read(file);
    if (!project?.flowJobKey) throw Error("Unknown Flow project");
    if (project.scenes.some((s) => !s.clip))
      throw Error("Video clips are not ready");
    const folder = path.dirname(file),
      cfg = await this.settings();
    project.output = await this.mergeFiles(
      project.scenes.map((s) => path.join(folder, s.clip)),
      folder,
      cfg,
    );
    await save(file, project);
    this.report("Flow 完成：" + project.output);
    return { projectId, output: project.output };
  }
}
class FlowGateway {
  constructor({ root, handle }) {
    this.root = root;
    this.handle = handle;
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = null;
  }
  async start() {
    this.server = http.createServer(async (req, res) => {
      const respond = (status, value) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(value));
      };
      const auth = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from("Bearer " + this.token);
      if (
        req.headers.origin ||
        auth.length !== expected.length ||
        !crypto.timingSafeEqual(auth, expected)
      ) {
        respond(403, { error: "Forbidden" });
        return;
      }
      if (
        req.method !== "POST" ||
        !["/clips", "/merge"].includes(req.url) ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        respond(400, { error: "Invalid request" });
        return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 80 * 1024 * 1024) throw Error("Payload exceeds 80 MB");
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw Error("Invalid request data");
        const result = await this.handle(req.url, input);
        respond(200, result);
      } catch (e) {
        respond(400, { error: String(e.message || "Flow failed") });
      }
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 15000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const config = {
      url: "http://127.0.0.1:" + this.server.address().port,
      token: this.token,
    };
    await fs.writeFile(
      path.join(this.root, "flow-bridge.json"),
      JSON.stringify(config),
      { mode: 0o600 },
    );
    return config;
  }
  stop() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
module.exports = { FlowJobs, FlowGateway, videoWorkflow };
