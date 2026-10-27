const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { produce } = require("../app/pipeline");
const { run } = require("../app/engine");
const cfg = {
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 0.5,
  budget: 100,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};
const image = "https://example.com/image.png";
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline 短剧 "));
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
function wanFake(overrides) {
  return {
    upload: async () => {
      throw Error("unexpected upload");
    },
    submit: async () => {
      throw Error("unexpected submit");
    },
    poll: async () => {
      throw Error("unexpected poll");
    },
    ...overrides,
  };
}
test("a refused submission releases its reservation and stays retryable", async (t) => {
  const p = { scenes: [{ prompt: "Walk", image }], reserved: 1 };
  const saved = [];
  const wan = wanFake({
    submit: async () => {
      const error = Error("Wan HTTP 400 (InvalidParameter: bad image)");
      error.rejected = true;
      throw error;
    },
  });
  const dir = await folder(t);
  await assert.rejects(
    () =>
      produce(p, dir, cfg, {
        wan,
        persist: async () => saved.push(structuredClone(p)),
      }),
    /InvalidParameter/,
  );
  // The reservation and uncertain flag were saved before the request was sent.
  assert.equal(saved[0].reserved, 3.5);
  assert.equal(saved[0].scenes[0].uncertain, true);
  assert.equal(p.reserved, 1);
  assert.equal(p.scenes[0].uncertain, false);
  assert.equal(p.scenes[0].taskId, undefined);
});
test("a lost submission response stays uncertain and blocks resubmission", async (t) => {
  const p = { scenes: [{ prompt: "Walk", image }], reserved: 0 };
  let submissions = 0;
  const wan = wanFake({
    submit: async () => {
      submissions++;
      throw new TypeError("fetch failed");
    },
  });
  const dir = await folder(t);
  const options = { wan, persist: async () => {} };
  await assert.rejects(() => produce(p, dir, cfg, options), /fetch failed/);
  assert.equal(p.scenes[0].uncertain, true);
  assert.equal(p.reserved, 2.5);
  await assert.rejects(() => produce(p, dir, cfg, options), /不确定/);
  assert.equal(submissions, 1);
});
test("a failed Wan task unlocks the scene but keeps the reservation", async (t) => {
  const p = {
    scenes: [{ prompt: "Walk", image, taskId: "t1", region: "china" }],
    reserved: 2.5,
  };
  const wan = wanFake({
    poll: async () => {
      const error = Error("Task FAILED: DataInspectionFailed");
      error.taskStatus = "FAILED";
      throw error;
    },
  });
  const dir = await folder(t);
  await assert.rejects(
    () => produce(p, dir, cfg, { wan, persist: async () => {} }),
    /已解锁/,
  );
  assert.equal(p.scenes[0].taskId, undefined);
  assert.equal(p.scenes[0].region, undefined);
  assert.deepEqual(p.scenes[0].failedTasks, ["t1"]);
  assert.equal(p.reserved, 2.5);
});
test("an unknown task unlocks only after the provider's 24-hour retention", async (t) => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const wan = wanFake({
    poll: async () => {
      const error = Error("Task UNKNOWN: see provider console");
      error.taskStatus = "UNKNOWN";
      throw error;
    },
  });
  const dir = await folder(t);
  const scene = (submittedAt) => ({
    prompt: "Walk",
    image,
    taskId: "t1",
    region: "china",
    submittedAt,
  });
  const recent = { scenes: [scene("2026-10-27T10:00:00Z")], reserved: 0 };
  await assert.rejects(
    () =>
      produce(recent, dir, cfg, {
        wan,
        persist: async () => {},
        now: () => now,
      }),
    /UNKNOWN/,
  );
  assert.equal(recent.scenes[0].taskId, "t1");
  const old = { scenes: [scene("2026-10-25T10:00:00Z")], reserved: 0 };
  await assert.rejects(
    () =>
      produce(old, dir, cfg, { wan, persist: async () => {}, now: () => now }),
    /已解锁/,
  );
  assert.equal(old.scenes[0].taskId, undefined);
});
test("a deleted clip is downloaded again from its task without a new job", async (t) => {
  if (!(await ffmpeg(t))) return;
  const dir = await folder(t);
  const sample = path.join(dir, "sample.mp4");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:d=1",
    "-c:v",
    "libx264",
    sample,
  ]);
  const p = {
    scenes: [
      {
        prompt: "Walk",
        image,
        taskId: "t1",
        region: "china",
        clip: "clip-1.mp4",
      },
    ],
    reserved: 2.5,
  };
  let polls = 0;
  const wan = wanFake({
    poll: async (id) => {
      polls++;
      assert.equal(id, "t1");
      return "https://video.test/clip.mp4";
    },
  });
  await produce(p, dir, cfg, {
    wan,
    persist: async () => {},
    fetcher: async () => new Response(await fs.readFile(sample)),
  });
  assert.equal(polls, 1);
  assert.equal(p.scenes[0].clip, "clip-1.mp4");
  await fs.access(path.join(dir, "clip-1.mp4"));
});
test("a download that is not a video is discarded and keeps the task", async (t) => {
  if (!(await ffmpeg(t))) return;
  const dir = await folder(t);
  const p = {
    scenes: [{ prompt: "Walk", image, taskId: "t1", region: "china" }],
    reserved: 0,
  };
  const wan = wanFake({ poll: async () => "https://video.test/clip.mp4" });
  await assert.rejects(() =>
    produce(p, dir, cfg, {
      wan,
      persist: async () => {},
      fetcher: async () => new Response("<html>expired</html>"),
    }),
  );
  assert.equal(p.scenes[0].clip, undefined);
  assert.equal(p.scenes[0].taskId, "t1");
  await assert.rejects(() => fs.access(path.join(dir, "clip-1.mp4")));
});
test("a ComfyUI job forgotten after a restart is generated again once", async (t) => {
  const dir = await folder(t);
  const p = { scenes: [{ prompt: "Walk", imagePrompt: "Hero" }], reserved: 0 };
  const submitted = [];
  const comfy = {
    submit: async (workflow, prompt) => {
      submitted.push(prompt);
      return "comfy-" + submitted.length;
    },
    image: async (id, target) => {
      if (id === "comfy-1") {
        const error = Error("ComfyUI no longer knows this job");
        error.lost = true;
        throw error;
      }
      await fs.writeFile(target, "png");
      return target;
    },
  };
  const wan = wanFake({
    upload: async () => "oss://temp/image.png",
    submit: async () => {
      throw Object.assign(Error("stop after image"), { rejected: true });
    },
  });
  await assert.rejects(
    () =>
      produce(p, dir, cfg, {
        wan,
        comfy,
        workflow: {},
        persist: async () => {},
      }),
    /stop after image/,
  );
  assert.deepEqual(submitted, ["Hero", "Hero"]);
  assert.equal(p.scenes[0].comfyId, "comfy-2");
  assert.equal(p.scenes[0].localImage, path.join(dir, "image-0.png"));
});
