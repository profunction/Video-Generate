const $ = (id) => document.getElementById(id);
const fields = [
  "region",
  "model",
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
    status(e.message);
  }
}
function scene(data = {}) {
  const row = document.createElement("div");
  row.className = "scene";
  row.dataset.localImage = data.localImage || "";
  function field(tag, label, value, kind) {
    const l = document.createElement("label");
    l.textContent = label;
    const el = document.createElement(tag);
    el.value = value || "";
    el.dataset.field = kind;
    l.append(el);
    row.append(l);
    return el;
  }
  field(
    "input",
    "图片网址（使用本地图片 / ComfyUI 时可留空）",
    data.image,
    "image",
  );
  const local = field("input", "本地图片", data.localImage, "localImage");
  local.readOnly = true;
  const pick = document.createElement("button");
  pick.textContent = "选择本地图片";
  pick.className = "secondary";
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
  clear.className = "secondary";
  clear.onclick = () => {
    local.value = "";
    row.dataset.localImage = "";
  };
  row.append(clear);
  field(
    "textarea",
    "ComfyUI 图片提示词（没有图片时自动生图）",
    data.imagePrompt,
    "imagePrompt",
  );
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
  return [...document.querySelectorAll(".scene")].map((row) =>
    Object.fromEntries(
      [...row.querySelectorAll("[data-field]")].map((el) => [
        el.dataset.field,
        el.value.trim(),
      ]),
    ),
  );
}
async function runProject(id) {
  if (active) throw Error("任务正在运行");
  active = true;
  await refresh();
  try {
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
  for (const p of projects.reverse()) {
    const row = document.createElement("div");
    row.className = "project";
    const name = document.createElement("strong");
    name.textContent = `${p.name} · ${p.scenes.length} 镜头 · 已预留 ${Number(p.reserved).toFixed(2)}`;
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
    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "打开项目文件夹";
    open.onclick = () => action(() => window.studio.open(p.id));
    row.append(name, document.createElement("br"), run, edit, open);
    $("projects").append(row);
  }
}
$("save").onclick = () =>
  action(async () => {
    const value = { key: $("key").value };
    for (const f of fields) value[f] = $(f).value;
    value.narration = value.narration === "true";
    await window.studio.saveSettings(value);
    $("key").value = "";
    $("keyStatus").textContent = (await window.studio.settings()).hasKey
      ? "Key 已加密保存"
      : "";
    status("设置已保存");
  });
$("checkLocal").onclick = () =>
  action(async () => {
    status("正在检测已保存的本地服务地址…");
    status(await window.studio.checkLocal());
  });
$("workflow").onclick = () =>
  action(async () => {
    if (await window.studio.importWorkflow()) status("API 工作流已导入");
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
        (s) => !s.prompt || (!s.image && !s.localImage && !s.imagePrompt),
      )
    )
      throw Error("请填写镜头提示词，以及图片网址、本地图片或生图提示词");
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
    const draft = await window.studio.generateStory(
      $("idea").value,
      Number($("count").value),
    );
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
window.studio.onProgress(status);
action(async () => {
  const cfg = await window.studio.settings();
  for (const f of fields) $(f).value = String(cfg[f] ?? "");
  $("keyStatus").textContent = cfg.hasKey ? "Key 已加密保存" : "";
  $("setupStatus").textContent = cfg.setupReady
    ? "已配置，下次生成时自动启动服务"
    : "首次使用请点击一键配置";
  scene();
  await refresh();
});

$("setup").onclick = () =>
  action(async () => {
    if (active) throw Error("请等待当前任务结束");
    active = true;
    $("setup").disabled = true;
    try {
      status("准备配置完整环境…");
      const result = await window.studio.installEnvironment(
        $("setupMode").value,
      );
      if (result.canceled) {
        status("已取消环境下载");
        return;
      }
      const cfg = await window.studio.settings();
      for (const f of fields) $(f).value = String(cfg[f] ?? "");
      $("setupStatus").textContent = "已配置并连接";
    } finally {
      active = false;
      $("setup").disabled = false;
      await refresh();
    }
  });
