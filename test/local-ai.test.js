const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  localBase,
  storyboard,
  prepareWorkflow,
  Comfy,
} = require("../app/local-ai");
const { Wan, validate, download, merge, run } = require("../app/engine");
const { finish, subtitles } = require("../app/finish");
const workflow = {
  1: { class_type: "CLIPTextEncode", inputs: { text: "cinematic {{PROMPT}}" } },
  2: { class_type: "KSampler", inputs: { seed: 1 } },
  3: { class_type: "SaveImage", inputs: { filename_prefix: "drama" } },
};
const cfg = {
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "test",
  comfyUrl: "http://127.0.0.1:8188",
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 1,
  budget: 10,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  narration: false,
};
test("local AI cannot send story data to arbitrary remote hosts", () => {
  assert.equal(localBase(cfg.ollamaUrl), cfg.ollamaUrl);
  assert.throws(() => localBase("https://example.com"), /localhost/);
  assert.throws(() => localBase("http://secret@localhost:1234"), /localhost/);
});
test("workflow replacement preserves links, does not mutate source, rejects UI format", () => {
  const copy = prepareWorkflow(workflow, 'a "quoted" hero');
  assert.equal(copy["1"].inputs.text, 'cinematic a "quoted" hero');
  assert.equal(workflow["1"].inputs.text, "cinematic {{PROMPT}}");
  assert.throws(() => prepareWorkflow({ nodes: [] }, "x"), /API-format/);
  assert.throws(
    () => prepareWorkflow({ 1: { class_type: "SaveImage", inputs: {} } }, "x"),
    /PROMPT/,
  );
});
test("story generation validates returned scene count and structured fields", async () => {
  await assert.rejects(
    () =>
      storyboard("story", 2, cfg, async () => ({
        ok: true,
        json: async () => ({ message: { content: '{"scenes":[]}' } }),
      })),
    /count mismatch/,
  );
});
test("subtitles use scene boundaries and remove injected newlines", () => {
  const text = subtitles([
    { narration: "first\nline" },
    { narration: "second" },
  ]);
  assert.match(text, /00:00:00,000 --> 00:00:05,000/);
  assert.match(text, /00:00:05,000 --> 00:00:10,000/);
  assert.match(text, /first line/);
});
test("mock connected flow: story → ComfyUI → local image upload → Wan → real MP4 and subtitles", async (t) => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    t.skip("FFmpeg unavailable");
    return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "connected drama "));
  let submissions = 0;
  let uploads = 0;
  let comfyPolls = 0;
  try {
    const sample = path.join(folder, "source.mp4");
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:d=5",
      "-c:v",
      "libx264",
      sample,
    ]);
    const fetcher = async (url, options = {}) => {
      const u = new URL(url);
      if (u.pathname === "/api/chat") {
        const body = JSON.parse(options.body);
        assert.equal(body.model, "test");
        return {
          ok: true,
          json: async () => ({
            message: {
              content: JSON.stringify({
                title: "Drama",
                scenes: [
                  {
                    prompt: "Camera moves",
                    imagePrompt: "A clockmaker",
                    narration: "A letter arrives",
                  },
                ],
              }),
            },
          }),
        };
      }
      if (u.pathname === "/prompt") {
        assert.equal(
          JSON.parse(options.body).prompt["1"].inputs.text,
          "cinematic A clockmaker",
        );
        return {
          ok: true,
          json: async () => ({ prompt_id: "comfy-existing" }),
        };
      }
      if (u.pathname === "/history/comfy-existing") {
        comfyPolls++;
        return {
          ok: true,
          json: async () => ({
            "comfy-existing":
              comfyPolls === 1
                ? {}
                : {
                    outputs: {
                      3: {
                        images: [
                          {
                            filename: "image.png",
                            type: "output",
                            subfolder: "",
                          },
                        ],
                      },
                    },
                  },
          }),
        };
      }
      if (u.pathname === "/view")
        return { ok: true, arrayBuffer: async () => Buffer.from("mock PNG") };
      if (u.pathname === "/api/v1/uploads")
        return {
          ok: true,
          json: async () => ({
            data: {
              upload_host: "https://mock-upload.test/",
              upload_dir: "temp",
              oss_access_key_id: "id",
              signature: "sig",
              policy: "policy",
              x_oss_object_acl: "private",
              x_oss_forbid_overwrite: "true",
            },
          }),
        };
      if (u.hostname === "mock-upload.test") {
        uploads++;
        assert.ok(options.body.get("file"));
        assert.equal(options.headers, undefined);
        return { ok: true };
      }
      if (u.pathname.endsWith("/video-synthesis")) {
        submissions++;
        assert.match(JSON.parse(options.body).input.img_url, /^oss:\/\/temp\//);
        assert.equal(
          options.headers["X-DashScope-OssResourceResolve"],
          "enable",
        );
        return {
          ok: true,
          json: async () => ({ output: { task_id: "paid-existing" } }),
        };
      }
      if (u.pathname === "/api/v1/tasks/paid-existing")
        return {
          ok: true,
          json: async () => ({
            output: {
              task_status: "SUCCEEDED",
              video_url: "https://video.test/clip.mp4",
            },
          }),
        };
      if (u.hostname === "video.test")
        return new Response(await fs.readFile(sample));
      throw Error("Unexpected request " + url);
    };
    const project = await storyboard("A clockmaker", 1, cfg, fetcher);
    assert.equal(validate(project, cfg), 5);
    const comfy = new Comfy(cfg, fetcher, async () => {});
    const id = await comfy.submit(workflow, project.scenes[0].imagePrompt);
    const image = await comfy.image(id, path.join(folder, "image.png"));
    const wan = new Wan(cfg, "fake-key", fetcher, async () => {});
    const uploaded = await wan.upload(image);
    const task = await wan.submit({ ...project.scenes[0], image: uploaded });
    const video = await wan.poll(task, () => {});
    const clip = path.join(folder, "clip.mp4");
    await download(video, clip, fetcher);
    await merge([clip], folder, cfg);
    const output = await finish(project, folder, cfg);
    const probe = JSON.parse(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        output,
      ]),
    );
    assert.ok(probe.streams.some((s) => s.codec_name === "mov_text"));
    assert.ok(probe.streams.some((s) => s.width === 1280));
    assert.equal(submissions, 1);
    assert.equal(uploads, 1);
    assert.equal(comfyPolls, 2);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("Windows installed SAPI voice renders audio into the exported drama", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Requires Windows SAPI");
    return;
  }
  let voices;
  try {
    voices = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; @($s.GetInstalledVoices() | Where-Object { $_.Enabled }).Count; $s.Dispose()",
    ]);
  } catch {
    t.skip("Windows SAPI unavailable on this runner");
    return;
  }
  if (Number(voices.trim()) < 1) {
    t.skip("No SAPI desktop voice installed");
    return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "speech studio "));
  try {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:d=5",
      "-c:v",
      "libx264",
      path.join(folder, "final.mp4"),
    ]);
    const output = await finish(
      { scenes: [{ narration: "Hello world" }] },
      folder,
      { ...cfg, narration: true },
    );
    const probe = JSON.parse(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        output,
      ]),
    );
    assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
    assert.ok(probe.streams.some((s) => s.codec_type === "subtitle"));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
