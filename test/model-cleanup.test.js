const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  LEGACY_MODELS,
  planCleanup,
  cleanupCandidate,
} = require("../app/model-cleanup");

const name = "v1-5-pruned-emaonly.safetensors";
const contents = "small verified legacy fixture";
const catalog = [
  { name, sha: crypto.createHash("sha256").update(contents).digest("hex") },
];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkpoints = path.join(root, "models", "checkpoints");
  await fs.mkdir(checkpoints, { recursive: true });
  const file = path.join(checkpoints, name);
  await fs.writeFile(file, contents);
  return { root, file, checkpoints };
}

test("production cleanup catalog only permits the original pinned baseline model", async (t) => {
  assert.deepEqual(
    LEGACY_MODELS.map((item) => item.name),
    [name],
  );
  assert.equal(
    LEGACY_MODELS[0].sha,
    "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
  );
  const { root } = await fixture(t);
  assert.deepEqual(await planCleanup(root, []), []);
});

test("eligible legacy cleanup recycles only the verified file, leaving unknown weights and archives", async (t) => {
  const { root, file, checkpoints } = await fixture(t);
  const extra = path.join(checkpoints, "Realistic_Vision.safetensors");
  await fs.writeFile(extra, "user weight");
  await fs.writeFile(
    path.join(root, "workflow.json.bak"),
    JSON.stringify({ model: name }),
  );
  const candidates = await planCleanup(root, [], { catalog });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, file);
  let called = null;
  const result = await cleanupCandidate(root, candidates[0], [], {
    catalog,
    trashItem: async (target) => {
      called = target;
    },
  });
  assert.equal(called, file);
  assert.equal(result.recycled, true);
  assert.equal(await fs.readFile(extra, "utf8"), "user weight");
});

test("active API graphs and live UI widgets protect model references case-insensitively", async (t) => {
  const { root } = await fixture(t);
  for (const graph of [
    { 1: { inputs: { ckpt_name: name } } },
    { nodes: [{ widgets_values: ["folder\\" + name.toUpperCase()] }] },
    { nested: ["models/checkpoints/" + name] },
  ])
    assert.deepEqual(await planCleanup(root, [graph], { catalog }), []);
});

test("saved ComfyUI user workflows prevent cleanup", async (t) => {
  const { root } = await fixture(t);
  const folder = path.join(root, "user", "default", "workflows");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    path.join(folder, "myflow.JSON"),
    JSON.stringify({ nodes: [{ widgets_values: [name] }] }),
  );
  assert.deepEqual(await planCleanup(root, [], { catalog }), []);
});

test("malformed saved JSON and symlinks fail closed", async (t) => {
  const { root, file } = await fixture(t);
  await fs.mkdir(path.join(root, "user"));
  const malformed = path.join(root, "user", "invalid.json");
  await fs.writeFile(malformed, "{broken");
  await assert.rejects(
    () => planCleanup(root, [], { catalog }),
    /parse saved workflow/,
  );
  await fs.rm(malformed);
  const linked = path.join(root, "user", "linked.json");
  try {
    await fs.symlink(file, linked);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(
    () => planCleanup(root, [], { catalog }),
    /symbolic links/,
  );
});

test("modified legacy files are preserved, and stale candidates are rejected", async (t) => {
  const { root, file } = await fixture(t);
  const [candidate] = await planCleanup(root, [], { catalog });
  await fs.writeFile(file, "replaced by user");
  assert.deepEqual(await planCleanup(root, [], { catalog }), []);
  let called = false;
  await assert.rejects(
    () =>
      cleanupCandidate(root, candidate, [], {
        catalog,
        trashItem: async () => {
          called = true;
        },
      }),
    /not eligible/,
  );
  assert.equal(called, false);
});

test("new workflow references and escaped candidate paths are rejected before recycling", async (t) => {
  const { root } = await fixture(t);
  const [candidate] = await planCleanup(root, [], { catalog });
  let called = false;
  const options = {
    catalog,
    trashItem: async () => {
      called = true;
    },
  };
  await assert.rejects(
    () =>
      cleanupCandidate(
        root,
        candidate,
        [{ node: { ckpt_name: name } }],
        options,
      ),
    /not eligible/,
  );
  await assert.rejects(
    () =>
      cleanupCandidate(
        root,
        { ...candidate, path: path.join(root, "..", name) },
        [],
        options,
      ),
    /not eligible/,
  );
  await assert.rejects(
    () => cleanupCandidate(root, candidate, [], { catalog }),
    /recycle-bin/,
  );
  assert.equal(called, false);
});

test("live reference refresh prevents recycling when the old model becomes referenced", async (t) => {
  const { root } = await fixture(t);
  const initial = [{ nodes: [] }];
  const [candidate] = await planCleanup(root, initial, { catalog });
  let recycled = false;
  let refreshed = false;
  await assert.rejects(
    () =>
      cleanupCandidate(root, candidate, initial, {
        catalog,
        refreshReferences: async () => {
          refreshed = true;
          return [{ nodes: [{ widgets_values: [name] }] }];
        },
        trashItem: async () => {
          recycled = true;
        },
      }),
    /Live workflow references changed/,
  );
  assert.equal(refreshed, true);
  assert.equal(recycled, false);
});

test("live reference refresh conservatively rejects any changed canvas", async (t) => {
  const { root } = await fixture(t);
  const initial = [{ nodes: [] }];
  const [candidate] = await planCleanup(root, initial, { catalog });
  let recycled = false;
  await assert.rejects(
    () =>
      cleanupCandidate(root, candidate, initial, {
        catalog,
        refreshReferences: async () => [
          { nodes: [{ title: "Changed canvas without legacy model" }] },
        ],
        trashItem: async () => {
          recycled = true;
        },
      }),
    /Live workflow references changed/,
  );
  assert.equal(recycled, false);
});

test("stable live references permit recycling after a fresh saved-workflow scan", async (t) => {
  const { root, file } = await fixture(t);
  const initial = [
    { nodes: [{ widgets_values: ["current-photo-model.safetensors"] }] },
  ];
  const [candidate] = await planCleanup(root, initial, { catalog });
  let recycled = null;
  const result = await cleanupCandidate(root, candidate, initial, {
    catalog,
    refreshReferences: async () => JSON.parse(JSON.stringify(initial)),
    trashItem: async (target) => {
      recycled = target;
    },
  });
  assert.equal(recycled, file);
  assert.equal(result.recycled, true);
});

test("a saved workflow or model edit during the live refresh still prevents recycling", async (t) => {
  const { root, file } = await fixture(t);
  const initial = [{ nodes: [] }];
  const [candidate] = await planCleanup(root, initial, { catalog });
  let recycled = false;
  await assert.rejects(
    () =>
      cleanupCandidate(root, candidate, initial, {
        catalog,
        refreshReferences: async () => {
          const folder = path.join(root, "user");
          await fs.mkdir(folder);
          await fs.writeFile(
            path.join(folder, "just-saved.json"),
            JSON.stringify({ model: name }),
          );
          return initial;
        },
        trashItem: async () => {
          recycled = true;
        },
      }),
    /became referenced/,
  );
  await fs.rm(path.join(root, "user"), { recursive: true });
  await assert.rejects(
    () =>
      cleanupCandidate(root, candidate, initial, {
        catalog,
        refreshReferences: async () => {
          await fs.writeFile(file, "modified after hash");
          return initial;
        },
        trashItem: async () => {
          recycled = true;
        },
      }),
    /changed after verification/,
  );
  assert.equal(recycled, false);
});
