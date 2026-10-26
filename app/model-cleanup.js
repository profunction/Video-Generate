const fs = require("node:fs/promises");
const nodefs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Only the baseline checkpoint installed by earlier versions is eligible.
// User-added weights, the current photo checkpoint/VAE and Ollama are excluded.
const verifiedStats = new WeakMap();
const LEGACY_MODELS = Object.freeze([
  Object.freeze({
    name: "v1-5-pruned-emaonly.safetensors",
    sha: "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
  }),
]);

function samePath(a, b) {
  const normalize = (value) => {
    const result = path.resolve(value);
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(a) === normalize(b);
}

async function checkPath(file, { missing = false } = {}) {
  // Reject symlinks/junctions in every existing ancestor, not just the leaf.
  let current = path.resolve(file);
  let leaf = null;
  while (true) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (samePath(current, file) && !missing) throw error;
    }
    if (stat?.isSymbolicLink())
      throw Error("Model cleanup refuses symbolic links: " + current);
    if (samePath(current, file)) leaf = stat;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return leaf;
}

function modelName(value) {
  return String(value)
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .trim()
    .toLowerCase();
}

function containsReference(value, names, visited = new WeakSet()) {
  if (typeof value === "string") return names.has(modelName(value));
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  return Object.values(value).some((item) =>
    containsReference(item, names, visited),
  );
}

async function savedWorkflows(comfyDir) {
  const directory = path.join(comfyDir, "user");
  const rootStat = await checkPath(directory, { missing: true });
  if (!rootStat) return [];
  if (!rootStat.isDirectory()) throw Error("ComfyUI user directory is invalid");
  const documents = [];
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const stat = await checkPath(file);
      if (stat.isDirectory()) await visit(file);
      else if (entry.name.toLowerCase().endsWith(".json")) {
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
          throw Error("Cannot safely inspect saved workflow: " + file);
        try {
          documents.push(JSON.parse(await fs.readFile(file, "utf8")));
        } catch {
          throw Error("Cannot parse saved workflow; cleanup stopped: " + file);
        }
      }
    }
  }
  await visit(directory);
  return documents;
}

function catalogEntries(catalog) {
  if (!Array.isArray(catalog)) throw Error("Invalid model cleanup catalog");
  for (const source of catalog) {
    if (
      typeof source.name !== "string" ||
      !source.name ||
      source.name.includes("/") ||
      source.name.includes("\\") ||
      source.name === "." ||
      source.name === ".." ||
      !/^[a-f0-9]{64}$/.test(source.sha)
    )
      throw Error("Invalid model cleanup catalog entry");
  }
  return catalog;
}

async function references(comfyDir, active) {
  if (!Array.isArray(active))
    throw Error("Current workflow references are required for model cleanup");
  return [...active, ...(await savedWorkflows(comfyDir))];
}

async function fingerprint(file) {
  const stat = await checkPath(file);
  if (!stat?.isFile()) throw Error("Model is not a regular file");
  const hash = crypto.createHash("sha256");
  for await (const chunk of nodefs.createReadStream(file)) hash.update(chunk);
  const after = await checkPath(file);
  if (
    !after?.isFile() ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ctimeMs !== after.ctimeMs ||
    stat.ino !== after.ino ||
    stat.dev !== after.dev
  )
    throw Error("Model changed during integrity verification");
  return { sha: hash.digest("hex"), stat: after };
}

async function planCleanup(comfyDir, referenceObjects, options = {}) {
  const rootStat = await checkPath(comfyDir);
  if (!rootStat.isDirectory()) throw Error("Invalid ComfyUI directory");
  const catalog = catalogEntries(options.catalog || LEGACY_MODELS);
  const documents = await references(comfyDir, referenceObjects);
  const candidates = [];
  for (const source of catalog) {
    const names = new Set([modelName(source.name)]);
    if (documents.some((document) => containsReference(document, names)))
      continue;
    const file = path.join(comfyDir, "models", "checkpoints", source.name);
    const stat = await checkPath(file, { missing: true });
    if (!stat) continue;
    if (!stat.isFile()) throw Error("Model is not a regular file: " + file);
    const verified = await fingerprint(file);
    // A changed file may be a user's replacement; never treat it as disposable.
    if (verified.sha !== source.sha) continue;
    const candidate = {
      path: file,
      bytes: verified.stat.size,
      name: source.name,
      sha: source.sha,
    };
    verifiedStats.set(candidate, verified.stat);
    candidates.push(candidate);
  }
  return candidates;
}

async function cleanupCandidate(
  comfyDir,
  candidate,
  referenceObjects,
  { trashItem, catalog = LEGACY_MODELS, refreshReferences } = {},
) {
  if (typeof trashItem !== "function")
    throw Error("Operating-system recycle-bin support is required");
  if (!candidate || typeof candidate.path !== "string")
    throw Error("Invalid model cleanup candidate");
  if (
    refreshReferences !== undefined &&
    typeof refreshReferences !== "function"
  )
    throw Error("Invalid live workflow reference refresh callback");
  // Capture before awaiting the long hash, including when callers reuse/mutate arrays.
  const referenceSnapshot = refreshReferences
    ? JSON.stringify(referenceObjects)
    : null;
  const planned = await planCleanup(comfyDir, referenceObjects, { catalog });
  const eligible = planned.find(
    (item) =>
      samePath(item.path, candidate.path) &&
      item.name === candidate.name &&
      item.sha === candidate.sha &&
      item.bytes === candidate.bytes,
  );
  if (!eligible)
    throw Error("Model is referenced, changed or not eligible for cleanup");
  // Re-fetch the live canvas/queue after the potentially lengthy multi-GB hash.
  // Any change is treated conservatively, even if it references another model.
  let activeReferences = referenceObjects;
  if (refreshReferences) {
    activeReferences = await refreshReferences();
    if (
      !Array.isArray(activeReferences) ||
      JSON.stringify(activeReferences) !== referenceSnapshot
    )
      throw Error("Live workflow references changed; cleanup stopped");
  }
  // Saved JSON is scanned after the live check, followed only by local metadata checks.
  const documents = await references(comfyDir, activeReferences);
  if (
    documents.some((document) =>
      containsReference(document, new Set([modelName(eligible.name)])),
    )
  )
    throw Error("Model became referenced; cleanup stopped");
  const finalStat = await checkPath(eligible.path);
  const verifiedStat = verifiedStats.get(eligible);
  if (
    !finalStat?.isFile() ||
    ["size", "mtimeMs", "ctimeMs", "ino", "dev"].some(
      (key) => finalStat[key] !== verifiedStat[key],
    )
  )
    throw Error("Model changed after verification; cleanup stopped");
  await trashItem(eligible.path);
  return { name: eligible.name, bytes: eligible.bytes, recycled: true };
}

module.exports = { LEGACY_MODELS, planCleanup, cleanupCandidate };
