# ComfyUI → Zhipu CogVideoX node

A ComfyUI custom node that calls Zhipu's hosted video API
(`open.bigmodel.cn`, free `cogvideox-flash` model) instead of running a
model on local GPU. Lets you see and edit the job as a ComfyUI graph on a
machine with no GPU — the node just makes HTTP calls.

## Install

1. Download ComfyUI's portable Windows build (no Python/Git needed):
   https://github.com/comfyanonymous/ComfyUI/releases
   — grab the `ComfyUI_windows_portable_nvidia.7z` (or the CPU build if
   offered) and extract it anywhere.
2. Copy this whole `comfyui-zhipu-node` folder into
   `ComfyUI_windows_portable\ComfyUI\custom_nodes\`.
3. Run `run_nvidia_gpu.bat` (or `run_cpu.bat`) once to start ComfyUI, then
   open the printed `http://127.0.0.1:8188` address in your browser. The
   batch files only need a GPU for *other* nodes; this one does not use one.
4. In the ComfyUI graph, add node → Zhipu → **Zhipu Video Generate
   (CogVideoX)**. Or load `workflow.json` from this folder (drag it onto
   the canvas, or use the menu's "Open" / "Load" with API-format workflows
   enabled) and replace `PASTE_YOUR_ZHIPU_API_KEY_HERE` with your real key
   from https://open.bigmodel.cn (API Keys page).
5. Click "Queue Prompt". The node submits the job, polls every 5 seconds,
   and saves the finished MP4 into ComfyUI's `output/` folder. Its two
   outputs are the local file path and the remote URL.

## Local image → video

Connect a core **Load Image** node's `IMAGE` output into this node's
optional `image` input to drive image-to-video from a local file, instead
of (or in addition to) the `image_url` text box. The node encodes the
first frame of the batch as a PNG data URI (`data:image/png;base64,...`)
and shrinks it automatically if it would exceed Zhipu's 5 MB limit for
`image_url`. If both `image` and `image_url` are set, `image` wins; if
neither is set, it's plain text-to-video.

## Notes

- `image_url` (text) is optional: leave it empty for text-to-video, set it
  to a public HTTPS image URL, or use the `image` input above instead.
- The API key is typed directly into the node widget and stays only in
  your local `workflow.json` / ComfyUI's saved graph — it is not sent
  anywhere but to `open.bigmodel.cn`. Don't share a workflow file with
  your key filled in.
- A `1305` error from Zhipu ("该模型当前访问量过大") means the free model
  is temporarily overloaded — requeue the prompt after a short wait. A
  `1211` error ("模型不存在") usually means the key was created on Z.ai
  instead of bigmodel.cn, or the model isn't enabled for that account —
  check it in bigmodel.cn's playground. A `401` means the key itself is
  invalid or mistyped.
- This node only talks to Zhipu's API; it is unrelated to the Video
  Generate desktop app's own ComfyUI integration (which drives *local*
  GPU workflows for image/video generation).
