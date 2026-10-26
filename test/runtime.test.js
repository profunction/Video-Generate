const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { asset, workflow, managedSettings, SOURCES } = require("../app/runtime");
const { prepareWorkflow } = require("../app/local-ai");
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
test("managed setup binds private ports, supplies model and a usable default workflow", () => {
  const cfg = managedSettings("C:\\Studio");
  assert.equal(new URL(cfg.ollamaUrl).hostname, "127.0.0.1");
  assert.equal(new URL(cfg.comfyUrl).port, "18188");
  assert.equal(cfg.ollamaModel, "qwen2.5:1.5b");
  const graph = prepareWorkflow(workflow(), "A clockmaker");
  assert.match(graph["2"].inputs.text, /A clockmaker/);
  assert.equal(graph["1"].inputs.ckpt_name, "Realistic_Vision_V5.1_fp16-no-ema.safetensors");
  for (const source of Object.values(SOURCES)) {
    assert.equal(new URL(source.url).protocol, "https:");
    assert.match(source.sha, /^[a-f0-9]{64}$/);
  }
});
test("tool download resumes partial data, verifies digest and does not redownload completed files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-download-"));
  try {
    const file = path.join(dir, "tool.zip");
    await fs.writeFile(file + ".part", "abc");
    let calls = 0;
    const source = { url: "https://example.com/tool.zip", sha: sha("abcdef") };
    const mock = async (_, options) => {
      calls++;
      assert.equal(options.headers.Range, "bytes=3-");
      return new Response("def", {
        status: 206,
        headers: { "content-range": "bytes 3-5/6", "content-length": "3" },
      });
    };
    await asset(source, file, () => {}, mock);
    assert.equal(await fs.readFile(file, "utf8"), "abcdef");
    await asset(source, file, () => {}, mock);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("download restarts when server ignores Range and rejects corrupted executables", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-integrity-"));
  try {
    const file = path.join(dir, "tool.exe"),
      source = { url: "https://example.com/tool.exe", sha: sha("valid") };
    await fs.writeFile(file + ".part", "old");
    await asset(
      source,
      file,
      () => {},
      async () => new Response("valid"),
    );
    assert.equal(await fs.readFile(file, "utf8"), "valid");
    await fs.rm(file);
    await assert.rejects(
      () =>
        asset(
          source,
          file,
          () => {},
          async () => new Response("corrupted"),
        ),
      /checksum/,
    );
    await assert.rejects(() => fs.access(file));
    await assert.rejects(() => fs.access(file + ".part"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
