const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ENDPOINTS = {
  china: "https://dashscope.aliyuncs.com",
  international: "https://dashscope-intl.aliyuncs.com",
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Wan {
  constructor(settings, key, fetcher = fetch, pause = delay) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
    this.pause = pause;
  }
  async request(route, body) {
    const response = await this.fetch(ENDPOINTS[this.settings.region] + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(body
          ? {
              "X-DashScope-Async": "enable",
              "X-DashScope-OssResourceResolve": "enable",
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const error = new Error(
        `Wan HTTP ${response.status}. Check region, model, quota and credentials.`,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    const data = await response.json();
    if (data.code) throw new Error(`Wan: ${data.code}`);
    return data;
  }
  async upload(file) {
    const content = await fs.readFile(file);
    if (content.length > 20 * 1024 * 1024) throw Error("Image exceeds 20 MB");
    const policy = (
      await this.request(
        "/api/v1/uploads?action=getPolicy&model=" +
          encodeURIComponent(this.settings.model),
      )
    ).data;
    if (
      !policy?.upload_host ||
      new URL(policy.upload_host).protocol !== "https:"
    )
      throw Error("Invalid upload policy");
    const key =
      policy.upload_dir +
      "/" +
      require("node:crypto").randomUUID() +
      path.extname(file);
    const form = new FormData();
    for (const [name, value] of Object.entries({
      OSSAccessKeyId: policy.oss_access_key_id,
      Signature: policy.signature,
      policy: policy.policy,
      "x-oss-object-acl": policy.x_oss_object_acl,
      "x-oss-forbid-overwrite": policy.x_oss_forbid_overwrite,
      key,
      success_action_status: "200",
    }))
      form.append(name, value);
    form.append("file", new Blob([content]), path.basename(key));
    const r = await this.fetch(policy.upload_host, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw Error("Image upload failed: HTTP " + r.status);
    return "oss://" + key;
  }
  async submit(scene) {
    // Never retry POST automatically: a lost response may still have created a paid job.
    const data = await this.request(
      "/api/v1/services/aigc/video-generation/video-synthesis",
      {
        model: this.settings.model,
        input: { prompt: scene.prompt, img_url: scene.image },
        parameters: { resolution: "720P", duration: 5, prompt_extend: true },
      },
    );
    if (!data.output?.task_id)
      throw new Error(
        "Wan returned no task ID. Check provider console before retrying.",
      );
    return data.output.task_id;
  }
  async poll(id, progress) {
    for (let i = 0; i < 360; i++) {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          data = await this.request("/api/v1/tasks/" + encodeURIComponent(id));
          break;
        } catch (error) {
          if (!error.retryable || attempt === 3) throw error;
          await this.pause(1000 * 2 ** attempt);
        }
      }
      const out = data.output || {};
      progress(out.task_status || "UNKNOWN");
      if (out.task_status === "SUCCEEDED") {
        if (!out.video_url) throw new Error("Missing video URL");
        return out.video_url;
      }
      if (["FAILED", "CANCELED", "UNKNOWN"].includes(out.task_status))
        throw new Error(
          `Task ${out.task_status}: ${out.code || "see provider console"}`,
        );
      await this.pause(10000);
    }
    throw new Error(
      "Polling timed out. Resume this task later; do not resubmit.",
    );
  }
}
const CLIP_SECONDS = { wan: 5, veo: 8 };
class Veo {
  constructor(settings, key, fetcher = fetch, pause = delay) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
    this.pause = pause;
  }
  async request(path, method, body) {
    const response = await this.fetch(
      "https://generativelanguage.googleapis.com/v1beta/" + path,
      {
        method,
        headers: {
          "x-goog-api-key": this.key,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) {
      const error = new Error(
        `Veo HTTP ${response.status}. Check model, quota and credentials.`,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return response.json();
  }
  async submit(scene) {
    // Never retry POST automatically: a lost response may still have created a paid job.
    const data = await this.request(
      `models/${this.settings.veoModel}:predictLongRunning`,
      "POST",
      {
        instances: [{ prompt: scene.prompt }],
        parameters: { aspectRatio: "16:9" },
      },
    );
    if (!/^models\/[\w.-]+\/operations\/[\w-]+$/.test(data.name || ""))
      throw new Error(
        "Veo returned no valid operation name. Check provider console before retrying.",
      );
    return data.name;
  }
  async poll(id, progress) {
    for (let i = 0; i < 360; i++) {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          data = await this.request(id, "GET");
          break;
        } catch (error) {
          if (!error.retryable || attempt === 3) throw error;
          await this.pause(1000 * 2 ** attempt);
        }
      }
      progress(data.done ? "DONE" : "PENDING");
      if (data.done) {
        if (data.error)
          throw new Error(
            `Veo operation failed: ${data.error.message || "see provider console"}`,
          );
        const uri =
          data.response?.generateVideoResponse?.generatedSamples?.[0]?.video
            ?.uri;
        if (
          !uri ||
          !uri.startsWith("https://generativelanguage.googleapis.com/")
        )
          throw new Error("Veo returned an unexpected video location");
        return uri;
      }
      await this.pause(10000);
    }
    throw new Error(
      "Polling timed out. Resume this task later; do not resubmit.",
    );
  }
  async download(uri, destination) {
    const response = await this.fetch(uri, {
      headers: { "x-goog-api-key": this.key },
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Veo download HTTP ${response.status}`);
    await streamToFile(response, destination);
  }
}
class SelfHosted {
  constructor(settings, key, fetcher = fetch) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
  }
  async generate(scene, destination) {
    const base = new URL(this.settings.selfHostedUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
      throw new Error("Invalid self-hosted inference URL");
    const response = await this.fetch(base.origin + "/generate", {
      method: "POST",
      headers: {
        "X-Inference-Key": this.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: scene.prompt }),
      signal: AbortSignal.timeout(1800000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Self-hosted video HTTP ${response.status}`);
    await streamToFile(response, destination);
  }
}
function validate(project, settings) {
  const provider = settings.videoProvider || "wan";
  if (!CLIP_SECONDS[provider] && provider !== "selfHosted")
    throw new Error("Invalid video provider");
  if (
    provider === "wan" &&
    !settings.localVideo &&
    (!ENDPOINTS[settings.region] || !/^wan[\w.-]+$/.test(settings.model))
  )
    throw new Error("Invalid Wan region or model");
  if (provider === "veo" && !/^veo[\w.-]+$/.test(settings.veoModel))
    throw new Error("Invalid Veo model");
  if (provider === "selfHosted") {
    try {
      const url = new URL(settings.selfHostedUrl);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error();
    } catch {
      throw new Error("Invalid self-hosted inference URL");
    }
  }
  if (
    !Array.isArray(project.scenes) ||
    !project.scenes.length ||
    project.scenes.length > 50
  )
    throw new Error("Provide 1–50 scenes");
  for (const scene of project.scenes) {
    if (
      typeof scene.prompt !== "string" ||
      !scene.prompt.trim() ||
      scene.prompt.length > 2000
    )
      throw new Error("Each scene needs a prompt of at most 2000 characters");
    // Only Wan consumes a scene image; Veo and self-hosted generate from the prompt alone.
    if (provider !== "wan") continue;
    if (scene.localImage || (!scene.image && scene.imagePrompt)) continue;
    let url;
    try {
      url = new URL(scene.image);
    } catch {
      throw new Error("Each scene needs a public HTTPS image URL");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Use public HTTPS image URLs");
  }
  if (provider === "selfHosted" || (provider === "wan" && settings.localVideo))
    return 0;
  const rate = Number(settings.pricePerSecond),
    budget = Number(settings.budget);
  if (
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isFinite(budget) ||
    budget <= 0
  )
    throw new Error("Enter a positive price per second and budget");
  const estimate =
    project.scenes.filter((s) => !s.taskId && !s.clip).length *
    CLIP_SECONDS[provider] *
    rate;
  if (Number(project.reserved || 0) + estimate > budget + 1e-8)
    throw new Error(
      "Project budget exceeded. Review reserved spend and pricing.",
    );
  return estimate;
}
async function streamToFile(response, destination) {
  const { Readable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  const temporary = destination + ".part";
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      require("node:fs").createWriteStream(temporary),
    );
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
async function download(url, destination, fetcher = fetch) {
  if (new URL(url).protocol !== "https:") throw new Error("Unsafe video URL");
  const response = await fetcher(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body)
    throw new Error(`Download HTTP ${response.status}`);
  await streamToFile(response, destination);
}
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false });
    let output = "";
    child.stdout.on("data", (d) => (output = (output + d).slice(-100000)));
    child.stderr.on("data", (d) => (output = (output + d).slice(-100000)));
    child.on("error", () =>
      reject(
        new Error(
          `Cannot start ${path.basename(binary)}. Configure its executable path.`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${path.basename(binary)} failed (${code}). Check media and executable configuration.`,
            ),
          ),
    );
  });
}
async function merge(clips, folder, settings) {
  const normalized = [];
  for (let i = 0; i < clips.length; i++) {
    await run(settings.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      clips[i],
    ]);
    const target = path.join(folder, `normalized-${i}.mp4`);
    await run(settings.ffmpeg, [
      "-y",
      "-i",
      clips[i],
      "-an",
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      target,
    ]);
    normalized.push(target);
  }
  const list = path.join(folder, "concat.txt");
  await fs.writeFile(
    list,
    normalized
      .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n"),
  );
  const output = path.join(folder, "final.mp4");
  await run(settings.ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    output,
  ]);
  return output;
}
module.exports = { Wan, Veo, SelfHosted, CLIP_SECONDS, validate, download, merge, run };
