const { localBase } = require("./local-ai");
const TOOLBAR_HEIGHT = 104;
function allowedNavigation(base, target) {
  try {
    const url = new URL(target);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === localBase(base)
    );
  } catch {
    return false;
  }
}
class FlowEditor {
  constructor(window, View) {
    this.window = window;
    this.View = View;
    this.view = null;
    this.base = null;
    this.visible = false;
    window.on("resize", () => this.resize());
    window.on("closed", () => this.destroy());
  }
  resize() {
    if (!this.view || !this.visible || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }
  async show(address) {
    const base = localBase(address);
    if (!this.view || this.base !== base) {
      this.destroy();
      this.base = base;
      this.view = new this.View({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          partition: "persist:comfy-flow",
        },
      });
      this.view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const event of ["will-navigate", "will-redirect"])
        this.view.webContents.on(event, (e, url) => {
          if (!allowedNavigation(base, url)) e.preventDefault();
        });
      try {
        await this.view.webContents.loadURL(base + "/");
      } catch {
        this.destroy();
        throw Error("ComfyUI 界面加载失败，请先完成环境配置并检查本地服务。");
      }
    }
    if (!this.visible) {
      this.window.contentView.addChildView(this.view);
      this.visible = true;
    }
    this.resize();
    this.view.webContents.focus();
  }
  hide() {
    if (this.view && this.visible) {
      if (!this.window.isDestroyed())
        this.window.contentView.removeChildView(this.view);
      this.visible = false;
    }
  }
  async currentPrompt() {
    if (!this.view || !this.visible) throw Error("请先打开 Flow 节点编辑器");
    try {
      return await this.view.webContents.executeJavaScript(
        `(async()=>{const {app}=await import('/scripts/app.js');if(!app?.graphToPrompt)throw Error('unsupported');const result=await app.graphToPrompt();return result.output;})()`,
      );
    } catch {
      throw Error(
        "无法读取当前 Flow，请等界面加载完成。若使用自定义前端，请从 ComfyUI 导出 API JSON 后导入。",
      );
    }
  }
  async snapshot() {
    if (!this.view) throw Error("请先打开 Flow 编辑器，以检查当前画布模型引用");
    return this.view.webContents.executeJavaScript(
      `(async()=>{const {app}=await import('/scripts/app.js');return await app.graphToPrompt();})()`,
    );
  }
  async loadPrompt(graph) {
    if (!this.view || !this.visible) throw Error("请先打开 Flow 节点编辑器");
    const data = JSON.stringify(JSON.stringify(graph));
    try {
      await this.view.webContents.executeJavaScript(
        `(async()=>{const {app}=await import('/scripts/app.js');if(!app?.loadApiJson)throw Error('unsupported');if(app.refreshComboInNodes)await app.refreshComboInNodes();await app.loadApiJson(JSON.parse(${data}),'Video Generate flow');})()`,
      );
    } catch {
      throw Error(
        "无法载入默认 Flow。你仍可在 ComfyUI 界面直接拖入自己的工作流 JSON。",
      );
    }
  }
  destroy() {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed())
      this.view.webContents.close({ waitForBeforeUnload: false });
    this.view = null;
    this.base = null;
  }
}
module.exports = { FlowEditor, allowedNavigation, TOOLBAR_HEIGHT };
