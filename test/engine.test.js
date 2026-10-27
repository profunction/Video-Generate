const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Wan, validate, merge, run, lastFrame } = require("../app/engine");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const cfg = {
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 0.1,
  budget: 1,
};
const scene = {
  prompt: "A character walks",
  image: "https://example.com/image.png",
};
test("budget includes reserved spend and excludes previously submitted jobs", () => {
  assert.equal(validate({ scenes: [scene], reserved: 0.5 }, cfg), 0.5);
  assert.throws(
    () => validate({ scenes: [scene], reserved: 0.6 }, cfg),
    /budget/,
  );
  assert.equal(
    validate({ scenes: [{ ...scene, taskId: "existing" }], reserved: 1 }, cfg),
    0,
  );
  assert.throws(
    () => validate({ scenes: [{ ...scene, image: "file:///secret" }] }, cfg),
    /HTTPS/,
  );
});
test("continuing scenes need no image, but the first scene always does", () => {
  const next = { prompt: "Next", continuePrevious: true };
  assert.equal(validate({ scenes: [scene, next] }, cfg), 1);
  assert.throws(() => validate({ scenes: [next] }, cfg), /HTTPS image URL/);
});
test("the last frame of a clip is saved for the next scene", async (t) => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    t.skip("FFmpeg not installed");
    return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "last frame "));
  try {
    // Red for the first second, then blue: the final frame must be blue.
    const clip = path.join(folder, "clip.mp4");
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64:d=2",
      "-vf",
      "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    const frame = await lastFrame(clip, path.join(folder, "frame.png"), {
      ffmpeg: "ffmpeg",
    });
    const pixel = path.join(folder, "pixel.rgb");
    await run("ffmpeg", [
      "-y",
      "-i",
      frame,
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      pixel,
    ]);
    const [r, , b] = await fs.readFile(pixel);
    assert.ok(b > 180 && r < 80, `expected blue, got r=${r} b=${b}`);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test("submitted scenes can be re-exported without price or budget", () => {
  assert.equal(
    validate(
      { scenes: [{ ...scene, clip: "clip-1.mp4", taskId: "t" }], reserved: 5 },
      { ...cfg, pricePerSecond: 0 },
    ),
    0,
  );
});
test("paid submission uses correct async payload and never retries", async () => {
  let calls = 0;
  const wan = new Wan(cfg, "secret", async (url, options) => {
    calls++;
    assert.equal(options.headers["X-DashScope-Async"], "enable");
    assert.equal(JSON.parse(options.body).input.img_url, scene.image);
    return { ok: false, status: 503 };
  });
  await assert.rejects(
    () => wan.submit(scene),
    (e) => /503/.test(e.message) && e.retryable && !e.rejected,
  );
  assert.equal(calls, 1);
});
test("a refused submission reports the provider reason and is definitive", async () => {
  const wan = new Wan(cfg, "secret", async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      code: "InvalidParameter",
      message: "The image size is too large",
    }),
  }));
  await assert.rejects(
    () => wan.submit(scene),
    (e) =>
      /InvalidParameter: The image size is too large/.test(e.message) &&
      e.rejected === true,
  );
});
test("poll retries transient errors then returns video without new submission", async () => {
  let calls = 0;
  const wan = new Wan(
    cfg,
    "secret",
    async (url, options) => {
      assert.equal(options.method, "GET");
      calls++;
      if (calls === 1) return { ok: false, status: 429 };
      return {
        ok: true,
        json: async () => ({
          output: {
            task_status: calls === 2 ? "RUNNING" : "SUCCEEDED",
            video_url: "https://example.com/clip.mp4",
          },
        }),
      };
    },
    async () => {},
  );
  assert.equal(
    await wan.poll("existing", () => {}),
    "https://example.com/clip.mp4",
  );
  assert.equal(calls, 3);
});
test("failed jobs stop polling", async () => {
  const wan = new Wan(
    cfg,
    "secret",
    async () => ({
      ok: true,
      json: async () => ({
        output: { task_status: "FAILED", code: "InvalidImage" },
      }),
    }),
    async () => {},
  );
  await assert.rejects(
    () => wan.poll("task", () => {}),
    (e) => /InvalidImage/.test(e.message) && e.taskStatus === "FAILED",
  );
});
test("cloud pictures use the text-to-image task and its result URL", async () => {
  const requests = [];
  const wan = new Wan(
    { ...cfg, imageModel: "wan2.2-t2i-flash" },
    "secret",
    async (url, options) => {
      requests.push({ url, options });
      if (options.method === "POST")
        return {
          ok: true,
          json: async () => ({ output: { task_id: "img1" } }),
        };
      return {
        ok: true,
        json: async () => ({
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://img.test/a.png" }],
          },
        }),
      };
    },
    async () => {},
  );
  assert.equal(await wan.submitImage("a clockmaker"), "img1");
  const body = JSON.parse(requests[0].options.body);
  assert.match(requests[0].url, /\/text2image\/image-synthesis$/);
  assert.equal(requests[0].options.headers["X-DashScope-Async"], "enable");
  assert.equal(body.model, "wan2.2-t2i-flash");
  assert.equal(body.input.prompt, "a clockmaker");
  assert.equal(body.parameters.size, "1280*720");
  assert.equal(
    await wan.poll(
      "img1",
      () => {},
      (out) => out.results[0].url,
    ),
    "https://img.test/a.png",
  );
});
test("tools resolve with stdout only and fail with their own message", async () => {
  assert.equal(
    await run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({ ok: 1 })); process.stderr.write('warning')",
    ]),
    '{"ok":1}',
  );
  await assert.rejects(
    () =>
      run(process.execPath, [
        "-e",
        "console.error('Invalid data found'); process.exit(3)",
      ]),
    /failed \(3\): Invalid data found/,
  );
});
test("FFmpeg normalizes and concatenates different frame sizes", async (t) => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    t.skip("FFmpeg not installed");
    return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "短剧 studio "));
  try {
    const clips = [];
    for (const [i, size] of ["320x240", "640x360"].entries()) {
      const file = path.join(folder, `input-${i}.mp4`);
      await run("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${size}:d=0.5`,
        "-c:v",
        "libx264",
        file,
      ]);
      clips.push(file);
    }
    const out = await merge(clips, folder, {
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
    });
    const probe = JSON.parse(
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
    // Each scene is padded or trimmed to exactly 5 seconds.
    assert.ok(Math.abs(Number(probe.format.duration) - 10) < 0.05);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
