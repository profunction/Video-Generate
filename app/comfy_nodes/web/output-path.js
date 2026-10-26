import { app } from "/scripts/app.js";
import { ComfyWidgets } from "/scripts/widgets.js";
app.registerExtension({
  name: "VideoGenerate.FinalVideoPath",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VG_MergeClips") return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      original?.apply(this, arguments);
      let widget = this.widgets?.find((item) => item.name === "final_mp4_path");
      if (!widget)
        widget = ComfyWidgets.STRING(
          this,
          "final_mp4_path",
          ["STRING", { multiline: true }],
          app,
        ).widget;
      if (widget.inputEl) widget.inputEl.readOnly = true;
      widget.value = Array.isArray(message.text) ? message.text.join("\n") : "";
      this.setSize(this.computeSize());
    };
  },
});
