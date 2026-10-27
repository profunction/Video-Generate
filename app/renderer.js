const $ = (id) => document.getElementById(id);
const fields = [
  "region",
  "model",
  "scriptSource",
  "imageSource",
  "textModel",
  "imageModel",
  "pricePerSecond",
  "budget",
  "ffmpeg",
  "ffprobe",
  "ollamaUrl",
  "ollamaModel",
  "comfyUrl",
  "narration",
  "voice",
];
let active = false,
  editing = null;
function status(message) {
  $("status").textContent = message;
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    status(
      String(e.message).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
    );
  }
}
function scene(data = {}) {
  const row = document.createElement("div");
  row.className = "scene";
  row.dataset.localImage = data.localImage || "";
  // Submitted scenes keep their visuals; only the narration can change.
  const locked = Boolean(data.taskId || data.uncertain || data.clip);
  if (locked) {
    row.classList.add("locked");
    const note = document.createElement("p");
    note.textContent = "已提交到 Wan：画面已锁定，只能修改旁白";
    row.append(note);
  }
  function field(tag, label, value, kind) {
    const l = document.createElement("label");
    l.textContent = label;
    const el = document.createElement(tag);
    el.value = value || "";
    el.dataset.field = kind;
    el.readOnly = locked && kind !== "narration";
    l.append(el);
    row.append(l);
    return el;
  }
  const join = document.createElement("label");
  join.className = "continue";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.dataset.field = "continuePrevious";
  box.checked = Boolean(data.continuePrevious);
  box.disabled = locked;
  box.onchange = () => row.classList.toggle("continuing", box.checked);
  row.classList.toggle("continuing", box.checked);
  join.append(box, "接上一个镜头的最后一帧（人物和场景不变，不需要图片）");
  row.append(join);
  field(
    "input",
    "图片网址（使用本地图片 / ComfyUI 时可留空）",
    data.image,
    "image",
  ).parentElement.classList.add("visual");
  const local = field("input", "本地图片", data.localImage, "localImage");
  local.readOnly = true;
  local.parentElement.classList.add("visual");
  if (!locked) {
    const pick = document.createElement("button");
    pick.textContent = "选择本地图片";
    pick.className = "secondary visual";
    pick.onclick = () =>
      action(async () => {
        const file = await window.studio.pickImage();
        if (file) {
          local.value = file;
          row.dataset.localImage = file;
        }
      });
    row.append(pick);
    const clear = document.createElement("button");
    clear.textContent = "清除本地图片";
    clear.className = "secondary visual";
    clear.onclick = () => {
      local.value = "";
      row.dataset.localImage = "";
    };
    row.append(clear);
  }
  field(
    "textarea",
    "图片提示词（没有图片时，由阿里云或 ComfyUI 按它画图）",
    data.imagePrompt,
    "imagePrompt",
  ).parentElement.classList.add("visual");
  field("textarea", "Wan 镜头动作提示词", data.prompt, "prompt");
  field(
    "textarea",
    "旁白 / 字幕（每镜头不超过 5 秒）",
    data.narration,
    "narration",
  );
  if (!editing) {
    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "删除镜头";
    remove.onclick = () => row.remove();
    row.append(remove);
  }
  $("scenes").append(row);
}
function sceneValues() {
  return [...document.querySelectorAll(".scene")].map((row, i) => {
    const values = Object.fromEntries(
      [...row.querySelectorAll("[data-field]")].map((el) => [
        el.dataset.field,
        el.type === "checkbox" ? el.checked : el.value.trim(),
      ]),
    );
    // The first scene has nothing to continue from.
    values.continuePrevious = i > 0 && values.continuePrevious === true;
    return values;
  });
}
async function runProject(id) {
  if (active) throw Error("任务正在运行");
  active = true;
  try {
    await refresh();
    status("正在检查项目…");
    const result = await window.studio.run(id);
    if (result.canceled) status("已取消，未提交新任务");
  } finally {
    active = false;
    await refresh();
  }
}
async function refresh() {
  const projects = await window.studio.list();
  $("projects").replaceChildren();
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "project";
    const name = document.createElement("strong");
    name.textContent = `${p.name} · ${p.scenes.length} 镜头 · 已预留 ${Number(p.reserved).toFixed(2)}`;
    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "打开项目文件夹";
    open.onclick = () => action(() => window.studio.open(p.id));
    if (p.broken) {
      row.append(name, document.createElement("br"), open);
      $("projects").append(row);
      continue;
    }
    const run = document.createElement("button");
    run.textContent = p.output ? "重新导出" : "生成 / 恢复";
    run.disabled = active;
    run.onclick = () => action(() => runProject(p.id));
    const edit = document.createElement("button");
    edit.textContent = "编辑分镜 / 旁白";
    edit.className = "secondary";
    edit.disabled = active;
    edit.onclick = () => {
      editing = p.id;
      $("name").value = p.name;
      $("scenes").replaceChildren();
      p.scenes.forEach(scene);
      $("create").textContent = "保存修改";
      $("add").disabled = true;
      $("scenes").scrollIntoView({ behavior: "smooth" });
      status("已提交的镜头只可修改旁白；修改后重新导出。");
    };
    row.append(name, document.createElement("br"), run, edit, open);
    $("projects").append(row);
  }
}
async function saveSettings() {
  const value = { key: $("key").value };
  for (const f of fields) value[f] = $(f).value;
  value.narration = value.narration === "true";
  await window.studio.saveSettings(value);
  $("key").value = "";
  $("keyStatus").textContent = (await window.studio.settings()).hasKey
    ? "Key 已加密保存"
    : "";
}
$("save").onclick = () =>
  action(async () => {
    await saveSettings();
    status("设置已保存");
  });
