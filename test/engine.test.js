const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Wan, validate, merge, run } = require("../app/engine");
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
test("local video mode skips the Wan region/model and budget checks", () => {
  assert.equal(
    validate(
      { scenes: [scene], reserved: 0 },
      { localVideo: true, region: "", model: "" },
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
  await assert.rejects(() => wan.submit(scene), /503/);
  assert.equal(calls, 1);
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
  await assert.rejects(() => wan.poll("task", () => {}), /InvalidImage/);
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
    assert.ok(Number(probe.format.duration) >= 0.9);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
