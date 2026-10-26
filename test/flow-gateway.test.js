const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { FlowJobs, FlowGateway, videoWorkflow } = require("../app/flow-gateway");
const { run, merge } = require("../app/engine");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
  "base64",
);
const cfg = {
  region: "china",
  model: "wan2.2-i2v-flash",
  pricePerSecond: 0.2,
  budget: 10,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};
async function fixture(t, approve = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gateway-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = { submit: 0, upload: 0, poll: 0, approve: 0 };
  class FakeWan {
    async upload() {
      calls.upload++;
      return "oss://test";
    }
    async submit() {
      calls.submit++;
      return "task-" + calls.submit;
    }
    async poll() {
      calls.poll++;
      return "https://test/clip.mp4";
    }
  }
  const options = {
    root,
    settings: async () => cfg,
    getKey: async () => "not-real-key",
    approve: async () => {
      calls.approve++;
      return approve;
    },
    normalizeImage: async (image) => image,
    wanClass: FakeWan,
    checkTools: async () => {},
    downloadFile: async (_, file) => fs.writeFile(file, "mock clip"),
    mergeFiles: async (_, folder) => path.join(folder, "final.mp4"),
  };
  return {
    root,
    calls,
    options,
    jobs: new FlowJobs(options),
    input: {
      jobKey: "scene-test",
      motionPrompt: "Slow camera movement",
      images: [png.toString("base64"), png.toString("base64")],
    },
  };
}
test("video graph connects image batch to paid 5-second clips and MP4 merge", () => {
  const graph = videoWorkflow("fixed-job");
  assert.equal(graph["4"].inputs.batch_size, 2);
  assert.deepEqual(graph["9"].inputs.images, ["7", 0]);
  assert.equal(graph["9"].class_type, "VG_WanFiveSecondClips");
  assert.deepEqual(graph["10"].inputs.manifest, ["9", 0]);
  assert.equal(graph["9"].inputs.job_key, "fixed-job");
});
test("two-image run persists reservations and clips; repeat does not create paid jobs", async (t) => {
  const { jobs, input, calls, root } = await fixture(t);
  const result = await jobs.clips(input);
  assert.equal(calls.submit, 2);
  assert.equal(calls.approve, 1);
  assert.deepEqual(await jobs.clips(input), result);
  assert.equal(calls.submit, 2);
  assert.equal(calls.upload, 2);
  const p = JSON.parse(
    await fs.readFile(
      path.join(root, "projects", result.projectId, "project.json"),
    ),
  );
  assert.equal(p.reserved, 2);
  assert.equal(p.scenes.length, 2);
  assert.ok(p.scenes.every((s) => s.taskId && s.clip));
  const output = await jobs.combine(result);
  assert.match(output.output, /final\.mp4$/);
  await assert.rejects(
    () => jobs.clips({ ...input, motionPrompt: "Different motion" }),
    /different images or prompts/,
  );
  assert.equal(calls.submit, 2);
});
test("cancel, budget failure and invalid image never upload or submit", async (t) => {
  const { jobs, input, calls, options } = await fixture(t, false);
  await assert.rejects(() => jobs.clips(input), /canceled/);
  assert.equal(calls.upload, 0);
  assert.equal(calls.submit, 0);
  const low = new FlowJobs({
    ...options,
    settings: async () => ({ ...cfg, budget: 0.5 }),
  });
  await assert.rejects(() => low.clips(input), /budget/);
  assert.equal(calls.upload, 0);
  await assert.rejects(
    () => jobs.clips({ ...input, images: ["not-png"] }),
    /Invalid/,
  );
});
test("uncertain submission is not retried, lost download resumes original task ID", async (t) => {
  const { jobs, input, calls, options } = await fixture(t);
  let downloads = 0;
  jobs.downloadFile = async (_, file) => {
    downloads++;
    if (downloads === 1) throw Error("Network lost");
    await fs.writeFile(file, "clip");
  };
  await assert.rejects(() => jobs.clips(input), /Network lost/);
  assert.equal(calls.submit, 1);
  await jobs.clips(input);
  assert.equal(calls.submit, 2);
  const other = new FlowJobs({
    ...options,
    wanClass: class {
      async upload() {
        return "oss://test";
      }
      async submit() {
        throw Error("Lost POST response");
      }
    },
  });
  const second = { ...input, jobKey: "uncertain" };
  await assert.rejects(() => other.clips(second), /Lost POST/);
  await assert.rejects(() => other.clips(second), /uncertain status/);
});
test("merge accepts only a saved Flow project UUID", async (t) => {
  const { jobs } = await fixture(t);
  await assert.rejects(
    () => jobs.combine({ projectId: "../../outside" }),
    /Invalid project/,
  );
  await assert.rejects(
    () => jobs.combine({ projectId: "00000000-0000-0000-0000-000000000000" }),
    /Unknown/,
  );
});
test("gateway blocks browser origins and unauthenticated clients; config never includes cloud key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-http-"));
  const calls = [];
  const gateway = new FlowGateway({
    root,
    handle: async (route, input) => {
      calls.push(route);
      return { projectId: input.id };
    },
  });
  const config = await gateway.start();
  t.after(async () => {
    gateway.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const body = JSON.stringify({ id: "test" });
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + config.token,
  };
  let response = await fetch(config.url + "/clips", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 403);
  response = await fetch(config.url + "/clips", {
    method: "POST",
    body,
    headers: { ...headers, Origin: "http://127.0.0.1:18188" },
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
  response = await fetch(config.url + "/clips", {
    method: "POST",
    body,
    headers,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    Object.keys(
      JSON.parse(await fs.readFile(path.join(root, "flow-bridge.json"))),
    ).sort(),
    ["token", "url"],
  );
});
test("mock Wan clips join into a real approximately ten-second MP4", async (t) => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    t.skip("FFmpeg unavailable");
    return;
  }
  const { jobs, input, root } = await fixture(t);
  const sample = path.join(root, "sample.mp4");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x240:d=5",
    "-c:v",
    "libx264",
    sample,
  ]);
  jobs.downloadFile = async (_, file) => fs.copyFile(sample, file);
  jobs.mergeFiles = merge;
  const result = await jobs.clips(input);
  const output = await jobs.combine(result);
  const probe = JSON.parse(
    await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      output.output,
    ]),
  );
  assert.ok(
    Number(probe.format.duration) >= 9.8 &&
      Number(probe.format.duration) <= 10.3,
  );
});
