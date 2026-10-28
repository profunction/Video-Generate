# Video Generate · AI Short Drama Studio

Windows 10/11 x64 Electron 桌面应用，现已接通：

**故事创意 → Ollama 剧本与分镜 → ComfyUI 图片 → 阿里云 Wan 视频 → 下载 → FFmpeg → 系统配音 / 字幕 → MP4**

ComfyUI 可选；也可以直接选择本地图片或填写 HTTPS 图片网址。云端 Wan 不需要 NVIDIA GPU。本地模型的速度和显存要求取决于所选模型。程序不要求 Docker 或自建云服务器。

## 下载与安装

在仓库的 **Actions → Windows installer → 成功运行 → Artifacts** 下载 `Video-Generate-Windows-x64`，解压并运行 `.exe`。安装包未代码签名。应用可安装到已有版本之上；请先备份项目，默认保留旧配置与数据。

开发：Node.js 22+，运行 `npm ci`、`npm start`。Windows 打包：`npm run dist:win`。

## 首次配置（只需一次）

1. 安装 [Ollama for Windows](https://ollama.com/download/windows)，在终端运行 `ollama pull qwen2.5:7b`。模型名称可改成你已有的模型。默认地址 `http://127.0.0.1:11434`。
2. 可选：安装 [ComfyUI](https://docs.comfy.org/installation/desktop/windows) 与适合电脑的生图模型，启动服务。默认连接地址 `http://127.0.0.1:8188`，以实际启动日志为准。硬件不适合本地生图时，跳过 ComfyUI，使用已有图片。
3. 在 ComfyUI 中先确认工作流能成功出图，再**导出 API 格式 JSON**（不是普通界面工作流）。将正向文本提示词中的故事内容替换为 `{{PROMPT}}`，保留负向提示词，确保包含 `SaveImage` 节点。在本应用点击“导入 ComfyUI API 工作流”。只导入可信的工作流，模型和自定义节点须事先安装。
   - 仓库提供 [SD1.5 示例工作流](examples/comfy-sd15-api.json)。先将 `ckpt_name` 改成 ComfyUI `models/checkpoints` 下已安装的 SD1.5 文件名，再导入。SDXL / Flux 等模型需要各自兼容的工作流。
3.5. 可选：批量生产时想省去云端 Wan 视频费用，可把“视频生成方式”切换为“本地 ComfyUI”。需在 ComfyUI 中部署支持图生视频的 Wan 模型（如 Wan2.1/2.2 i2v），导出该工作流的 API 格式 JSON：`LoadImage` 节点的图片名替换为 `{{IMAGE}}`，正向提示词替换为 `{{PROMPT}}`，并包含 `VHS_VideoCombine` 或 `SaveVideo` 节点输出 MP4，然后点击“导入 ComfyUI 视频工作流”。仓库提供一份未经真实 ComfyUI 验证的 [Wan i2v 参考模板](examples/comfy-wan-i2v-api.json)，节点名称和权重文件名需按自己安装的版本调整。本地生成不计入预算检查、不弹出付费确认，但会占满显卡显存并消耗电费或租用算力的费用，应用不统计这部分开销；14B 级别的 Wan i2v 模型官方建议较大显存（如 80GB），轻量/量化版本可在消费级显卡（如 24GB 显存）上运行，具体以所选模型文档为准。云端算力市场的价格会变动，请在相应平台的实时价格页确认后再租用。
4. 安装 [FFmpeg](https://www.gyan.dev/ffmpeg/builds/)，把 FFmpeg 和 FFprobe 加入 PATH，或在应用填写两个 `.exe` 的完整路径。
5. 在应用填写阿里云百炼 / DashScope API Key、相匹配的北京或新加坡区域及该区域可用的 Wan 模型。默认 `wan2.2-i2v-flash`，固定请求 5 秒、720P。按官方当前报价填写每秒价格和项目预算，币种相同。价格默认 0，未填写前无法付费生成。
6. 按需开启“Windows 配音”。系统须安装相应语言的传统 SAPI 桌面语音；Windows 设置中的部分自然语音不支持 System.Speech。语音名称可留空使用默认语音，或填写已安装的 SAPI 名称。每镜头旁白须短于 5 秒，过长时程序会提示编辑，不会静默裁切。
7. 点击“保存设置”，再点击“检测 Ollama / ComfyUI”。应用连接这些已安装的服务；**安装包不包含 Ollama、ComfyUI、模型、FFmpeg**，不会自动下载大型模型。

## 一键生成

输入故事创意和镜头数量，点击“一键生成完整短剧”。应用自动调用 Ollama、保存项目，然后连接 ComfyUI 逐镜头生图并上传，接着调用 Wan、下载视频、合并并导出字幕与可选配音。**每次提交新的付费 Wan 任务前必须在原生对话框明确批准**；取消则不会上传图片或提交新视频任务。Ollama 剧本生成属于本地操作，不需要 Wan Key。

也可以点击“生成剧本并编辑”，检查人物、提示词和旁白后保存项目，再“生成 / 恢复”。手动路径可使用图片网址或“选择本地图片”，本地图片复制到项目内保存；空图片配合生图提示词会使用 ComfyUI。

“编辑分镜 / 旁白”支持修改已保存项目；已提交 Wan 的镜头锁定视觉提示词和图片，避免已有任务与编辑内容不一致，但仍可修改旁白并重新导出。未提交镜头修改生图提示词后，需清空原有本地图片才能重新生图。要改变镜头数量，请新建项目。

## 导出与恢复

- `final.mp4`：1280×720 / 24fps，无声合并版本。
- `drama.mp4`：有旁白文本时生成，包含可选的配音和可切换字幕轨；播放器中开启字幕即可显示。
- `subtitles.srt`：每镜头 5 秒的独立字幕文件。
- `image-*.png`、`clip-*.mp4`：中间素材，保存在项目文件夹中。

中断后点击“生成 / 恢复”：ComfyUI 保存 prompt ID 后继续查结果；本地视频模式下 ComfyUI 同样保存视频任务 ID 后继续查结果；Wan 保存 task ID 后继续轮询，不重新提交。ComfyUI 服务需保留任务历史；丢失历史时请编辑尚未提交的镜头以重建图片。任务期间保持窗口开启。图像提示词重复描述人物以改善一致性，但不能保证人物完全一致；参考图与角色 LoRA 等可在工作流中自行配置。

本地和 ComfyUI 图片经用户付费确认后自动上传到 [DashScope 临时文件空间](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)，不需要另配 OSS Key，有效期 48 小时，仅供个人低频使用；阿里云不建议用于生产高并发。应用提交前重新上传，避免复用过期 URL。生产部署请改用长期 OSS 存储。图片与提示词会发送给阿里云。HTTP 下载、API / 模型可用性受账号、网络和区域影响。

## 数据与费用保护

Windows Key 使用 Electron safeStorage / DPAPI 加密，保存在 Electron userData 目录。项目保存在其 `projects` 子目录，通过“打开项目文件夹”访问；卸载默认不删除。旧版项目无须迁移。

付费提交不自动重试；轮询对 429 / 5xx 退避重试。每次付费请求发出前写入预留费用和提交状态，任务成功响应后记录 ID。若请求结果不明，镜头标记为 `uncertain` 并停止，防止重复收费。此时先到阿里云控制台核实，找到 ID 后关闭应用、备份 JSON，再给镜头设置 `taskId`、`region`、`model` 与 `uncertain: false`，然后恢复；不要未经核实创建替代项目。

预留费用保守累计，失败不自动退款；预算由用户填写价格估算，不能代替云账号额度，也不能限制其他客户端消费。下载失败可以恢复。轮询超时后可再次恢复。

## 验证范围

`npm test` 覆盖预算、付费请求不重复提交、轮询、结构化剧本验证、图片 / 视频工作流参数替换、字幕时间轴，以及模拟 Ollama → ComfyUI → 图片上传 → Wan 后实际用 FFmpeg 生成 MP4 和字幕轨的连通测试，还有本地 ComfyUI 图生视频（上传图片、提交工作流、轮询、下载片段）的模拟测试。模拟服务不会产生云费用。本地视频工作流模板未经真实 ComfyUI 实例验证，使用前请先在 ComfyUI 中手动跑通。

Windows CI 安装 FFmpeg，执行测试、Electron 系统加密 / 中文路径 / 界面隔离 smoke，并构建 NSIS 安装包。Windows Server CI 不等于 Windows 11 实机验证。尚未在真实 Ollama / ComfyUI 模型、Windows 11 和真实付费 Wan 上完成验收；请按 [验收清单](docs/WINDOWS-ACCEPTANCE.md) 验证。开发过程中未提交付费请求。

当前没有背景音乐混音、自动安装模型或角色训练功能。
