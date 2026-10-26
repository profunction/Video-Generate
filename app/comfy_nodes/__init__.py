"""Video Generate's local-only ComfyUI bridge nodes.

No API credentials are accepted by widgets or stored in exported workflows.
The desktop app owns credentials, budget approval, persistence and paid requests.
"""

import base64
import io
import json
import os
import re
from urllib import request as urllib_request
from urllib.parse import urlsplit
import uuid

MAX_IMAGES = 20
MAX_IMAGE_BYTES = 9 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024
MAX_PIXELS = 16 * 1024 * 1024


def _bridge_config():
    try:
        filename = os.environ["VIDEO_GENERATE_BRIDGE_FILE"]
        with open(filename, "r", encoding="utf-8") as source:
            config = json.loads(source.read(65537))
        url = config["url"]
        token = config["token"]
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or parsed.port is None
            or not 1 <= parsed.port <= 65535
            or not isinstance(token, str)
            or len(token) < 16
            or not token.isascii()
            or any(ord(character) < 33 or ord(character) > 126 for character in token)
        ):
            raise ValueError("Invalid local bridge configuration")
        return parsed.geturl().rstrip("/"), token
    except Exception:
        raise RuntimeError(
            "Video Generate local bridge is unavailable. Open the desktop app "
            "and reload its video workflow."
        ) from None


class _NoRedirect(urllib_request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # A token for the desktop app must never follow an HTTP redirect.
        return None


def _open_local(request, timeout):
    # Never send the local bridge token through a configured external proxy.
    opener = urllib_request.build_opener(urllib_request.ProxyHandler({}), _NoRedirect())
    return opener.open(request, timeout=timeout)


def _post(route, payload):
    if route not in ("/clips", "/merge"):
        raise RuntimeError("Unsupported Video Generate bridge operation")
    url, token = _bridge_config()
    request = urllib_request.Request(
        url + route,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        # A POST must not be retried: the desktop app may already have accepted it.
        with _open_local(request, timeout=7200) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("Response too large")
        result = json.loads(data.decode("utf-8"))
        if not isinstance(result, dict) or result.get("error"):
            raise ValueError("Request rejected")
        return result
    except Exception:
        raise RuntimeError(
            "Video Generate did not finish this request. Check the desktop app's "
            "approval dialog and progress message. Keep the same job key when "
            "resuming; do not create another paid job."
        ) from None


def _project_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError("Not a project UUID")
        return value.lower()
    except (ValueError, TypeError, AttributeError):
        raise RuntimeError("Invalid Video Generate project manifest") from None


def _encode_images(images):
    shape = getattr(images, "shape", None)
    if (
        shape is None
        or len(shape) != 4
        or not 1 <= shape[0] <= MAX_IMAGES
        or shape[1] < 1
        or shape[2] < 1
        or shape[1] * shape[2] > MAX_PIXELS
        or shape[3] not in (3, 4)
    ):
        raise RuntimeError("Connect an IMAGE batch containing 1–20 RGB/RGBA images")

    # ComfyUI supplies these packages; keeping imports lazy permits lightweight tests.
    import numpy as np
    from PIL import Image

    encoded = []
    total_bytes = 0
    for frame in images:
        if hasattr(frame, "detach"):
            frame = frame.detach()
        if hasattr(frame, "cpu"):
            frame = frame.cpu()
        if hasattr(frame, "numpy"):
            frame = frame.numpy()
        pixels = np.asarray(frame)
        pixels = np.nan_to_num(pixels, nan=0.0, posinf=1.0, neginf=0.0)
        pixels = np.rint(np.clip(pixels, 0.0, 1.0) * 255.0).astype(np.uint8)
        buffer = io.BytesIO()
        Image.fromarray(pixels).save(buffer, format="PNG")
        png = buffer.getvalue()
        total_bytes += len(png)
        if len(png) > MAX_IMAGE_BYTES or total_bytes > MAX_TOTAL_IMAGE_BYTES:
            raise RuntimeError("Image batch is too large; reduce image size or batch count")
        encoded.append(base64.b64encode(png).decode("ascii"))
    return encoded


class WanFiveSecondClips:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "motion_prompt": (
                    "STRING",
                    {"multiline": True, "default": "Slow camera movement, natural motion"},
                ),
                "job_key": ("STRING", {"default": "my-video-001"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("clip_manifest",)
    FUNCTION = "generate"
    CATEGORY = "Video Generate / Wan"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def generate(self, images, motion_prompt, job_key):
        if (
            not isinstance(motion_prompt, str)
            or not motion_prompt.strip()
            or len(motion_prompt) > 2000
        ):
            raise RuntimeError("Provide a motion prompt of 1–2000 characters")
        if (
            not isinstance(job_key, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_key) is None
        ):
            raise RuntimeError("Provide a stable job key of 1–80 letters, numbers, hyphens or underscores")
        encoded = _encode_images(images)
        result = _post(
            "/clips",
            {"jobKey": job_key, "motionPrompt": motion_prompt, "images": encoded},
        )
        return (json.dumps({"projectId": _project_id(result.get("projectId"))}),)


class MergeClips:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"manifest": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("final_mp4",)
    FUNCTION = "merge"
    CATEGORY = "Video Generate / Wan"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def merge(self, manifest):
        try:
            if not isinstance(manifest, str) or len(manifest) > 4096:
                raise ValueError("Invalid manifest")
            data = json.loads(manifest)
            project_id = _project_id(data["projectId"])
        except (ValueError, TypeError, KeyError):
            raise RuntimeError("Connect the manifest output from the Wan clips node") from None
        result = _post("/merge", {"projectId": project_id})
        output = result.get("output", result.get("final_mp4"))
        if not isinstance(output, str) or not output or len(output) > 32768:
            raise RuntimeError("Video Generate returned no final MP4 path")
        return {"ui": {"text": [output]}, "result": (output,)}


NODE_CLASS_MAPPINGS = {
    "VG_WanFiveSecondClips": WanFiveSecondClips,
    "VG_MergeClips": MergeClips,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VG_WanFiveSecondClips": "Wan · 5 sec per image (paid approval in app)",
    "VG_MergeClips": "Merge clips → MP4 (Video Generate)",
}

WEB_DIRECTORY = "./web"
