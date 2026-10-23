const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
function localBase(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw Error("Local AI address must use localhost or 127.0.0.1");
  return url.origin;
}
async function json(url, options = {}, fetcher = fetch) {
  const r = await fetcher(url, {
    signal: AbortSignal.timeout(180000),
    ...options,
  });
  if (!r.ok)
    throw Error(`Local AI HTTP ${r.status}; check service, model and workflow`);
  return r.json();
}
async function storyboard(idea, count, cfg, fetcher = fetch) {
  if (
    typeof idea !== "string" ||
    !idea.trim() ||
    idea.length > 10000 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20
  )
    throw Error("Enter a story idea and 1–20 scenes");
  const data = await json(
    localBase(cfg.ollamaUrl) + "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content: `Write a coherent short drama in exactly ${count} scenes, each 5 seconds. Return JSON only: {"title":"...","scenes":[{"prompt":"English camera movement and action, max 1800 characters","imagePrompt":"English detailed still image prompt; repeat consistent character appearances and style in every scene","narration":"very short spoken line in the user's language, max 15 Chinese characters or 8 English words"}]}. No markdown. Keep characters consistent, give the story a beginning, conflict and ending.`,
          },
          { role: "user", content: idea },
        ],
      }),
    },
    fetcher,
  );
  let parsed;
  try {
    parsed = JSON.parse(data.message?.content);
  } catch {
    throw Error("Ollama returned invalid JSON; try a stronger model");
  }
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length !== count)
    throw Error("Ollama scene count mismatch; retry script generation");
  for (const s of parsed.scenes) {
    for (const field of ["prompt", "imagePrompt", "narration"])
      if (
        typeof s[field] !== "string" ||
        !s[field].trim() ||
        s[field].length > 2000
      )
        throw Error("Ollama returned incomplete scenes");
  }
  return {
    name: String(parsed.title || "AI Drama").slice(0, 100),
    scenes: parsed.scenes.map((s) => ({
      prompt: s.prompt,
      imagePrompt: s.imagePrompt,
      narration: s.narration,
      image: "",
    })),
  };
}
function prepareWorkflow(template, prompt) {
  const graph = JSON.parse(JSON.stringify(template));
  let replaced = false;
  for (const node of Object.values(graph)) {
    if (
      !node ||
      typeof node.class_type !== "string" ||
      typeof node.inputs !== "object"
    )
      throw Error("Import ComfyUI API-format workflow, not UI workflow");
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === "string" && v.includes("{{PROMPT}}")) {
        node.inputs[k] = v.replaceAll("{{PROMPT}}", prompt);
        replaced = true;
      }
      if (["seed", "noise_seed"].includes(k) && typeof v === "number")
        node.inputs[k] = crypto.randomInt(0, 2147483647);
    }
  }
  if (!replaced)
    throw Error("Workflow must contain {{PROMPT}} in the positive prompt text");
  if (!Object.values(graph).some((n) => n.class_type === "SaveImage"))
    throw Error("Workflow must include SaveImage");
  return graph;
}
class Comfy {
  constructor(
    cfg,
    fetcher = fetch,
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.base = localBase(cfg.comfyUrl);
    this.fetch = fetcher;
    this.pause = pause;
  }
  async submit(template, prompt) {
    const out = await json(
      this.base + "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prepareWorkflow(template, prompt),
          client_id: crypto.randomUUID(),
        }),
      },
      this.fetch,
    );
    if (!out.prompt_id)
      throw Error("ComfyUI rejected workflow; check models and nodes");
    return out.prompt_id;
  }
  async image(id, target) {
    for (let i = 0; i < 720; i++) {
      const result = await json(
        this.base + "/history/" + encodeURIComponent(id),
        {},
        this.fetch,
      );
      const job = result[id];
      if (job?.status?.status_str === "error")
        throw Error("ComfyUI generation failed; check its console");
      if (job?.outputs) {
        for (const output of Object.values(job.outputs))
          for (const image of output.images || []) {
            if (image.type !== "output") continue;
            const query = new URLSearchParams({
              filename: image.filename,
              subfolder: image.subfolder || "",
              type: "output",
            });
            const r = await this.fetch(this.base + "/view?" + query, {
              signal: AbortSignal.timeout(120000),
            });
            if (!r.ok) throw Error("Cannot download ComfyUI image");
            const data = Buffer.from(await r.arrayBuffer());
            if (data.length > 20 * 1024 * 1024)
              throw Error("Image exceeds 20 MB");
            await fs.writeFile(target, data);
            return target;
          }
      }
      await this.pause(5000);
    }
    throw Error("ComfyUI timed out; resume project to query existing job");
  }
}
async function checkServices(cfg, fetcher = fetch) {
  const report = [];
  for (const [name, base, route] of [
    ["Ollama", cfg.ollamaUrl, "/api/tags"],
    ["ComfyUI", cfg.comfyUrl, "/system_stats"],
  ]) {
    try {
      const out = await json(localBase(base) + route, {}, fetcher);
      report.push(
        name +
          ": connected" +
          (out.models ? " · " + out.models.map((m) => m.name).join(", ") : ""),
      );
    } catch (e) {
      report.push(name + ": " + e.message);
    }
  }
  return report.join("\n");
}
module.exports = {
  localBase,
  storyboard,
  prepareWorkflow,
  Comfy,
  checkServices,
};
