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
      let detail = "";
      try {
        const data = await response.json();
        detail = [data.code, data.message].filter(Boolean).join(": ");
      } catch {}
      const error = new Error(
        `Wan HTTP ${response.status}${detail ? ` (${detail.slice(0, 300)})` : ""}. Check region, model, quota and credentials.`,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      // A 4xx answer means the provider refused the request, so no paid task exists.
      error.rejected = response.status >= 400 && response.status < 500;
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
      if (["FAILED", "CANCELED", "UNKNOWN"].includes(out.task_status)) {
        const error = new Error(
          `Task ${out.task_status}: ${[out.code, out.message].filter(Boolean).join(": ") || "see provider console"}`,
        );
        error.taskStatus = out.task_status;
        throw error;
      }
      await this.pause(10000);
    }
    throw new Error(
      "Polling timed out. Resume this task later; do not resubmit.",
    );
  }
}
function validate(project, settings) {
  if (!ENDPOINTS[settings.region] || !/^wan[\w.-]+$/.test(settings.model))
    throw new Error("Invalid Wan region or model");
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
  const pending = project.scenes.filter((s) => !s.taskId && !s.clip).length;
  // Resuming or re-exporting submitted scenes spends nothing new.
  if (!pending) return 0;
  const rate = Number(settings.pricePerSecond),
    budget = Number(settings.budget);
  if (
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isFinite(budget) ||
    budget <= 0
  )
    throw new Error("Enter a positive price per second and budget");
  const estimate = pending * 5 * rate;
  if (Number(project.reserved || 0) + estimate > budget + 1e-8)
    throw new Error(
      "Project budget exceeded. Review reserved spend and pricing.",
    );
  return estimate;
}
async function download(url, destination, fetcher = fetch) {
  if (new URL(url).protocol !== "https:") throw new Error("Unsafe video URL");
  const response = await fetcher(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body)
    throw new Error(`Download HTTP ${response.status}`);
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
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Resolve with stdout only, so warnings on stderr cannot corrupt JSON output.
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (output = (output + d).slice(-100000)));
    child.stderr.on("data", (d) => (errors = (errors + d).slice(-100000)));
    child.on("error", () =>
      reject(
        new Error(
          `Cannot start ${path.basename(binary)}. Configure its executable path.`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve(output);
      const detail = (errors || output)
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" | ")
        .slice(-500);
      reject(
        new Error(
          `${path.basename(binary)} failed (${code})${detail ? ": " + detail : ". Check media and executable configuration."}`,
        ),
      );
    });
  });
}
async function probe(file, settings) {
  const info = JSON.parse(
    await run(settings.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type:format=duration",
      "-of",
      "json",
      file,
    ]),
  );
  if (!info.streams?.some((s) => s.codec_type === "video"))
    throw new Error(`${path.basename(file)} contains no video stream`);
  return Number(info.format?.duration) || 0;
}
async function merge(clips, folder, settings) {
  const normalized = [];
  for (let i = 0; i < clips.length; i++) {
    await probe(clips[i], settings);
    const target = path.join(folder, `normalized-${i}.mp4`);
    // Every scene lasts exactly 5 s so subtitles and narration never drift.
    await run(settings.ffmpeg, [
      "-y",
      "-i",
      clips[i],
      "-an",
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=5",
      "-t",
      "5",
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
module.exports = { Wan, validate, download, merge, run, probe };
