"""ComfyUI custom node: generate video through Zhipu's hosted CogVideoX API
(open.bigmodel.cn), instead of running a model on local GPU.

Install: copy this whole folder into ComfyUI/custom_nodes/, then restart
ComfyUI. A node called "Zhipu Video Generate (CogVideoX)" appears under the
"Zhipu" category.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request
from io import BytesIO

try:
    import folder_paths
except ImportError:  # running outside ComfyUI, e.g. for a quick manual test
    folder_paths = None

API_BASE = "https://open.bigmodel.cn/api/paas/v4"
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Zhipu's CogVideoX image_url limit


def _post(path, api_key, body):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def _get(path, api_key):
    req = urllib.request.Request(
        API_BASE + path, headers={"Authorization": "Bearer " + api_key}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def _http_error_message(e, where):
    if e.code == 401:
        return (
            "Zhipu API Key invalid or expired (%s). Check it was copied in full "
            "with no extra spaces, or generate a new one at open.bigmodel.cn." % where
        )
    try:
        detail = e.read().decode("utf-8", "ignore")
    except Exception:
        detail = ""
    return "Zhipu HTTP %s during %s: %s" % (e.code, where, detail)


def _raise_for_api_error(data, model):
    """Zhipu can return 200 OK with an {"error": {...}} body."""
    err = data.get("error")
    if not err:
        return
    code = str(err.get("code", ""))
    msg = err.get("message", "")
    if code == "1305":
        raise RuntimeError(
            "智谱模型当前访问量过大（1305），这是免费模型高峰期常见现象，请隔几分钟后重试。"
        )
    if code == "1211":
        raise RuntimeError(
            '智谱提示模型 "%s" 不存在（1211：%s）。请确认这个 API Key 是在 '
            "open.bigmodel.cn（智谱国内平台）创建的，不是 Z.ai；再去体验中心确认该模型"
            "对你的账号可用，模型代号不一致时改一下节点的 model 输入。" % (model, msg)
        )
    raise RuntimeError("智谱返回错误 %s: %s" % (code, msg))


def _image_tensor_to_data_uri(image_tensor, max_bytes=MAX_IMAGE_BYTES):
    """Encode the first image of a ComfyUI IMAGE batch (float tensor, 0..1,
    shape [B,H,W,C]) as a data: URI PNG, shrinking it until it fits Zhipu's
    size limit."""
    import numpy as np
    from PIL import Image

    frame = image_tensor[0]
    if hasattr(frame, "cpu"):
        frame = frame.cpu().numpy()
    else:
        frame = np.asarray(frame)
    arr = np.clip(frame * 255.0, 0, 255).astype("uint8")
    img = Image.fromarray(arr)

    scale = 1.0
    for _ in range(8):
        candidate = img
        if scale < 1.0:
            w, h = img.size
            candidate = img.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS
            )
        buf = BytesIO()
        candidate.save(buf, format="PNG")
        data = buf.getvalue()
        if len(data) <= max_bytes:
            return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        scale *= 0.75
    raise RuntimeError(
        "本地图片编码后仍超过智谱 5MB 的限制（已尝试多次缩小），请换一张更小/更简单的图片。"
    )


class ZhipuVideoGenerate:
    """Submits a text/image-to-video job to Zhipu, polls until done, and
    downloads the result into ComfyUI's output folder."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "api_key": ("STRING", {"default": "", "multiline": False}),
                "prompt": (
                    "STRING",
                    {"multiline": True, "default": "让画面动起来"},
                ),
                "model": ("STRING", {"default": "cogvideox-flash"}),
                "size": ("STRING", {"default": "1280x960"}),
                "fps": ("INT", {"default": 30, "min": 1, "max": 60}),
                "poll_seconds": ("INT", {"default": 300, "min": 10, "max": 1800}),
            },
            "optional": {
                "image_url": (
                    "STRING",
                    {"default": "", "multiline": False},
                ),
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("local_path", "remote_url")
    FUNCTION = "generate"
    CATEGORY = "Zhipu"
    OUTPUT_NODE = True

    def generate(
        self,
        api_key,
        prompt,
        model,
        size,
        fps,
        poll_seconds,
        image_url="",
        image=None,
    ):
        if not api_key.strip():
            raise ValueError("Zhipu API Key is empty. Get one at open.bigmodel.cn.")

        body = {"model": model, "prompt": prompt, "size": size, "fps": fps}
        # A connected Load Image node wins over the image_url text box;
        # neither set means plain text-to-video.
        if image is not None:
            body["image_url"] = _image_tensor_to_data_uri(image)
        elif image_url.strip():
            body["image_url"] = image_url.strip()

        try:
            submitted = _post("/videos/generations", api_key, body)
        except urllib.error.HTTPError as e:
            raise RuntimeError(_http_error_message(e, "submit"))
        except urllib.error.URLError as e:
            raise RuntimeError("连不上智谱服务器，请检查网络连接：%s" % e.reason)
        _raise_for_api_error(submitted, model)
        task_id = submitted.get("id")
        if not task_id:
            raise RuntimeError("Zhipu returned no task id: %r" % submitted)

        deadline = time.time() + poll_seconds
        result = None
        last_poll_error = None
        while time.time() < deadline:
            time.sleep(5)
            try:
                result = _get("/async-result/" + task_id, api_key)
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    raise RuntimeError(_http_error_message(e, "poll"))
                last_poll_error = "HTTP %s" % e.code
                continue
            except urllib.error.URLError as e:
                last_poll_error = str(e.reason)
                continue
            _raise_for_api_error(result, model)
            status = result.get("task_status")
            if status == "SUCCESS":
                break
            if status == "FAIL":
                raise RuntimeError("智谱生成失败: %r" % result)
        else:
            extra = ("，最后一次查询出错：%s" % last_poll_error) if last_poll_error else ""
            raise RuntimeError(
                "等待超时（%ss），任务 %s 仍未完成%s。可以去 bigmodel.cn 控制台用这个任务ID"
                "查状态，或者把 poll_seconds 调大一点再试。" % (poll_seconds, task_id, extra)
            )

        videos = result.get("video_result") or []
        if not videos or not videos[0].get("url"):
            raise RuntimeError("Zhipu reported success but sent no video URL: %r" % result)
        remote_url = videos[0]["url"]

        out_dir = folder_paths.get_output_directory() if folder_paths else "."
        os.makedirs(out_dir, exist_ok=True)
        local_path = os.path.join(out_dir, "zhipu_%s.mp4" % task_id)
        with urllib.request.urlopen(remote_url, timeout=300) as r, open(
            local_path, "wb"
        ) as f:
            f.write(r.read())

        return (local_path, remote_url)


NODE_CLASS_MAPPINGS = {"ZhipuVideoGenerate": ZhipuVideoGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ZhipuVideoGenerate": "Zhipu Video Generate (CogVideoX)"
}
