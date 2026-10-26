"""Lightweight bridge tests; never invoke an actual paid API or require PyTorch."""
import base64
import importlib.util
import io
import http.server
import threading
import json
import math
import os
import queue
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

SOURCE = Path(__file__).resolve().parents[1] / "app" / "comfy_nodes" / "__init__.py"
spec = importlib.util.spec_from_file_location("video_generate_nodes", SOURCE)
nodes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodes)
PROJECT_ID = "11111111-2222-4333-8444-555555555555"
TOKEN = "bridge-token-never-export-123456789"


class Response:
    def __init__(self, value):
        self.data = json.dumps(value).encode("utf-8")

    def read(self, size):
        return self.data[:size]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / "bridge.json"
        self.write_config("http://127.0.0.1:12345")
        self.env = mock.patch.dict(os.environ, {"VIDEO_GENERATE_BRIDGE_FILE": str(self.config)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write_config(self, url):
        self.config.write_text(json.dumps({"url": url, "token": TOKEN}), encoding="utf-8")

    def test_authenticated_local_post_and_minimal_manifest(self):
        with mock.patch.object(nodes, "_encode_images", return_value=["png-base64"]), mock.patch.object(
            nodes, "_open_local", return_value=Response({"projectId": PROJECT_ID, "token": "must-not-appear"})
        ) as opener:
            result = nodes.WanFiveSecondClips().generate(object(), "Camera pans", "scene-001")
        self.assertEqual(json.loads(result[0]), {"projectId": PROJECT_ID})
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:12345/clips")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(json.loads(request.data), {"jobKey": "scene-001", "motionPrompt": "Camera pans", "images": ["png-base64"]})
        self.assertEqual(opener.call_args.kwargs["timeout"], 7200)
        self.assertNotIn(TOKEN, result[0])
        self.assertEqual(opener.call_count, 1)

    def test_remote_or_credentialed_bridge_is_refused_before_network(self):
        for address in ["https://127.0.0.1:12345", "http://example.com:12345", "http://localhost:12345", "http://127.0.0.1:12345/path", "http://user:secret@127.0.0.1:12345", "http://127.0.0.1:12345?secret=1"]:
            self.write_config(address)
            with self.subTest(address=address), mock.patch.object(nodes, "_open_local") as opener:
                with self.assertRaisesRegex(RuntimeError, "local bridge is unavailable"):
                    nodes._post("/clips", {})
                opener.assert_not_called()

    def test_failure_never_retries_or_discloses_token(self):
        with mock.patch.object(nodes, "_open_local", side_effect=urllib.error.URLError(TOKEN)) as opener:
            with self.assertRaises(RuntimeError) as error:
                nodes._post("/clips", {})
        self.assertEqual(opener.call_count, 1)
        self.assertNotIn(TOKEN, str(error.exception))
        self.assertIn("same job key", str(error.exception))

    def test_redirect_cannot_forward_bridge_credentials(self):
        received = []

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_):
                pass

        target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Target)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()

        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:%s/other" % target.server_port)
                self.end_headers()

            def log_message(self, *_):
                pass

        sender = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        sender_thread = threading.Thread(target=sender.serve_forever, daemon=True)
        sender_thread.start()
        try:
            self.write_config("http://127.0.0.1:%s" % sender.server_port)
            with self.assertRaisesRegex(RuntimeError, "did not finish"):
                nodes._post("/clips", {})
            self.assertEqual(received, [])
        finally:
            sender.shutdown()
            sender.server_close()
            target.shutdown()
            target.server_close()
            sender_thread.join()
            target_thread.join()

    def test_batch_and_prompt_limits_fail_before_http(self):
        class Batch:
            shape = (21, 512, 512, 3)

        with mock.patch.object(nodes, "_post") as post:
            with self.assertRaisesRegex(RuntimeError, "1–20"):
                nodes.WanFiveSecondClips().generate(Batch(), "Walk", "stable-key")
            with self.assertRaisesRegex(RuntimeError, "motion prompt"):
                nodes.WanFiveSecondClips().generate(Batch(), "", "stable-key")
            with self.assertRaisesRegex(RuntimeError, "stable job key"):
                nodes.WanFiveSecondClips().generate(Batch(), "Walk", "")
        post.assert_not_called()

    def test_valid_merge_returns_ui_path_but_never_accepts_arbitrary_paths(self):
        with mock.patch.object(nodes, "_post", return_value={"output": "C:/projects/final.mp4"}) as post:
            result = nodes.MergeClips().merge(json.dumps({"projectId": PROJECT_ID}))
            post.assert_called_once_with("/merge", {"projectId": PROJECT_ID})
        self.assertEqual(result["result"], ("C:/projects/final.mp4",))
        self.assertEqual(result["ui"]["text"], ["C:/projects/final.mp4"])
        for bad in ["../../secret", "C:/secret", "file:///secret", ""]:
            with mock.patch.object(nodes, "_post") as post:
                with self.assertRaises(RuntimeError):
                    nodes.MergeClips().merge(json.dumps({"projectId": bad}))
                post.assert_not_called()

    def test_invalid_job_keys_fail_before_image_conversion(self):
        for job_key in ["../escape", "two words", "a.b", "模型", "a" * 81]:
            with self.subTest(job_key=job_key), mock.patch.object(nodes, "_encode_images") as encode, mock.patch.object(nodes, "_post") as post:
                with self.assertRaisesRegex(RuntimeError, "stable job key"):
                    nodes.WanFiveSecondClips().generate(object(), "Camera pans", job_key)
                encode.assert_not_called()
                post.assert_not_called()

    def test_actual_python_nodes_connect_to_node_flow_gateway(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is needed for the cross-language gateway test")
        module = SOURCE.parents[1] / "flow-gateway.js"
        root = Path(self.directory.name)
        script = r"""
const fs=require('node:fs/promises');
const path=require('node:path');
const {FlowGateway}=require(process.argv[1]);
const root=process.argv[2], calls=[];
const projectId='11111111-2222-4333-8444-555555555555';
const gateway=new FlowGateway({root,handle:async(route,input)=>{
  calls.push({route,input});
  await fs.writeFile(path.join(root,'received.json'),JSON.stringify(calls));
  if(route==='/clips')return {projectId};
  if(route==='/merge' && input.projectId===projectId)return {output:path.join(root,'final.mp4')};
  throw Error('Unexpected fake request');
}});
gateway.start().then(config=>process.stdout.write(JSON.stringify(config)+'\n')).catch(()=>process.exit(1));
process.on('SIGTERM',()=>{gateway.stop();process.exit(0);});
"""
        child = subprocess.Popen(
            [node, "-e", script, str(module), str(root)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        ready = queue.Queue()
        reader = threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            try:
                line = ready.get(timeout=15)
            except queue.Empty:
                self.fail("Node FlowGateway did not start within 15 seconds")
            self.assertTrue(line, "Node FlowGateway exited before readiness")
            config = json.loads(line)
            self.assertTrue(config["url"].startswith("http://127.0.0.1:"))
            config_file = root / "flow-bridge.json"
            self.assertTrue(config_file.is_file())
            with mock.patch.dict(os.environ, {"VIDEO_GENERATE_BRIDGE_FILE": str(config_file)}), mock.patch.object(nodes, "_encode_images", return_value=["cG5n"]):
                manifest = nodes.WanFiveSecondClips().generate(object(), "Slow camera pan", "cross-language-001")[0]
                result = nodes.MergeClips().merge(manifest)
            self.assertEqual(json.loads(manifest), {"projectId": PROJECT_ID})
            self.assertEqual(result["result"], (str(root / "final.mp4"),))
            self.assertEqual(result["ui"]["text"], [str(root / "final.mp4")])
            calls = json.loads((root / "received.json").read_text(encoding="utf-8"))
            self.assertEqual(calls, [
                {"route":"/clips", "input":{"jobKey":"cross-language-001", "motionPrompt":"Slow camera pan", "images":["cG5n"]}},
                {"route":"/merge", "input":{"projectId":PROJECT_ID}},
            ])
            self.assertNotIn(config["token"], manifest)
            self.assertNotIn(config["token"], result["result"][0])
        finally:
            child.terminate()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=5)
            reader.join(timeout=2)

    def test_changed_always_rechecks_persisted_jobs(self):
        self.assertTrue(math.isnan(nodes.WanFiveSecondClips.IS_CHANGED()))
        self.assertTrue(math.isnan(nodes.MergeClips.IS_CHANGED()))
        self.assertTrue(nodes.MergeClips.OUTPUT_NODE)
        self.assertEqual(set(nodes.NODE_CLASS_MAPPINGS), {"VG_WanFiveSecondClips", "VG_MergeClips"})

    def test_pixels_are_clamped_and_png_encoded_without_torch(self):
        try:
            import numpy as np
            from PIL import Image
        except ImportError:
            self.skipTest("Optional NumPy/Pillow are supplied by ComfyUI")
        images = np.array([[[[-1.0, 0.5, 2.0], [float("nan"), float("inf"), float("-inf")]]]], dtype=np.float32)
        encoded = nodes._encode_images(images)
        self.assertEqual(len(encoded), 1)
        image = Image.open(io.BytesIO(base64.b64decode(encoded[0])))
        self.assertEqual(image.format, "PNG")
        self.assertEqual(image.getpixel((0, 0)), (0, 128, 255))
        self.assertEqual(image.getpixel((1, 0)), (0, 255, 0))


if __name__ == "__main__":
    unittest.main()
