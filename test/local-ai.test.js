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
  toApiWorkflow,
  builtInWorkflow,
  builtInWorkflowUi,
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
  textModel: "test-model",
  comfyUrl: "http://127.0.0.1:8188",
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 1,
  budget: 10,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  narration: false,
  // These tests cover the local services; cloud mode has its own tests.
  scriptSource: "ollama",
  imageSource: "comfyui",
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
test("a thinking model's reasoning before the script is ignored", async () => {
  const scene = { prompt: "Walk", imagePrompt: "Hero", narration: "Hi" };
  const story = await storyboard("story", 1, cfg, async () => ({
    ok: true,
    json: async () => ({
      message: {
        content:
          "<think>\nThe user wants {a story}.\n</think>\n\n" +
          JSON.stringify({ title: "T", scenes: [scene] }),
      },
    }),
  }));
  assert.equal(story.scenes[0].prompt, "Walk");
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
test("in cloud mode Qwen writes the script with the Alibaba Cloud key", async () => {
  let request;
  const story = await storyboard(
    "story",
    1,
    { ...cfg, scriptSource: "cloud", region: "international" },
    async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "T",
                  scenes: [
                    { prompt: "Walk", imagePrompt: "Hero", narration: "Hi" },
                  ],
                }),
              },
            },
          ],
        }),
      };
    },
    true,
    "sk-test",
  );
  assert.equal(
    request.url,
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(request.options.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /continuous take/);
  assert.equal(story.scenes[0].prompt, "Walk");
  await assert.rejects(
    () =>
      storyboard(
        "story",
        1,
        { ...cfg, scriptSource: "cloud" },
        async () => ({
          ok: false,
          status: 401,
          json: async () => ({
            error: { message: "Incorrect API key provided." },
          }),
        }),
        false,
        "sk-bad",
      ),
    /401 \(Incorrect API key provided\.\)/,
  );
  await assert.rejects(
    () => storyboard("story", 1, { ...cfg, scriptSource: "cloud" }),
    /API Key/,
  );
  // Nothing local is checked when Alibaba Cloud does both jobs.
  assert.equal(
    await checkServices(
      { ...cfg, scriptSource: "cloud", imageSource: "cloud" },
      async () => assert.fail("no local service should be contacted"),
    ),
    "",
  );
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
  assert.match(report, /改成已安装的 other:latest/);
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
// Node definitions shaped like ComfyUI's /object_info replies (both combo formats).
const spec = (type, options = {}) => [type, options];
const objectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: spec("COMBO", {
          options: ["v1-5-pruned-emaonly-fp16.safetensors"],
        }),
      },
    },
    input_order: { required: ["ckpt_name"] },
  },
  CLIPTextEncode: {
    input: {
      required: {
        text: spec("STRING", { multiline: true, dynamicPrompts: true }),
        clip: spec("CLIP"),
      },
    },
    input_order: { required: ["text", "clip"] },
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: spec("INT", { default: 512 }),
        height: spec("INT", { default: 512 }),
        batch_size: spec("INT", { default: 1 }),
      },
    },
  },
  KSampler: {
    input: {
      required: {
        model: spec("MODEL"),
        seed: spec("INT", { control_after_generate: true }),
        steps: spec("INT"),
        cfg: spec("FLOAT"),
        sampler_name: [["euler", "dpmpp_2m"], {}],
        scheduler: [["normal", "karras"], {}],
        positive: spec("CONDITIONING"),
        negative: spec("CONDITIONING"),
        latent_image: spec("LATENT"),
        denoise: spec("FLOAT"),
      },
    },
  },
  LoraLoader: {
    input: {
      required: {
        model: spec("MODEL"),
        clip: spec("CLIP"),
        lora_name: [["style.safetensors"], {}],
        strength_model: spec("FLOAT"),
        strength_clip: spec("FLOAT"),
      },
    },
  },
  VAEDecode: {
    input: { required: { samples: spec("LATENT"), vae: spec("VAE") } },
  },
  SaveImage: {
    input: {
      required: {
        images: spec("IMAGE"),
        filename_prefix: spec("STRING", { default: "ComfyUI" }),
      },
      hidden: { prompt: "PROMPT" },
    },
  },
};
test("the ComfyUI copy of the built-in workflow runs the same graph", () => {
  assert.deepEqual(
    toApiWorkflow(builtInWorkflowUi, objectInfo),
    builtInWorkflow,
  );
});
test("edits made in ComfyUI's editor are converted the way ComfyUI runs them", () => {
  const ui = structuredClone(builtInWorkflowUi);
  const node = (id) => ui.nodes.find((n) => n.id === id);
  // Changed settings, saved by a newer editor that lists widget sockets too.
  node(5).widgets_values = [7, "fixed", 30, 6.5, "dpmpp_2m", "karras", 1];
  node(5).inputs.push({
    name: "seed",
    type: "INT",
    widget: { name: "seed" },
    link: null,
  });
  // A reroute between VAE Decode and Save Image.
  ui.nodes.push({
    id: 9,
    type: "Reroute",
    mode: 0,
    inputs: [{ name: "", type: "*", link: 10 }],
    outputs: [{ name: "", type: "IMAGE", links: [11] }],
  });
  ui.links = ui.links.filter((l) => l[0] !== 9);
  ui.links.push([10, 6, 0, 9, 0, "IMAGE"], [11, 9, 0, 7, 0, "IMAGE"]);
  node(7).inputs[0].link = 11;
  // A primitive driving the width, and a bypassed LoRA on the model path.
  ui.nodes.push({
    id: 10,
    type: "PrimitiveNode",
    mode: 0,
    outputs: [{ name: "INT", type: "INT", links: [12] }],
    widgets_values: [1024, "fixed"],
  });
  node(4).inputs.push({
    name: "width",
    type: "INT",
    widget: { name: "width" },
    link: 12,
  });
  ui.links.push([12, 10, 0, 4, 0, "INT"]);
  ui.nodes.push({
    id: 11,
    type: "LoraLoader",
    mode: 4,
    inputs: [
      { name: "model", type: "MODEL", link: 13 },
      { name: "clip", type: "CLIP", link: null },
    ],
    outputs: [{ name: "MODEL", type: "MODEL", links: [14] }],
    widgets_values: ["style.safetensors", 1, 1],
  });
  ui.links = ui.links.filter((l) => l[0] !== 1);
  ui.links.push([13, 1, 0, 11, 0, "MODEL"], [14, 11, 0, 5, 0, "MODEL"]);
  node(5).inputs[0].link = 14;
  // A muted extra node is left out.
  ui.nodes.push({
    id: 12,
    type: "SaveImage",
    mode: 2,
    inputs: [],
    widgets_values: ["x"],
  });
  const graph = toApiWorkflow(ui, objectInfo);
  assert.deepEqual(graph["5"].inputs, {
    model: ["1", 0],
    seed: 7,
    steps: 30,
    cfg: 6.5,
    sampler_name: "dpmpp_2m",
    scheduler: "karras",
    positive: ["2", 0],
    negative: ["3", 0],
    latent_image: ["4", 0],
    denoise: 1,
  });
  assert.equal(graph["4"].inputs.width, 1024);
  assert.deepEqual(graph["7"].inputs.images, ["6", 0]);
  assert.deepEqual(Object.keys(graph).sort(), [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  ui.nodes.push({ id: 13, type: "CustomThing", mode: 0, inputs: [] });
  assert.throws(() => toApiWorkflow(ui, objectInfo), /CustomThing/);
  assert.throws(() => toApiWorkflow(null, objectInfo), /改用内置工作流/);
});
test("the workflow is shared through ComfyUI's workflow list", async () => {
  const calls = [];
  let stored = null;
  const comfy = new Comfy(cfg, async (url, options = {}) => {
    const u = new URL(url);
    calls.push(`${options.method || "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/api/userdata/workflows%2FVideo%20Generate.json") {
      if (options.method === "POST") {
        if (stored && u.searchParams.get("overwrite") === "false")
          return { ok: false, status: 409 };
        stored = JSON.parse(options.body);
        return { ok: true, status: 200 };
      }
      return stored
        ? { ok: true, status: 200, json: async () => stored }
        : { ok: false, status: 404 };
    }
    const type = decodeURIComponent(u.pathname.split("/").pop());
    return { ok: true, json: async () => ({ [type]: objectInfo[type] }) };
  });
  assert.equal(await comfy.edited(), null);
  assert.equal(await comfy.publish(builtInWorkflowUi), true);
  // The user's edited copy is kept unless a reset asks to overwrite it.
  stored.nodes.find((n) => n.id === 5).widgets_values[2] = 35;
  assert.equal(await comfy.publish(builtInWorkflowUi), false);
  assert.equal((await comfy.edited())["5"].inputs.steps, 35);
  assert.equal(await comfy.publish(builtInWorkflowUi, true), true);
  assert.equal((await comfy.edited())["5"].inputs.steps, 20);
  assert.ok(calls.includes("GET /object_info/KSampler"));
});
test("a wrong port is answered with the address where the service runs", async () => {
  const report = await checkServices(
    {
      ...cfg,
      ollamaUrl: "http://127.0.0.1:11435",
      comfyUrl: "http://127.0.0.1:18188",
    },
    async (url) => {
      const u = new URL(url);
      if (u.port === "11434")
        return { ok: true, json: async () => ({ models: [{ name: "test" }] }) };
      if (u.port === "8000") return { ok: true, json: async () => ({}) };
      throw new TypeError("fetch failed");
    },
  );
  assert.match(report, /Ollama 正在 http:\/\/127\.0\.0\.1:11434 运行/);
  assert.match(report, /ComfyUI 正在 http:\/\/127\.0\.0\.1:8000 运行/);
  const none = await checkServices(cfg, async () => {
    throw new TypeError("fetch failed");
  });
  assert.match(none, /没有找到正在运行的 Ollama/);
  assert.match(none, /没有找到正在运行的 ComfyUI/);
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
