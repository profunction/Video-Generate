"""ComfyUI custom node: generate video through Zhipu's hosted CogVideoX API
(open.bigmodel.cn), instead of running a model on local GPU.

Install: copy this whole folder into ComfyUI/custom_nodes/, then restart
ComfyUI. A node called "Zhipu Video Generate (CogVideoX)" appears under the
"Zhipu" category.
"""
import json
import os
import time
import urllib.error
import urllib.request

try:
    import folder_paths
except ImportError:  # running outside ComfyUI, e.g. for a quick manual test
    folder_paths = None

API_BASE = "https://open.bigmodel.cn/api/paas/v4"


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
    ):
        if not api_key.strip():
            raise ValueError("Zhipu API Key is empty. Get one at open.bigmodel.cn.")
        body = {"model": model, "prompt": prompt, "size": size, "fps": fps}
        if image_url.strip():
            body["image_url"] = image_url.strip()
        try:
            submitted = _post("/videos/generations", api_key, body)
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                "Zhipu rejected the request: HTTP %s %s" % (e.code, e.read().decode())
            )
        task_id = submitted.get("id")
        if not task_id:
            raise RuntimeError("Zhipu returned no task id: %r" % submitted)

        deadline = time.time() + poll_seconds
        result = None
        while time.time() < deadline:
            time.sleep(5)
            result = _get("/async-result/" + task_id, api_key)
            status = result.get("task_status")
            if status == "SUCCESS":
                break
            if status == "FAIL":
                raise RuntimeError("Zhipu generation failed: %r" % result)
        else:
            raise RuntimeError(
                "Timed out after %ss waiting for task %s" % (poll_seconds, task_id)
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
