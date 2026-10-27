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
  // Draws a picture from text with Wan on Alibaba Cloud; billed per image, failed images are free.
  async submitImage(prompt) {
    const data = await this.request(
      "/api/v1/services/aigc/text2image/image-synthesis",
      {
        model: this.settings.imageModel || "wan2.2-t2i-flash",
        input: {
          prompt,
          negative_prompt: "blurry, distorted, watermark, text",
        },
        parameters: { size: "1280*720", n: 1 },
      },
    );
    if (!data.output?.task_id) throw new Error("Wan returned no image task ID");
    return data.output.task_id;
  }
  async poll(id, progress, result = (out) => out.video_url) {
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
        const url = result(out);
        if (url) return url;
        const error = new Error("Wan returned no result URL");
        error.noResult = true;
        throw error;
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

// Seconds of video each paid provider returns per scene; other clips keep their own length.
const CLIP_SECONDS = { wan: 5, veo: 8 };
const sceneSeconds = (scene) => Number(scene.seconds) || 5;
// Google Veo through the Gemini API: a long-running operation that is polled like a Wan task.
class Veo {
  constructor(settings, key, fetcher = fetch, pause = delay) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
    this.pause = pause;
  }
  async request(route, body) {
    const response = await this.fetch(
      "https://generativelanguage.googleapis.com/v1beta/" + route,
      {
        method: body ? "POST" : "GET",
        headers: {
          "x-goog-api-key": this.key,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).error?.message || "";
      } catch {}
      const error = new Error(
        `Veo HTTP ${response.status}${detail ? ` (${detail.slice(0, 300)})` : ""}. Check model, quota and credentials.`,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      error.rejected = response.status >= 400 && response.status < 500;
      throw error;
    }
    return response.json();
  }
  // The first frame is sent inline, so the scene starts from the drawn picture or the previous clip.
  async submit(scene, imageFile) {
    const instance = { prompt: scene.prompt };
    if (imageFile) {
      const content = await fs.readFile(imageFile);
      if (content.length > 20 * 1024 * 1024) throw Error("Image exceeds 20 MB");
      instance.image = {
        bytesBase64Encoded: content.toString("base64"),
        mimeType: /\.jpe?g$/i.test(imageFile) ? "image/jpeg" : "image/png",
      };
    }
    // Never retry POST automatically: a lost response may still have created a paid job.
    const data = await this.request(
      `models/${this.settings.veoModel}:predictLongRunning`,
      { instances: [instance], parameters: { aspectRatio: "16:9" } },
    );
    if (!/^models\/[\w.-]+\/operations\/[\w-]+$/.test(data.name || ""))
      throw new Error(
        "Veo returned no operation name. Check provider console before retrying.",
      );
    return data.name;
  }
  async poll(id, progress) {
    for (let i = 0; i < 360; i++) {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          data = await this.request(id);
          break;
        } catch (error) {
          if (!error.retryable || attempt === 3) throw error;
          await this.pause(1000 * 2 ** attempt);
        }
      }
      progress(data.done ? "DONE" : "RUNNING");
      if (data.done) {
        const uri =
          data.response?.generateVideoResponse?.generatedSamples?.[0]?.video
            ?.uri;
        if (data.error || !uri) {
          // A finished operation without a video (failed or filtered) can never deliver one.
          const error = new Error(
            `Task FAILED: ${data.error?.message || "Veo returned no video"}`,
          );
          error.taskStatus = "FAILED";
          throw error;
        }
        if (!uri.startsWith("https://generativelanguage.googleapis.com/"))
          throw new Error("Veo returned an unexpected video location");
        return uri;
      }
      await this.pause(10000);
    }
    throw new Error(
      "Polling timed out. Resume this task later; do not resubmit.",
    );
  }
  // Veo video links need the API key, unlike Wan's signed URLs.
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
// Zhipu CogVideoX-Flash on open.bigmodel.cn: free, asynchronous like Wan.
class Zhipu {
  constructor(settings, key, fetcher = fetch, pause = delay) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
    this.pause = pause;
  }
  async request(route, body) {
    const response = await this.fetch(
      "https://open.bigmodel.cn/api/paas/v4" + route,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) {
      let detail = "";
      try {
        const data = await response.json();
        detail = [data.error?.code, data.error?.message]
          .filter(Boolean)
          .join(": ");
      } catch {}
      const error = new Error(
        `智谱 HTTP ${response.status}${detail ? ` (${detail.slice(0, 300)})` : ""}。请检查 API Key、模型名称和账号额度。`,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      error.rejected = response.status >= 400 && response.status < 500;
      throw error;
    }
    return response.json();
  }
  // The first frame goes inline as Base64, so continuous shots keep the same characters.
  async submit(scene, imageFile) {
    const body = { model: this.settings.zhipuModel, prompt: scene.prompt };
    if (imageFile) {
      const content = await fs.readFile(imageFile);
      if (content.length > 5 * 1024 * 1024) throw Error("Image exceeds 5 MB");
      body.image_url = `data:${/\.jpe?g$/i.test(imageFile) ? "image/jpeg" : "image/png"};base64,${content.toString("base64")}`;
    }
    const data = await this.request("/videos/generations", body);
    if (!data.id) throw new Error("智谱没有返回任务 ID");
    return data.id;
  }
  async poll(id, progress) {
    for (let i = 0; i < 360; i++) {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          data = await this.request("/async-result/" + encodeURIComponent(id));
          break;
        } catch (error) {
          if (!error.retryable || attempt === 3) throw error;
          await this.pause(1000 * 2 ** attempt);
        }
      }
      progress(data.task_status || "UNKNOWN");
      if (data.task_status === "SUCCESS") {
        const url = data.video_result?.find((v) => v.url)?.url;
        if (url) return url;
        const error = new Error("智谱没有返回视频地址");
        error.taskStatus = "FAILED";
        throw error;
      }
      if (data.task_status === "FAIL") {
        const error = new Error(
          "Task FAILED: 智谱生成失败，可能是提示词或图片没有通过审核",
        );
        error.taskStatus = "FAILED";
        throw error;
      }
      await this.pause(10000);
    }
    throw new Error(
      "Polling timed out. Resume this task later; do not resubmit.",
    );
  }
}
// A GPU server you run yourself (e.g. Wan2.1 or LTX-Video): POST /generate returns the MP4.
class SelfHosted {
  constructor(settings, key, fetcher = fetch) {
    this.settings = settings;
    this.key = key;
    this.fetch = fetcher;
  }
  async generate(scene, destination) {
    const base = new URL(this.settings.selfHostedUrl);
    const response = await this.fetch(base.origin + "/generate", {
      method: "POST",
      headers: {
        ...(this.key ? { "X-Inference-Key": this.key } : {}),
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
  if (!ENDPOINTS[settings.region]) throw new Error("Invalid Wan region");
  if (provider === "wan" && !/^wan[\w.-]+$/.test(settings.model))
    throw new Error("Invalid Wan model");
  if (provider === "veo" && !/^veo[\w.-]+$/.test(settings.veoModel || ""))
    throw new Error("Invalid Veo model");
  if (
    provider === "zhipu" &&
    !/^cogvideox[\w.-]*$/i.test(settings.zhipuModel || "")
  )
    throw new Error("Invalid Zhipu model");
  // Free and self-hosted providers can also work from the prompt alone, and so can
  // Veo when no pictures are drawn.
  const textOnly =
    provider === "selfHosted" ||
    provider === "zhipu" ||
    (provider === "veo" && settings.imageSource === "none");
  if (provider === "selfHosted") {
    let url;
    try {
      url = new URL(settings.selfHostedUrl);
    } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username)
      throw new Error("Invalid self-hosted server address");
  } else if (!CLIP_SECONDS[provider] && provider !== "zhipu")
    throw new Error("Invalid video provider");
  if (
    !Array.isArray(project.scenes) ||
    !project.scenes.length ||
    project.scenes.length > 50
  )
    throw new Error("Provide 1–50 scenes");
  for (const [i, scene] of project.scenes.entries()) {
    if (
      typeof scene.prompt !== "string" ||
      !scene.prompt.trim() ||
      scene.prompt.length > 2000
    )
      throw new Error("Each scene needs a prompt of at most 2000 characters");
    if (textOnly || scene.localImage || (i > 0 && scene.continuePrevious))
      continue;
    if (!scene.image && settings.imageSource === "none")
      throw new Error(
        `镜头 ${i + 1} 没有图片，阿里云 Wan 要有图片才能生成视频。请把“图片由谁画”改成阿里云万相或本机 ComfyUI，或给这个镜头选择本地图片。`,
      );
    if (!scene.image && scene.imagePrompt) continue;
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
  // Resuming or re-exporting submitted scenes spends nothing new; Zhipu's free model and
  // your own server are not billed here.
  if (!pending || !CLIP_SECONDS[provider]) return 0;
  const rate = Number(settings.pricePerSecond),
    budget = Number(settings.budget);
  if (
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isFinite(budget) ||
    budget <= 0
  )
    throw new Error("Enter a positive price per second and budget");
  const estimate = pending * CLIP_SECONDS[provider] * rate;
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
  await streamToFile(response, destination);
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
// Saves the final frame of a clip, so the next scene can start exactly where it ends.
async function lastFrame(clip, target, settings) {
  await run(settings.ffmpeg, [
    "-y",
    "-sseof",
    "-1",
    "-i",
    clip,
    "-update",
    "1",
    target,
  ]);
  return target;
}
// Every clip is cut or padded to its scene's length, so subtitles and narration never drift.
async function merge(clips, folder, settings, seconds = clips.map(() => 5)) {
  const normalized = [];
  for (let i = 0; i < clips.length; i++) {
    await probe(clips[i], settings);
    const target = path.join(folder, `normalized-${i}.mp4`);
    await run(settings.ffmpeg, [
      "-y",
      "-i",
      clips[i],
      "-an",
      "-vf",
      `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=${seconds[i]}`,
      "-t",
      String(seconds[i]),
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
module.exports = {
  ENDPOINTS,
  Wan,
  Veo,
  SelfHosted,
  Zhipu,
  CLIP_SECONDS,
  sceneSeconds,
  validate,
  download,
  merge,
  run,
  probe,
  lastFrame,
};
