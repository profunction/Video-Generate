# Video Generate · AI Short Drama Studio

Windows 10/11 x64 Electron 桌面应用，现已接通：

**故事创意 → Ollama 剧本与分镜 → ComfyUI 图片 → 阿里云 Wan 视频 → 下载 → FFmpeg → 系统配音 / 字幕 → MP4**

ComfyUI 可选；也可以直接选择本地图片或填写 HTTPS 图片网址。云端 Wan 不需要 NVIDIA GPU。本地模型的速度和显存要求取决于所选模型。程序不要求 Docker 或自建云服务器。

## 下载与安装

在仓库的 **Actions → Windows installer → 成功运行 → Artifacts** 下载 `Video-Generate-Windows-x64`，解压并运行 `.exe`。安装包未代码签名。应用可安装到已有版本之上；请先备份项目，默认保留旧配置与数据。

开发：Node.js 22+，运行 `npm ci`、`npm start`。Windows 打包：`npm run dist:win`。

## Flow 节点编辑器（0.4 版）

程序顶部新增 **Flow 节点编辑器** 标签，将本机 ComfyUI 的完整前端嵌入桌面工作区。可以把普通工作流 JSON 拖到画布，看到节点与连线，修改节点、连线和参数，通过 ComfyUI 的运行按钮出图，并用其菜单保存工作流；无需先转换成 API JSON，也不要求占位符才能在画布运行。

1. 完成一键环境配置，或保存已运行的本机 ComfyUI 地址。
2. 点击“Flow 节点编辑器”。程序会启动已配置的托管服务，然后打开编辑画布。
3. 拖入你自己的工作流 JSON。也可以点击“载入程序生图 Flow”，把程序当前配置的 API 图转换到画布；该按钮会替换当前画布内容，使用前先保存自己的修改。
4. 修改提示词、模型和连线，在 ComfyUI 中运行和保存。默认生图图仅使用本机 CPU / 所选 GPU，不会自动调用 Wan。第三方 Flow 依赖的额外模型和自定义节点仍需安装；含云端节点的第三方 Flow 可能自行收费，请了解所导入的内容。
5. 在“短剧工作台”和“Flow 节点编辑器”之间切换会保留当前画布。
6. 要把正在编辑的生图图用于“故事 → 图片 → 视频”自动流程，在正向提示词保留 `{{PROMPT}}`，保留 `SaveImage`，再点击“用于自动短剧生图”。程序会备份原工作流后保存当前 API 图。Wan 视频仍在短剧工作台按预算和确认流程提交。

节点画布是真实 ComfyUI 前端，不是另写的简化编辑器。编辑器独立沙箱运行，没有桌面程序 API Key 或 Node.js 桥接。只有当前本机 ComfyUI 地址可以在该视图导航。自定义前端若不支持 `/scripts/app.js` 的 `graphToPrompt` / `loadApiJson`，仍可在其界面拖入、编辑和运行；与自动短剧同步时需要通过菜单导出 API JSON，再从工作台导入。

Windows 桌面 smoke 使用轻量模拟前端验证嵌入视图、JSON 拖放事件、API 图读取与载入、标签切换保留状态、尺寸调整和权限隔离；它不等于真实 ComfyUI 工作流或 Windows 11 的实机验收。

## 推荐：一键环境配置（0.3 版）

安装本程序后，直接点击顶部 **一键下载、安装并连接**，选择 CPU 通用模式或兼容的 NVIDIA 模式，并确认下载。程序会：

1. 自动下载并校验固定版本的 Ollama、ComfyUI Windows portable、FFmpeg 和解压工具。
2. 自动下载 Qwen2.5 1.5B 剧本模型与 SD1.5 图片模型，创建默认工作流。
3. 自动启动仅监听本机的两个服务（端口 11435 / 18188），保存全部连接与工具路径。
4. 以后点击生成时自动启动服务，退出应用时停止本次启动的服务。

