const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Veo, SelfHosted, validate, merge, run } = require("../app/engine");
const { produce } = require("../app/pipeline");
const { subtitles } = require("../app/finish");
const cfg = {
  region: "china",
  model: "wan2.2-i2v-flash",
  veoModel: "veo-3.1-generate-preview",
  selfHostedUrl: "http://127.0.0.1:8081",
  pricePerSecond: 0.5,
  budget: 100,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};
const veoCfg = { ...cfg, videoProvider: "veo" };
const selfCfg = { ...cfg, videoProvider: "selfHosted" };
const operation = "models/veo-3.1-generate-preview/operations/abc123";
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "providers 短剧 "));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function ffmpeg(t) {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    t.skip("FFmpeg unavailable");
    return false;
  }
}
async function clip(file, seconds, color = "blue") {
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x240:d=${seconds}`,
    "-c:v",
    "libx264",
    file,
  ]);
  return file;
}
test("Veo sends the first frame inline with the key header and is never retried", async (t) => {
  const dir = await folder(t);
  const picture = path.join(dir, "frame.png");
  await fs.writeFile(picture, Buffer.from("png-bytes"));
  const calls = [];
  const veo = new Veo(veoCfg, "g-key", async (url, init) => {
    calls.push({ url, init });
    return Response.json({ name: operation });
  });
  assert.equal(await veo.submit({ prompt: "Walk" }, picture), operation);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
  );
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.instances[0].prompt, "Walk");
  assert.deepEqual(body.instances[0].image, {
    bytesBase64Encoded: Buffer.from("png-bytes").toString("base64"),
    mimeType: "image/png",
  });
});
test("a refused Veo request is definitive and keeps Google's reason", async () => {
  const veo = new Veo(veoCfg, "g-key", async () =>
    Response.json({ error: { message: "model not found" } }, { status: 404 }),
  );
  await assert.rejects(
    () => veo.submit({ prompt: "Walk" }),
    (e) => e.rejected && /model not found/.test(e.message),
  );
});
test("a finished Veo operation without a video counts as a failed task", async () => {
  const replies = [
    { name: operation },
    { name: operation, done: true, error: { message: "filtered" } },
  ];
  const veo = new Veo(
    veoCfg,
    "g-key",
    async () => Response.json(replies.shift()),
    async () => {},
  );
  await assert.rejects(
    () => veo.poll(operation, () => {}),
    (e) => e.taskStatus === "FAILED" && /filtered/.test(e.message),
  );
});
test("Veo returns its video link and downloads it with the key", async (t) => {
  const uri =
    "https://generativelanguage.googleapis.com/v1beta/files/v:download";
  const seen = [];
  const veo = new Veo(veoCfg, "g-key", async (url, init) => {
    seen.push([url, init.headers?.["x-goog-api-key"]]);
    if (url === uri) return new Response("video");
    return Response.json({
      done: true,
      response: {
        generateVideoResponse: { generatedSamples: [{ video: { uri } }] },
      },
    });
  });
  assert.equal(await veo.poll(operation, () => {}), uri);
  const target = path.join(await folder(t), "clip.mp4");
  await veo.download(uri, target);
  assert.equal(await fs.readFile(target, "utf8"), "video");
  assert.deepEqual(seen.at(-1), [uri, "g-key"]);
});
test("Veo is priced per 8-second clip; a self-hosted server is free and needs no picture", () => {
  const p = { scenes: [{ prompt: "Walk", imagePrompt: "a man" }], reserved: 0 };
  assert.equal(validate(p, veoCfg), 4);
  const bare = { scenes: [{ prompt: "Walk" }], reserved: 0 };
  assert.throws(() => validate(bare, veoCfg), /HTTPS image/);
  assert.equal(validate(bare, { ...selfCfg, pricePerSecond: 0 }), 0);
  assert.throws(
    () => validate(bare, { ...selfCfg, selfHostedUrl: "ftp://x" }),
    /self-hosted/,
  );
  assert.throws(
    () => validate(bare, { ...veoCfg, veoModel: "gpt" }),
    /Veo model/,
  );
});
test("a self-hosted request posts the prompt with the shared secret", async (t) => {
  let request;
  const server = new SelfHosted(selfCfg, "secret", async (url, init) => {
    request = { url, init };
    return new Response("mp4");
  });
  const target = path.join(await folder(t), "clip.mp4");
  await server.generate({ prompt: "Walk" }, target);
  assert.equal(request.url, "http://127.0.0.1:8081/generate");
  assert.equal(request.init.headers["X-Inference-Key"], "secret");
  assert.deepEqual(JSON.parse(request.init.body), { prompt: "Walk" });
  assert.equal(await fs.readFile(target, "utf8"), "mp4");
});
test("a continuing Veo scene sends the previous clip's last frame and lasts 8 s", async (t) => {
  if (!(await ffmpeg(t))) return;
  const dir = await folder(t);
  await clip(path.join(dir, "clip-1.mp4"), 1);
  const p = {
    scenes: [
      {
        prompt: "Walk",
        taskId: operation,
        provider: "veo",
        clip: "clip-1.mp4",
        seconds: 8,
      },
      { prompt: "He keeps walking", continuePrevious: true },
    ],
    reserved: 0,
  };
  const sent = [];
  const veo = {
    submit: async (scene, file) => {
      sent.push(file);
      await fs.access(file);
      return "models/veo/operations/next";
    },
    poll: async () => "https://generativelanguage.googleapis.com/v",
    download: async (uri, file) =>
      fs.copyFile(path.join(dir, "clip-1.mp4"), file),
  };
  await produce(p, dir, veoCfg, {
    wan: null,
    video: veo,
    persist: async () => {},
  });
  assert.deepEqual(sent, [path.join(dir, "frame-2.png")]);
  assert.equal(p.reserved, 4);
  assert.equal(p.scenes[1].provider, "veo");
  assert.equal(p.scenes[1].model, "veo-3.1-generate-preview");
  assert.equal(p.scenes[1].seconds, 8);
});
test("a task sent to one provider is not polled at another", async (t) => {
  const p = {
    scenes: [{ prompt: "Walk", taskId: "wan-task", region: "china" }],
    reserved: 0,
  };
  const video = {
    poll: async () => {
      throw Error("polled the wrong provider");
    },
  };
  const dir = await folder(t);
  await assert.rejects(
    () => produce(p, dir, veoCfg, { video, persist: async () => {} }),
    /阿里云 Wan/,
  );
});
test("a self-hosted clip keeps its own length and is made again if deleted", async (t) => {
  if (!(await ffmpeg(t))) return;
  const dir = await folder(t);
  const source = await clip(path.join(dir, "source.mp4"), 3);
  let made = 0;
  const server = {
    generate: async (scene, file) => {
      made++;
      await fs.copyFile(source, file);
    },
  };
  const p = { scenes: [{ prompt: "Walk" }], reserved: 0 };
  const options = { video: server, persist: async () => {} };
  await produce(p, dir, selfCfg, options);
  assert.equal(p.scenes[0].seconds, 3);
  assert.equal(p.reserved, 0);
  await fs.rm(path.join(dir, "clip-1.mp4"));
  await produce(p, dir, selfCfg, options);
  assert.equal(made, 2);
});
test("subtitles and the merged video follow each scene's length", async (t) => {
  const text = subtitles([
    { narration: "一", seconds: 8 },
    { narration: "二" },
    { narration: "三", seconds: 8 },
  ]);
  assert.match(text, /00:00:00,000 --> 00:00:08,000\n一/);
  assert.match(text, /00:00:08,000 --> 00:00:13,000\n二/);
  assert.match(text, /00:00:13,000 --> 00:00:21,000\n三/);
  if (!(await ffmpeg(t))) return;
  const dir = await folder(t);
  const clips = [
    await clip(path.join(dir, "a.mp4"), 1),
    await clip(path.join(dir, "b.mp4"), 9, "red"),
  ];
  const out = await merge(clips, dir, cfg, [8, 5]);
  const info = JSON.parse(
    await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      out,
    ]),
  );
  assert.ok(Math.abs(Number(info.format.duration) - 13) < 0.05);
});
