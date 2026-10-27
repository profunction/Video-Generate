const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  localBase,
  storyboard,
  prepareWorkflow,
  pickCheckpoint,
  builtInWorkflow,
  Comfy,
  checkServices,
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
  assert.equal(
    prepareWorkflow(workflow, "a $$5 coin, $& and $'")["1"].inputs.text,
    "cinematic a $$5 coin, $& and $'",
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
test("story generation constrains JSON, trims extra scenes and whitespace", async () => {
  const story = await storyboard("story", 1, cfg, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.format.properties.scenes.minItems, 1);
    assert.equal(body.options.num_ctx, 8192);
    const scene = {
      prompt: " Camera moves \n",
      imagePrompt: "Hero",
      narration: "Hi",
    };
    return {
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({ title: "T", scenes: [scene, scene] }),
        },
      }),
    };
  });
  assert.equal(story.scenes.length, 1);
  assert.equal(story.scenes[0].prompt, "Camera moves");
});
test("continuous stories ask for one take without cuts", async () => {
  const prompts = [];
  const fetcher = async (url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    const scene = { prompt: "Walk", imagePrompt: "Hero", narration: "Hi" };
    return {
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ title: "T", scenes: [scene] }) },
      }),
    };
  };
  await storyboard("story", 1, cfg, fetcher, true);
  await storyboard("story", 1, cfg, fetcher);
  assert.match(prompts[0], /continuous take/);
  assert.doesNotMatch(prompts[1], /continuous take/);
});
test("local AI errors explain unreachable services and provider replies", async () => {
  await assert.rejects(
    () =>
      storyboard("story", 1, cfg, async () => {
        throw new TypeError("fetch failed");
      }),
    /Cannot reach http:\/\/127\.0\.0\.1:11434/,
  );
  await assert.rejects(
    () =>
      storyboard("story", 1, cfg, async () => ({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: 'model "test" not found, try pulling it first',
          }),
      })),
    /404.*model "test" not found/,
  );
  const comfy = new Comfy(cfg, async () => ({
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({
        error: { message: "Prompt outputs failed validation" },
        node_errors: {
          1: { errors: [{ details: "ckpt_name: 'x.safetensors' not in []" }] },
        },
      }),
  }));
  await assert.rejects(
    () => comfy.submit(workflow, "hero"),
    /failed validation — ckpt_name: 'x\.safetensors' not in/,
  );
  const report = await checkServices(cfg, async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("/api/tags") ? { models: [{ name: "other:latest" }] } : {},
  }));
  assert.match(report, /ollama pull test/);
});
test("ComfyUI polling stops on finished jobs without images and on lost jobs", async () => {
  const history = (job) => async (url) => ({
    ok: true,
    json: async () =>
      url.includes("/history/")
        ? job
        : { queue_running: [[1, "queued"]], queue_pending: [] },
  });
  const noImage = new Comfy(
    cfg,
    history({ done: { outputs: {}, status: { status_str: "success" } } }),
    async () => assert.fail("must not wait"),
  );
  await assert.rejects(() => noImage.image("done", "x.png"), /SaveImage/);
  const lost = new Comfy(cfg, history({}), async () =>
    assert.fail("must not wait"),
  );
  await assert.rejects(
    () => lost.image("gone", "x.png"),
    (e) => e.lost === true,
  );
  let waits = 0;
  const queued = new Comfy(cfg, history({}), async () => {
    if (++waits === 2) throw Error("still queued");
  });
  await assert.rejects(() => queued.image("queued", "x.png"), /still queued/);
  assert.equal(waits, 2);
});
test("an SD1.5 checkpoint is preferred over SDXL, Flux and SD2 models", () => {
  assert.equal(
    pickCheckpoint([
      "sd_xl_base_1.0.safetensors",
      "v1-5-pruned-emaonly-fp16.safetensors",
    ]),
    "v1-5-pruned-emaonly-fp16.safetensors",
  );
  assert.equal(
    pickCheckpoint(["flux1-dev.safetensors", "dreamshaper_8.safetensors"]),
    "dreamshaper_8.safetensors",
  );
  assert.equal(
    pickCheckpoint(["juggernautXL_v9.safetensors", "v2-1_768-ema-pruned.ckpt"]),
    null,
  );
});
test("the built-in workflow uses the installed SD1.5 model without an import", async () => {
  const sent = [];
  const fetcher =
    (names) =>
    async (url, options = {}) => {
      const u = new URL(url);
      if (u.pathname === "/object_info/CheckpointLoaderSimple")
        return {
          ok: true,
          json: async () => ({
            CheckpointLoaderSimple: {
              input: { required: { ckpt_name: names } },
            },
          }),
        };
      if (u.pathname === "/prompt") {
        sent.push(JSON.parse(options.body).prompt);
        return { ok: true, json: async () => ({ prompt_id: "p1" }) };
      }
      throw Error("Unexpected request " + url);
    };
  // Classic list format, with the example's placeholder name in an imported copy.
  const comfy = new Comfy(
    cfg,
    fetcher([["sd_xl_base_1.0.safetensors", "my-sd15.safetensors"], {}]),
  );
  assert.deepEqual(await comfy.ready(builtInWorkflow), ["my-sd15.safetensors"]);
  await comfy.submit(builtInWorkflow, "a clockmaker");
  assert.equal(sent[0]["1"].inputs.ckpt_name, "my-sd15.safetensors");
  assert.equal(
    sent[0]["2"].inputs.text,
    "cinematic still, consistent characters, a clockmaker",
  );
  assert.equal(sent[0]["4"].inputs.width, 912);
  assert.equal(
    builtInWorkflow["1"].inputs.ckpt_name,
    "v1-5-pruned-emaonly-fp16.safetensors",
  );
  // Newer COMBO format; an installed name that matches is kept as it is.
  const combo = new Comfy(
    cfg,
    fetcher([
      "COMBO",
      {
        options: ["v1-5-pruned-emaonly-fp16.safetensors", "other.safetensors"],
      },
    ]),
  );
  assert.deepEqual(await combo.ready(builtInWorkflow), [
    "v1-5-pruned-emaonly-fp16.safetensors",
  ]);
  // Without any SD1.5 model the user is told what to download.
  const none = new Comfy(cfg, fetcher([["sd_xl_base_1.0.safetensors"], {}]));
  await assert.rejects(
    () => none.ready(builtInWorkflow),
    /v1-5-pruned-emaonly-fp16\.safetensors/,
  );
});
test("subtitles skip scenes without narration but keep their time slots", () => {
  const text = subtitles([
    { narration: "first" },
    { narration: "  " },
    { narration: "third" },
  ]);
  assert.equal(
    text,
    "1\n00:00:00,000 --> 00:00:05,000\nfirst\n\n2\n00:00:10,000 --> 00:00:15,000\nthird\n",
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
    await assert.rejects(
      () =>
        finish({ scenes: [{ narration: "Hello world" }] }, folder, {
          ...cfg,
          narration: true,
          voice: "Missing Voice",
        }),
      /SAPI voice 'Missing Voice' is not installed\. Installed voices: \w/,
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
