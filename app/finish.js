const fs = require("node:fs/promises");
const path = require("node:path");
const { run } = require("./engine");
function timestamp(seconds) {
  return new Date(seconds * 1000).toISOString().slice(11, 23).replace(".", ",");
}
function subtitles(scenes) {
  // Scenes without narration keep their 5 s slot but get no (empty, invalid) cue.
  return scenes
    .map((s, i) => ({
      i,
      text: String(s.narration || "")
        .replace(/\s*[\r\n]+\s*/g, " ")
        .trim(),
    }))
    .filter((cue) => cue.text)
    .map(
      (cue, n) =>
        `${n + 1}\n${timestamp(cue.i * 5)} --> ${timestamp((cue.i + 1) * 5)}\n${cue.text}\n`,
    )
    .join("\n");
}
async function finish(project, folder, cfg) {
  const srt = path.join(folder, "subtitles.srt");
  await fs.writeFile(srt, "\uFEFF" + subtitles(project.scenes));
  const input = path.join(folder, "final.mp4"),
    output = path.join(folder, "drama.mp4");
  const args = ["-y", "-i", input];
  if (cfg.narration) {
    if (process.platform !== "win32")
      throw Error(
        "Windows narration needs Windows. Disable narration to export on other systems.",
      );
    const audio = [];
    for (let i = 0; i < project.scenes.length; i++) {
      const text = path.join(folder, `voice-${i}.txt`),
        wav = path.join(folder, `voice-${i}.wav`),
        fixed = path.join(folder, `voice-${i}-normalized.wav`);
      if (project.scenes[i].narration?.trim()) {
        await fs.writeFile(text, project.scenes[i].narration);
        await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(
            __dirname.replace("app.asar", "app.asar.unpacked"),
            "speech.ps1",
          ),
          "-TextFile",
          text,
          "-OutputFile",
          wav,
          ...(cfg.voice ? ["-VoiceName", cfg.voice] : []),
        ]);
        const probe = JSON.parse(
          await run(cfg.ffprobe, [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            wav,
          ]),
        );
        if (Number(probe.format.duration) > 5)
          throw Error(
            `Scene ${i + 1} narration exceeds 5 seconds. Shorten its narration in the storyboard editor.`,
          );
        await run(cfg.ffmpeg, [
          "-y",
          "-i",
          wav,
          "-af",
          "apad",
          "-t",
          "5",
          "-ar",
          "44100",
          "-ac",
          "2",
          fixed,
        ]);
      } else
        await run(cfg.ffmpeg, [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=44100:cl=stereo",
          "-t",
          "5",
          fixed,
        ]);
      audio.push(fixed);
    }
    const list = path.join(folder, "audio.txt");
    await fs.writeFile(
      list,
      audio
        .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n"),
    );
    const narration = path.join(folder, "narration.wav");
    await run(cfg.ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      narration,
    ]);
    args.push("-i", narration);
  }
  args.push("-i", srt, "-map", "0:v:0");
  if (cfg.narration) args.push("-map", "1:a:0");
  args.push("-map", cfg.narration ? "2:0" : "1:0", "-c:v", "copy");
  if (cfg.narration) args.push("-c:a", "aac");
  args.push(
    "-c:s",
    "mov_text",
    "-metadata:s:s:0",
    "language=zho",
    "-movflags",
    "+faststart",
    output,
  );
  await run(cfg.ffmpeg, args);
  return output;
}
module.exports = { subtitles, finish };
