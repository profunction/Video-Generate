const fs = require("node:fs/promises");
const path = require("node:path");
const { download, probe, lastFrame, CLIP_SECONDS } = require("./engine");
const DAY = 24 * 60 * 60 * 1000;
const NAMES = { wan: "阿里云 Wan", veo: "Google Veo", zhipu: "智谱 CogVideoX" };
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
// Takes every scene to a downloaded clip. The project is saved before and after
// each paid request, so a crash or a lost response never causes a silent resubmission.
async function produce(
  p,
  folder,
  cfg,
  {
    wan,
    video = wan,
    comfy,
    workflow,
    persist,
    emit = () => {},
    fetcher = fetch,
    now = Date.now,
  },
) {
  const provider = cfg.videoProvider || "wan";
  for (let i = 0; i < p.scenes.length; i++) {
    const s = p.scenes[i],
      n = i + 1;
    if (s.clip) {
      if (await exists(path.join(folder, s.clip))) continue;
      // Your own server is free to ask again.
      if (s.provider === "selfHosted") delete s.clip;
      else if (!s.taskId) throw Error(`镜头 ${n} 的视频文件 ${s.clip} 已丢失`);
      // Download the existing task again instead of paying for a new one.
      delete s.clip;
    }
    if (s.uncertain)
      throw Error(
        `镜头 ${n} 的付费提交结果不确定。请先在视频服务商的控制台核实，不要直接创建替代项目。`,
      );
    if (provider === "selfHosted" && !s.taskId) {
      emit(`自建服务器正在生成镜头 ${n}/${p.scenes.length}…`);
      const clip = `clip-${n}.mp4`,
        file = path.join(folder, clip);
      await video.generate(s, file);
      let duration;
      try {
        duration = await probe(file, cfg);
      } catch (e) {
        await fs.rm(file, { force: true });
        throw e;
      }
      Object.assign(s, {
        clip,
        provider,
        seconds: Math.min(60, Math.max(1, Math.round(duration))),
      });
      await persist();
      continue;
    }
    if (!s.taskId) {
      let source = s.localImage;
      if (i > 0 && s.continuePrevious) {
        // Start from the previous clip's final frame, so characters and setting stay the same.
        emit(`正在截取镜头 ${i} 的最后一帧…`);
        source = await lastFrame(
          path.join(folder, p.scenes[i - 1].clip),
          path.join(folder, `frame-${n}.png`),
          cfg,
        );
      } else if (
        !s.localImage &&
        !s.image &&
        s.imagePrompt &&
        cfg.imageSource !== "none"
      ) {
        const target = path.join(folder, `image-${i}.png`);
        if (comfy)
          for (let attempt = 0; ; attempt++) {
            if (!s.comfyId) {
              emit(`ComfyUI：正在生成镜头 ${n} 的图片…`);
              s.comfyId = await comfy.submit(workflow, s.imagePrompt);
              await persist();
            }
            try {
              await comfy.image(s.comfyId, target);
              break;
            } catch (e) {
              // Local generation is free: resubmit once if a restarted ComfyUI forgot the job.
              if (!e.lost || attempt) throw e;
              delete s.comfyId;
            }
          }
        else {
          // Alibaba Cloud draws the picture. The task ID is saved first, so a resume
          // collects the same picture instead of paying for another one.
          if (!s.imageTask) {
            emit(`阿里云正在画镜头 ${n} 的图片…`);
            s.imageTask = await wan.submitImage(s.imagePrompt);
            await persist();
          }
          let url;
          try {
            url = await wan.poll(
              s.imageTask,
              (status) => emit(`镜头 ${n} 的图片：${status}`),
              (out) => out.results?.find((r) => r.url)?.url,
            );
          } catch (e) {
            // A failed picture is not billed and an expired task cannot be collected: draw it again next time.
            if (e.taskStatus || e.noResult) {
              delete s.imageTask;
              await persist();
            }
            throw e;
          }
          await download(url, target, fetcher);
        }
        s.localImage = source = target;
        await persist();
      }
      let remoteImage = s.image;
      if (provider !== "wan" && !source && s.image) {
        // Veo and Zhipu take the picture itself rather than a link, so fetch it first.
        source = path.join(folder, `image-${i}.png`);
        await download(s.image, source, fetcher);
      }
      if (source && provider === "wan") {
        emit(`正在上传镜头 ${n} 的图片…`);
        remoteImage = await wan.upload(source);
      }
      const reserved = Number(p.reserved || 0);
      // A free provider cannot charge twice, so a lost response need not block the scene.
      const paid = Boolean(CLIP_SECONDS[provider]);
      s.uncertain = true;
      p.reserved =
        reserved + (CLIP_SECONDS[provider] || 0) * Number(cfg.pricePerSecond);
      await persist();
      emit(`正在提交镜头 ${n}…`);
      try {
        s.taskId =
          provider !== "wan"
            ? await video.submit(s, source)
            : await video.submit({ ...s, image: remoteImage });
      } catch (e) {
        if (e.rejected || !paid) {
          // The provider refused the request, so no task exists: release the reservation.
          s.uncertain = false;
          p.reserved = reserved;
          await persist();
        }
        throw e;
      }
      s.provider = provider;
      s.region = cfg.region;
      s.model =
        { veo: cfg.veoModel, zhipu: cfg.zhipuModel }[provider] || cfg.model;
      s.submittedAt = new Date(now()).toISOString();
      s.uncertain = false;
      await persist();
    }
    const used = s.provider || "wan";
    if (used !== provider)
      throw Error(
        `镜头 ${n} 的任务提交给了 ${NAMES[used]}，请把设置里的“视频由谁生成”切换回去后再恢复`,
      );
    if (used === "wan" && s.region !== cfg.region)
      throw Error(
        `镜头 ${n} 的任务提交在 ${s.region} 区域，请把设置切换回该区域后再恢复`,
      );
    let url;
    try {
      url = await video.poll(s.taskId, (status) =>
        emit(`镜头 ${n}/${p.scenes.length}：${status}`),
      );
    } catch (e) {
      const expired =
        Boolean(s.submittedAt) && now() - Date.parse(s.submittedAt) > DAY;
      if (
        e.taskStatus === "FAILED" ||
        e.taskStatus === "CANCELED" ||
        (e.taskStatus === "UNKNOWN" && expired)
      ) {
        // This task can never deliver a clip, so unlock the scene. The reservation
        // stays: only the provider bill shows whether the task was charged.
        s.failedTasks = [...(s.failedTasks || []), s.taskId];
        for (const k of [
          "taskId",
          "provider",
          "region",
          "model",
          "submittedAt",
        ])
          delete s[k];
        await persist();
        throw Error(
          `镜头 ${n} 的视频任务无法完成（${e.message}）。该镜头已解锁，可修改后重新生成；重新提交仍需付费确认。`,
        );
      }
      throw e;
    }
    emit(`正在下载镜头 ${n}…`);
    const clip = `clip-${n}.mp4`,
      file = path.join(folder, clip);
    if (used === "veo") await video.download(url, file);
    else await download(url, file, fetcher);
    let duration;
    try {
      duration = await probe(file, cfg);
    } catch (e) {
      // Keep the task ID so the next run downloads it again without a new job.
      await fs.rm(file, { force: true });
      throw e;
    }
    s.clip = clip;
    s.seconds =
      CLIP_SECONDS[used] || Math.min(60, Math.max(1, Math.round(duration)));
    await persist();
  }
}
module.exports = { produce };
