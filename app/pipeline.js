const fs = require("node:fs/promises");
const path = require("node:path");
const { download, probe, lastFrame } = require("./engine");
const DAY = 24 * 60 * 60 * 1000;
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
    comfy,
    workflow,
    persist,
    emit = () => {},
    fetcher = fetch,
    now = Date.now,
  },
) {
  for (let i = 0; i < p.scenes.length; i++) {
    const s = p.scenes[i],
      n = i + 1;
    if (s.clip) {
      if (await exists(path.join(folder, s.clip))) continue;
      if (!s.taskId) throw Error(`镜头 ${n} 的视频文件 ${s.clip} 已丢失`);
      // Download the existing task again instead of paying for a new one.
      delete s.clip;
    }
    if (s.uncertain)
      throw Error(
        `镜头 ${n} 的付费提交结果不确定。请先在阿里云控制台核实，不要直接创建替代项目。`,
      );
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
      } else if (!s.localImage && !s.image) {
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
      if (source) {
        emit(`正在上传镜头 ${n} 的图片…`);
        remoteImage = await wan.upload(source);
      }
      const reserved = Number(p.reserved || 0);
      s.uncertain = true;
      p.reserved = reserved + 5 * Number(cfg.pricePerSecond);
      await persist();
      emit(`正在提交镜头 ${n}…`);
      try {
        s.taskId = await wan.submit({ ...s, image: remoteImage });
      } catch (e) {
        if (e.rejected) {
          // The provider refused the request, so no task exists: release the reservation.
          s.uncertain = false;
          p.reserved = reserved;
          await persist();
        }
        throw e;
      }
      s.region = cfg.region;
      s.model = cfg.model;
      s.submittedAt = new Date(now()).toISOString();
      s.uncertain = false;
      await persist();
    }
    if (s.region !== cfg.region)
      throw Error(
        `镜头 ${n} 的任务提交在 ${s.region} 区域，请把设置切换回该区域后再恢复`,
      );
    let url;
    try {
      url = await wan.poll(s.taskId, (status) =>
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
        for (const k of ["taskId", "region", "model", "submittedAt"])
          delete s[k];
        await persist();
        throw Error(
          `镜头 ${n} 的 Wan 任务无法完成（${e.message}）。该镜头已解锁，可修改后重新生成；重新提交仍需付费确认。`,
        );
      }
      throw e;
    }
    emit(`正在下载镜头 ${n}…`);
    const clip = `clip-${n}.mp4`,
      file = path.join(folder, clip);
    await download(url, file, fetcher);
    try {
      await probe(file, cfg);
    } catch (e) {
      // Keep the task ID so the next run downloads it again without a new job.
      await fs.rm(file, { force: true });
      throw e;
    }
    s.clip = clip;
    await persist();
  }
}
module.exports = { produce };
