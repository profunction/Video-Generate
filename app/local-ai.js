const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
// Used when no workflow was imported; the checkpoint is matched to ComfyUI's models.
const builtInWorkflow = require("./sd15-workflow.json");
// The same graph as ComfyUI shows it, placed in ComfyUI's workflow list for editing.
const builtInWorkflowUi = require("./sd15-workflow-ui.json");
const LIBRARY = "workflows/Video Generate.json";
// Nodes that exist only in ComfyUI's editor and never run on the server.
const EDITOR_ONLY = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
]);
const CONTROL = ["fixed", "increment", "decrement", "randomize"];
// Converts a workflow saved by ComfyUI's editor into the graph its server runs,
// mapping widget values to inputs in node-definition order as ComfyUI does.
function toApiWorkflow(ui, info) {
  if (!Array.isArray(ui?.nodes) || !Array.isArray(ui.links))
    throw Error(
      "The Video Generate workflow in ComfyUI is damaged; press 改用内置工作流 to restore it",
    );
  if (ui.definitions?.subgraphs?.length)
    throw Error("Subgraphs are not supported; expand them in ComfyUI first");
  const nodes = new Map(ui.nodes.map((n) => [n.id, n]));
  const links = new Map(ui.links.map((l) => [l[0], l]));
  const source = (id, seen = new Set()) => {
    const link = links.get(id);
    if (!link || seen.has(id)) return undefined;
    seen.add(id);
    const [, from, slot, , , type] = link;
    const node = nodes.get(from);
    if (!node || node.mode === 2) return undefined;
    if (node.type === "PrimitiveNode") return node.widgets_values?.[0];
    if (node.type === "Reroute") return source(node.inputs?.[0]?.link, seen);
    // A bypassed node passes on its input of the same type.
    if (node.mode === 4) {
      const pass = node.inputs?.find((i) => i.type === type && i.link != null);
      return pass ? source(pass.link, seen) : undefined;
    }
    return [String(from), slot];
  };
  const graph = {};
  for (const node of ui.nodes) {
    if (EDITOR_ONLY.has(node.type) || node.mode === 2 || node.mode === 4)
      continue;
    const spec = info[node.type];
    if (!spec)
      throw Error(
        `ComfyUI has no node "${node.type}"; install its custom node or remove it`,
      );
    const named =
      node.widgets_values && !Array.isArray(node.widgets_values)
        ? node.widgets_values
        : null;
    const values = Array.isArray(node.widgets_values)
      ? [...node.widgets_values]
      : [];
    const inputs = {};
    for (const group of ["required", "optional"]) {
      const defs = spec.input?.[group] || {};
      for (const name of spec.input_order?.[group] || Object.keys(defs)) {
        const [type, opts = {}] = defs[name] || [];
        const widget =
          !opts.forceInput &&
          (Array.isArray(type) ||
            ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(type));
        let value;
        if (widget) {
          value = named ? named[name] : values.shift();
          // Editor-only companions: seed's "control after generate" and the upload button.
          if (!named && CONTROL.includes(values[0]) && type === "INT")
            values.shift();
          if (!named && opts.image_upload && values[0] === "image")
            values.shift();
        }
        const socket = node.inputs?.find((i) => i.name === name);
        if (socket?.link != null) {
          const from = source(socket.link);
          if (from !== undefined) inputs[name] = from;
        } else if (widget && value !== undefined) inputs[name] = value;
      }
    }
    graph[String(node.id)] = { class_type: node.type, inputs };
  }
  return graph;
}
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
// Pull the useful part out of Ollama ({error}) and ComfyUI ({error, node_errors}) replies.
function describe(body) {
  try {
    const data = JSON.parse(body);
    const node = Object.values(data.node_errors || {})[0]?.errors?.[0];
    return [data.error?.message || data.error, node?.details || node?.message]
      .filter((v) => typeof v === "string" && v)
      .join(" — ");
  } catch {
    return body;
  }
}
async function json(url, options = {}, fetcher = fetch) {
  let r;
  try {
    r = await fetcher(url, {
      signal: AbortSignal.timeout(180000),
      ...options,
    });
  } catch (e) {
    throw Error(
      e.name === "TimeoutError"
        ? `Local AI timed out: ${new URL(url).origin}`
        : `Cannot reach ${new URL(url).origin}; start the service and check its address`,
    );
  }
  if (!r.ok) {
    let detail = "";
    try {
      detail = describe(await r.text()).slice(0, 300);
    } catch {}
    throw Error(
      `Local AI HTTP ${r.status}; check service, model and workflow${detail ? ": " + detail : ""}`,
    );
  }
  return r.json();
}
async function storyboard(
  idea,
  count,
  cfg,
  fetcher = fetch,
  continuous = false,
) {
  if (
    typeof idea !== "string" ||
    !idea.trim() ||
    idea.length > 10000 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20
  )
    throw Error("Enter a story idea and 1–20 scenes");
  const text = { type: "string" };
  const data = await json(
    localBase(cfg.ollamaUrl) + "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // CPU-only machines can need many minutes for a long screenplay.
      signal: AbortSignal.timeout(15 * 60000),
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: false,
        format: {
          type: "object",
          properties: {
            title: text,
            scenes: {
              type: "array",
              minItems: count,
              maxItems: count,
              items: {
                type: "object",
                properties: {
                  prompt: text,
                  imagePrompt: text,
                  narration: text,
                },
                required: ["prompt", "imagePrompt", "narration"],
              },
            },
          },
          required: ["title", "scenes"],
        },
        // The default context window truncates long screenplays into invalid JSON.
        options: { num_ctx: 8192 },
        messages: [
          {
            role: "system",
            content: `Write a coherent short drama in exactly ${count} scenes, each 5 seconds. ${continuous ? "The scenes form one continuous take in a single location: each scene's video starts from the last frame of the previous scene, so describe only what happens next, with no cuts, time jumps or location changes. " : ""}Return JSON only: {"title":"...","scenes":[{"prompt":"English camera movement and action, max 1800 characters","imagePrompt":"English detailed still image prompt; repeat consistent character appearances and style in every scene","narration":"very short spoken line in the user's language, max 15 Chinese characters or 8 English words"}]}. No markdown. Keep characters consistent, give the story a beginning, conflict and ending.`,
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
  if (!Array.isArray(parsed?.scenes) || parsed.scenes.length < count)
    throw Error("Ollama scene count mismatch; retry script generation");
  const scenes = parsed.scenes.slice(0, count);
  for (const s of scenes) {
    for (const field of ["prompt", "imagePrompt", "narration"])
      if (
        typeof s?.[field] !== "string" ||
        !s[field].trim() ||
        s[field].length > 2000
      )
        throw Error("Ollama returned incomplete scenes");
  }
  return {
    name: String(parsed.title || "AI Drama").slice(0, 100),
    scenes: scenes.map((s) => ({
      prompt: s.prompt.trim(),
      imagePrompt: s.imagePrompt.trim(),
      narration: s.narration.trim(),
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
        // A replacer function keeps "$&", "$$" etc. in prompts literal.
        node.inputs[k] = v.replaceAll("{{PROMPT}}", () => prompt);
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
// Prefer an SD1.5 checkpoint; skip SDXL, Flux, SD2/3 and video models this workflow cannot drive.
function pickCheckpoint(names) {
  const sd15 = /v1[-_.]?5|sd[-_]?1[-_.]?5/i;
  const other =
    /xl|flux|sd[-_]?[23]|v2[-_.]?[01]|cascade|svd|hunyuan|wan|ltx|pony|illustrious|hidream|qwen|kolors|pixart/i;
  return (
    names.find((n) => sd15.test(n)) || names.find((n) => !other.test(n)) || null
  );
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
  library() {
    return this.base + "/api/userdata/" + encodeURIComponent(LIBRARY);
  }
  async request(url, options = {}) {
    try {
      return await this.fetch(url, {
        signal: AbortSignal.timeout(30000),
        ...options,
      });
    } catch {
      throw Error(
        `Cannot reach ${this.base}; start the service and check its address`,
      );
    }
  }
  // Puts the editable workflow into ComfyUI's workflow list, keeping an existing copy unless told otherwise.
  async publish(ui, overwrite = false) {
    const r = await this.request(this.library() + `?overwrite=${overwrite}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ui, null, 2),
    });
    if (r.status === 409) return false;
    if (!r.ok)
      throw Error(`ComfyUI HTTP ${r.status} while saving the workflow`);
    return true;
  }
  // The "Video Generate" workflow as last saved in ComfyUI, converted for the server, or null.
  async edited() {
    const r = await this.request(this.library());
    if (r.status === 404) return null;
    if (!r.ok)
      throw Error(`ComfyUI HTTP ${r.status} while reading the workflow`);
    const ui = await r.json();
    const info = {};
    for (const type of new Set(ui?.nodes?.map((n) => n.type)))
      if (!EDITOR_ONLY.has(type))
        Object.assign(
          info,
          await json(
            this.base + "/object_info/" + encodeURIComponent(type),
            {},
            this.fetch,
          ),
        );
    return toApiWorkflow(ui, info);
  }
  async checkpoints() {
    const info = await json(
      this.base + "/object_info/CheckpointLoaderSimple",
      {},
      this.fetch,
    );
    const spec = info.CheckpointLoaderSimple?.input?.required?.ckpt_name;
    const names = spec?.[0] === "COMBO" ? spec[1]?.options : spec?.[0];
    return Array.isArray(names) ? names : [];
  }
  // Swaps checkpoint names ComfyUI does not have (such as the example's placeholder)
  // for an installed SD1.5 model, and returns the models the graph will load.
  async resolve(graph) {
    const loaders = Object.values(graph).filter(
      (n) => n.class_type === "CheckpointLoaderSimple",
    );
    if (!loaders.length) return [];
    const installed = await this.checkpoints();
    for (const node of loaders) {
      if (installed.includes(node.inputs.ckpt_name)) continue;
      const model = pickCheckpoint(installed);
      if (!model)
        throw Error(
          "ComfyUI has no SD1.5 model; put v1-5-pruned-emaonly-fp16.safetensors into ComfyUI/models/checkpoints and press R in ComfyUI",
        );
      node.inputs.ckpt_name = model;
    }
    return loaders.map((n) => n.inputs.ckpt_name);
  }
  // Checks the connection and the model before anything is paid for.
  async ready(template) {
    return this.resolve(prepareWorkflow(template, "preflight"));
  }
  async submit(template, prompt) {
    const graph = prepareWorkflow(template, prompt);
    await this.resolve(graph);
    const out = await json(
      this.base + "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: graph,
          client_id: crypto.randomUUID(),
        }),
      },
      this.fetch,
    );
    if (!out.prompt_id)
      throw Error("ComfyUI rejected workflow; check models and nodes");
    return out.prompt_id;
  }
  async job(id) {
    const result = await json(
      this.base + "/history/" + encodeURIComponent(id),
      {},
      this.fetch,
    );
    return result[id];
  }
  async queued(id) {
    const queue = await json(this.base + "/queue", {}, this.fetch);
    return [
      ...(queue.queue_running || []),
      ...(queue.queue_pending || []),
    ].some((item) => item?.[1] === id);
  }
  async image(id, target) {
    for (let i = 0; i < 720; i++) {
      let job = await this.job(id);
      if (!job && !(await this.queued(id))) {
        // Read history again: the job may have finished between both requests.
        job = await this.job(id);
        if (!job) {
          const error = Error(
            "ComfyUI no longer knows this job; it was probably restarted",
          );
          error.lost = true;
          throw error;
        }
      }
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
        throw Error(
          "ComfyUI finished without a saved image; the workflow needs a SaveImage output",
        );
      }
      await this.pause(5000);
    }
    throw Error("ComfyUI timed out; resume project to query existing job");
  }
}
async function checkServices(cfg, fetcher = fetch) {
  const report = [];
  for (const [name, base, route, usual] of [
    ["Ollama", cfg.ollamaUrl, "/api/tags", ["http://127.0.0.1:11434"]],
    [
      "ComfyUI",
      cfg.comfyUrl,
      "/system_stats",
      ["http://127.0.0.1:8188", "http://127.0.0.1:8000"],
    ],
  ]) {
    try {
      const out = await json(localBase(base) + route, {}, fetcher);
      const names = out.models?.map((m) => m.name);
      report.push(
        name +
          ": connected" +
          (names ? " · " + names.join(", ") : "") +
          (names &&
          ![cfg.ollamaModel, cfg.ollamaModel + ":latest"].some((m) =>
            names.includes(m),
          )
            ? `\nOllama: model ${cfg.ollamaModel} is not installed; run: ollama pull ${cfg.ollamaModel}`
            : ""),
      );
    } catch (e) {
      // A mistyped port is the usual cause, so look where the service normally listens.
      let hint = `\n→ 没有找到正在运行的 ${name}，请先启动它`;
      for (const other of usual) {
        if (String(base).replace(/\/+$/, "") === other) continue;
        try {
          await json(
            other + route,
            { signal: AbortSignal.timeout(3000) },
            fetcher,
          );
          hint = `\n→ ${name} 正在 ${other} 运行：把设置里的“${name} 地址”改成它`;
          break;
        } catch {}
      }
      report.push(name + ": " + e.message + hint);
    }
  }
  return report.join("\n");
}
module.exports = {
  localBase,
  storyboard,
  prepareWorkflow,
  pickCheckpoint,
  toApiWorkflow,
  builtInWorkflow,
  builtInWorkflowUi,
  Comfy,
  checkServices,
};