**不用分别安装 Ollama、ComfyUI、FFmpeg，也不用手动导入工作流。** 首次联网下载预计约 10 GB，需要至少 25 GB 空间，建议 16 GB 内存。CPU 模式不要求 NVIDIA，速度取决于硬件。下载中断后再次点击配置可以继续已保留的下载；文件 SHA-256 校验通过后才解压或执行。暂不支持自动配置 Windows ARM。

环境配置完成后，只需在应用中填写并保存 **阿里云 Key、区域、模型、当前价格和预算**，再输入故事，点击“一键生成完整短剧”。云端付费调用仍需用户确认；下载模型不会调用 Wan。

工具保存在应用数据目录下的 `tools`，日志为 `local-services.log`。环境设置会备份原有 settings / workflow，然后替换本地服务地址和默认工作流；现有 Key 与项目保留。程序会占用本机 11435 / 18188 端口。无法连接下载源时需解决电脑网络问题后重试。中文系统配音仍需 Windows 安装可用中文 SAPI 语音，可关闭配音保留字幕。首次大型下载、真实模型和完整 Windows 11 环境配置尚未实机验收，自动测试使用小型模拟下载。

下载源和许可证： [Ollama / MIT](https://github.com/ollama/ollama)、[Qwen2.5 / Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)、[ComfyUI / GPL-3.0](https://github.com/Comfy-Org/ComfyUI)、[SD1.5 / CreativeML OpenRAIL-M](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5)、[FFmpeg GPL 构建](https://github.com/GyanD/codexffmpeg)、[7-Zip](https://www.7-zip.org/license.txt)。可执行文件和模型在用户电脑上首次下载，不包含在约 100 MB 的主安装包中。

## 高级：使用自己已安装的工具（替代自动配置）

1. 安装 [Ollama for Windows](https://ollama.com/download/windows)，在终端运行 `ollama pull qwen2.5:7b`。模型名称可改成你已有的模型。默认地址 `http://127.0.0.1:11434`。
2. 可选：安装 [ComfyUI](https://docs.comfy.org/installation/desktop/windows) 与适合电脑的生图模型，启动服务。默认连接地址 `http://127.0.0.1:8188`，以实际启动日志为准。硬件不适合本地生图时，跳过 ComfyUI，使用已有图片。
3. 在 ComfyUI 中先确认工作流能成功出图，再**导出 API 格式 JSON**（不是普通界面工作流）。将正向文本提示词中的故事内容替换为 `{{PROMPT}}`，保留负向提示词，确保包含 `SaveImage` 节点。在本应用点击“导入 ComfyUI API 工作流”。只导入可信的工作流，模型和自定义节点须事先安装。
   - 仓库提供 [SD1.5 示例工作流](examples/comfy-sd15-api.json)。先将 `ckpt_name` 改成 ComfyUI `models/checkpoints` 下已安装的 SD1.5 文件名，再导入。SDXL / Flux 等模型需要各自兼容的工作流。
4. 安装 [FFmpeg](https://www.gyan.dev/ffmpeg/builds/)，把 FFmpeg 和 FFprobe 加入 PATH，或在应用填写两个 `.exe` 的完整路径。
5. 在应用填写阿里云百炼 / DashScope API Key、相匹配的北京或新加坡区域及该区域可用的 Wan 模型。默认 `wan2.2-i2v-flash`，固定请求 5 秒、720P。按官方当前报价填写每秒价格和项目预算，币种相同。价格默认 0，未填写前无法付费生成。
6. 按需开启“Windows 配音”。系统须安装相应语言的传统 SAPI 桌面语音；Windows 设置中的部分自然语音不支持 System.Speech。语音名称可留空使用默认语音，或填写已安装的 SAPI 名称。每镜头旁白须短于 5 秒，过长时程序会提示编辑，不会静默裁切。
7. 点击“保存设置”，再点击“检测 Ollama / ComfyUI”。应用连接本地服务；**主安装包不包含 Ollama、ComfyUI、模型、FFmpeg**；顶部一键环境配置会在首次使用时自动下载。

## 一键生成

输入故事创意和镜头数量，点击“一键生成完整短剧”。应用自动调用 Ollama、保存项目，然后连接 ComfyUI 逐镜头生图并上传，接着调用 Wan、下载视频、合并并导出字幕与可选配音。**每次提交新的付费 Wan 任务前必须在原生对话框明确批准**；取消则不会上传图片或提交新视频任务。Ollama 剧本生成属于本地操作，不需要 Wan Key。

也可以点击“生成剧本并编辑”，检查人物、提示词和旁白后保存项目，再“生成 / 恢复”。手动路径可使用图片网址或“选择本地图片”，本地图片复制到项目内保存；空图片配合生图提示词会使用 ComfyUI。

“编辑分镜 / 旁白”支持修改已保存项目；已提交 Wan 的镜头锁定视觉提示词和图片，避免已有任务与编辑内容不一致，但仍可修改旁白并重新导出。未提交镜头修改生图提示词后，需清空原有本地图片才能重新生图。要改变镜头数量，请新建项目。

## 导出与恢复

- `final.mp4`：1280×720 / 24fps，无声合并版本。
- `drama.mp4`：有旁白文本时生成，包含可选的配音和可切换字幕轨；播放器中开启字幕即可显示。
- `subtitles.srt`：每镜头 5 秒的独立字幕文件。
- `image-*.png`、`clip-*.mp4`：中间素材，保存在项目文件夹中。

中断后点击“生成 / 恢复”：ComfyUI 保存 prompt ID 后继续查结果；Wan 保存 task ID 后继续轮询，不重新提交。ComfyUI 服务需保留任务历史；丢失历史时请编辑尚未提交的镜头以重建图片。任务期间保持窗口开启。图像提示词重复描述人物以改善一致性，但不能保证人物完全一致；参考图与角色 LoRA 等可在工作流中自行配置。

本地和 ComfyUI 图片经用户付费确认后自动上传到 [DashScope 临时文件空间](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)，不需要另配 OSS Key，有效期 48 小时，仅供个人低频使用；阿里云不建议用于生产高并发。应用提交前重新上传，避免复用过期 URL。生产部署请改用长期 OSS 存储。图片与提示词会发送给阿里云。HTTP 下载、API / 模型可用性受账号、网络和区域影响。

## 数据与费用保护

Windows Key 使用 Electron safeStorage / DPAPI 加密，保存在 Electron userData 目录。项目保存在其 `projects` 子目录，通过“打开项目文件夹”访问；卸载默认不删除。旧版项目无须迁移。

付费提交不自动重试；轮询对 429 / 5xx 退避重试。每次付费请求发出前写入预留费用和提交状态，任务成功响应后记录 ID。若请求结果不明，镜头标记为 `uncertain` 并停止，防止重复收费。此时先到阿里云控制台核实，找到 ID 后关闭应用、备份 JSON，再给镜头设置 `taskId`、`region`、`model` 与 `uncertain: false`，然后恢复；不要未经核实创建替代项目。

预留费用保守累计，失败不自动退款；预算由用户填写价格估算，不能代替云账号额度，也不能限制其他客户端消费。下载失败可以恢复。轮询超时后可再次恢复。

## 验证范围

`npm test` 覆盖预算、付费请求不重复提交、轮询、结构化剧本验证、工作流参数替换、字幕时间轴，以及模拟 Ollama → ComfyUI → 图片上传 → Wan 后实际用 FFmpeg 生成 MP4 和字幕轨的连通测试。模拟服务不会产生云费用。

Windows CI 安装 FFmpeg，执行测试、Electron 系统加密 / 中文路径 / 界面隔离 smoke，并构建 NSIS 安装包。Windows Server CI 不等于 Windows 11 实机验证。尚未在真实 Ollama / ComfyUI 模型、Windows 11 和真实付费 Wan 上完成验收；请按 [验收清单](docs/WINDOWS-ACCEPTANCE.md) 验证。开发过程中未提交付费请求。

当前没有背景音乐混音或角色训练功能。
