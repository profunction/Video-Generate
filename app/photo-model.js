const fs = require("node:fs/promises");
const path = require("node:path");

// Author-published weights pinned to immutable Hugging Face revisions.
// The checkpoint's author explicitly recommends the separate MSE VAE.
const PHOTO = {
  id: "realistic-vision-5.1",
  name: "Realistic Vision 5.1 + MSE VAE",
  checkpoint: {
    filename: "Realistic_Vision_V5.1_fp16-no-ema.safetensors",
    url: "https://huggingface.co/SG161222/Realistic_Vision_V5.1_noVAE/resolve/1e9f017a7b1eaefb63a1900ea6c5953d2739fd21/Realistic_Vision_V5.1_fp16-no-ema.safetensors",
    sha: "99a75a901f4fec732056930a89fa34cf360f6f72d75ce5bf333ddf82adf8dd2a",
    size: 2132625894,
  },
  vae: {
    filename: "vae-ft-mse-840000-ema-pruned.safetensors",
    url: "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/629b3ad3030ce36e15e70c5db7d91df0d60c627f/vae-ft-mse-840000-ema-pruned.safetensors",
    sha: "735e4c3a447a3255760d7f86845f09f937809baa529c17370d83e4c3758f3c75",
    size: 334641190,
  },
  licenses: [
    {
      name: "CreativeML OpenRAIL-M",
      url: "https://huggingface.co/SG161222/Realistic_Vision_V5.1_noVAE/blob/1e9f017a7b1eaefb63a1900ea6c5953d2739fd21/README.md",
    },
    {
      name: "MIT",
      url: "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/blob/629b3ad3030ce36e15e70c5db7d91df0d60c627f/README.md",
    },
  ],
};

function photoWorkflow() {
  return {
    1: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: PHOTO.checkpoint.filename },
    },
    2: {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "realistic photograph, natural soft daylight, balanced exposure, subject in sharp focus, {{PROMPT}}",
        clip: ["1", 1],
      },
    },
    3: {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "blurry, low quality, jpeg artifacts, deformed hands, extra fingers, distorted face, duplicate, bad anatomy, overexposed, excessive glow, cartoon, drawing, watermark, text",
        clip: ["1", 1],
      },
    },
    4: {
      class_type: "EmptyLatentImage",
      inputs: { width: 768, height: 512, batch_size: 1 },
    },
    5: {
      class_type: "KSampler",
      inputs: {
        seed: 1,
        steps: 25,
        cfg: 6,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    6: {
      class_type: "VAELoader",
      inputs: { vae_name: PHOTO.vae.filename },
    },
    7: {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["6", 0] },
    },
    8: {
      class_type: "SaveImage",
      inputs: { filename_prefix: "VideoGeneratePhoto", images: ["7", 0] },
    },
  };
}

async function ensurePhotoAssets(comfyDir, { download, report = () => {} }) {
  if (typeof download !== "function")
    throw new Error("A verified model downloader is required");
  try {
    await fs.access(path.join(comfyDir, "main.py"));
  } catch {
    throw new Error(
      "ComfyUI main.py was not found; select its application directory",
    );
  }
  const checkpointDir = path.join(comfyDir, "models", "checkpoints");
  const vaeDir = path.join(comfyDir, "models", "vae");
  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.mkdir(vaeDir, { recursive: true });
  await download(
    PHOTO.checkpoint,
    path.join(checkpointDir, PHOTO.checkpoint.filename),
    report,
  );
  await download(PHOTO.vae, path.join(vaeDir, PHOTO.vae.filename), report);
  return photoWorkflow();
}

module.exports = { PHOTO, photoWorkflow, ensurePhotoAssets };