// Buttons that talk to Ollama or ComfyUI save the addresses on screen first.
$("checkLocal").onclick = () =>
  action(async () => {
    await saveSettings();
    status("设置已保存，正在检测本地服务…");
    status(await window.studio.checkLocal());
  });
$("workflow").onclick = () =>
  action(async () => {
    if (await window.studio.importWorkflow()) status("API 工作流已导入");
  });
$("builtin").onclick = () =>
  action(async () => {
    await saveSettings();
    status(
      (await window.studio.resetWorkflow())
        ? "已改用内置 SD1.5 工作流，ComfyUI 里的“Video Generate”工作流也恢复成了默认设置"
        : "已改用内置 SD1.5 工作流。ComfyUI 没有打开，里面的“Video Generate”工作流没有恢复；打开 ComfyUI 后再点一次",
    );
  });
$("comfyEdit").onclick = () =>
  action(async () => {
    await saveSettings();
    await window.studio.editWorkflow();
    status(
      "已在浏览器打开 ComfyUI。在左边的“工作流”（Workflows）列表里打开“Video Generate”，调整后按 Ctrl+S 保存；app 下次画图会自动用你保存的版本。列表里没看到就刷新一下页面。",
    );
  });
$("add").onclick = () => scene();
$("newProject").onclick = () => {
  editing = null;
  $("name").value = "";
  $("scenes").replaceChildren();
  $("create").textContent = "保存项目";
  $("add").disabled = false;
  scene();
};
$("create").onclick = () =>
  action(async () => {
    const scenes = sceneValues();
    if (
      !scenes.length ||
      scenes.some(
        (s) =>
          !s.prompt ||
          (!s.continuePrevious && !s.image && !s.localImage && !s.imagePrompt),
      )
    )
      throw Error(
        "请填写镜头提示词；第 1 个镜头和不接上一镜头的镜头还需要图片网址、本地图片或生图提示词",
      );
    if (editing) await window.studio.update(editing, scenes);
    else await window.studio.create({ name: $("name").value, scenes });
    await refresh();
    status("项目已保存");
  });
async function write() {
  if (active) throw Error("任务正在运行");
  active = true;
  try {
    status("Ollama 正在生成剧本，请稍候…");
    const continuous = $("flow").value === "continue";
    const draft = await window.studio.generateStory(
      $("idea").value,
      Number($("count").value),
      continuous,
    );
    draft.scenes.forEach((s, i) => (s.continuePrevious = continuous && i > 0));
    editing = null;
    $("name").value = draft.name;
    $("create").textContent = "保存项目";
    $("add").disabled = false;
    $("scenes").replaceChildren();
    draft.scenes.forEach(scene);
    status("剧本已生成，可以编辑分镜、图片提示词和旁白。");
    return draft;
  } finally {
    active = false;
  }
}
$("write").onclick = () => action(write);
$("automatic").onclick = () =>
  action(async () => {
    const draft = await write();
    const project = await window.studio.create(draft);
    await refresh();
    await runProject(project.id);
  });
// Show the Ollama and ComfyUI settings only when the local option is chosen.
function syncSources() {
  for (const el of document.querySelectorAll(".ollama-only"))
    el.hidden = $("scriptSource").value !== "ollama";
  for (const el of document.querySelectorAll(".comfy-only"))
    el.hidden = $("imageSource").value !== "comfyui";
}
$("scriptSource").onchange = syncSources;
$("imageSource").onchange = syncSources;
window.studio.onProgress(status);
action(async () => {
  const cfg = await window.studio.settings();
  for (const f of fields) $(f).value = String(cfg[f] ?? "");
  syncSources();
  $("keyStatus").textContent = cfg.hasKey ? "Key 已加密保存" : "";
  scene();
  await refresh();
});
