const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  PHOTO,
  photoWorkflow,
  ensurePhotoAssets,
} = require("../app/photo-model");
const { prepareWorkflow } = require("../app/local-ai");

test("photo workflow uses the recommended standalone VAE, not the checkpoint VAE", () => {
  const graph = photoWorkflow();
  const loader = Object.entries(graph).find(
    ([, n]) => n.class_type === "VAELoader",
  );
  const decoder = Object.values(graph).find(
    (n) => n.class_type === "VAEDecode",
  );
  const save = Object.values(graph).find((n) => n.class_type === "SaveImage");
  assert.equal(loader[1].inputs.vae_name, PHOTO.vae.filename);
  assert.deepEqual(decoder.inputs.vae, [loader[0], 0]);
  assert.equal(graph[decoder.inputs.samples[0]].class_type, "KSampler");
  assert.equal(graph[save.inputs.images[0]].class_type, "VAEDecode");
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value))
        assert.ok(graph[value[0]], "all graph links must resolve");
    }
  }
});

test("photo workflow substitutes the story prompt without modifying the template or negative prompt", () => {
  const graph = photoWorkflow();
  const before = JSON.stringify(graph);
  const result = prepareWorkflow(
    graph,
    'a clockmaker holding a "silver watch"',
  );
  assert.equal(JSON.stringify(graph), before);
  assert.match(
    result["2"].inputs.text,
    /a clockmaker holding a "silver watch"/,
  );
  assert.doesNotMatch(result["2"].inputs.text, /\{\{PROMPT\}\}/);
  assert.deepEqual(result["3"], graph["3"]);
  assert.deepEqual(result["7"], graph["7"]);
  assert.equal(result["5"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(result["5"].inputs.scheduler, "karras");
});

test("photo assets pin official source revisions, complete digests and expected download sizes", () => {
  assert.equal(PHOTO.checkpoint.size, 2132625894);
  assert.equal(PHOTO.vae.size, 334641190);
  for (const source of [PHOTO.checkpoint, PHOTO.vae]) {
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "huggingface.co");
    assert.match(url.pathname, /\/resolve\/[a-f0-9]{40}\//);
    assert.match(source.sha, /^[a-f0-9]{64}$/);
    assert.ok(url.pathname.endsWith(source.filename));
  }
  assert.match(PHOTO.checkpoint.url, /SG161222\/Realistic_Vision_V5\.1_noVAE/);
  assert.match(PHOTO.vae.url, /stabilityai\/sd-vae-ft-mse-original/);
  assert.deepEqual(
    PHOTO.licenses.map((l) => l.name),
    ["CreativeML OpenRAIL-M", "MIT"],
  );
});

test("photo setup downloads both assets into ComfyUI model directories without changing an existing workflow", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-model-"));
  try {
    await fs.writeFile(path.join(directory, "main.py"), "# test installation");
    const existing = path.join(directory, "workflow.json");
    await fs.writeFile(existing, '{"existing":"keep"}');
    const calls = [];
    const report = () => {};
    const result = await ensurePhotoAssets(directory, {
      report,
      download: async (source, target, callback) => {
        calls.push({ source, target, callback });
        await fs.writeFile(target, "small test fixture");
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].source, PHOTO.checkpoint);
    assert.equal(
      calls[0].target,
      path.join(directory, "models", "checkpoints", PHOTO.checkpoint.filename),
    );
    assert.equal(calls[1].source, PHOTO.vae);
    assert.equal(
      calls[1].target,
      path.join(directory, "models", "vae", PHOTO.vae.filename),
    );
    assert.equal(calls[0].callback, report);
    assert.deepEqual(result, photoWorkflow());
    assert.equal(await fs.readFile(existing, "utf8"), '{"existing":"keep"}');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("photo setup refuses a missing ComfyUI installation and propagates a failed download", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-failure-"));
  try {
    let calls = 0;
    await assert.rejects(
      ensurePhotoAssets(directory, {
        download: async () => {
          calls++;
        },
      }),
      /main\.py/,
    );
    assert.equal(calls, 0);
    await fs.writeFile(path.join(directory, "main.py"), "# installed");
    await assert.rejects(
      ensurePhotoAssets(directory, {
        download: async () => {
          calls++;
          throw new Error("checksum failed");
        },
      }),
      /checksum failed/,
    );
    assert.equal(calls, 1);
    await assert.rejects(ensurePhotoAssets(directory, {}), /downloader/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
