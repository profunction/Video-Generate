const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ENDPOINTS = { china: 'https://dashscope.aliyuncs.com', international: 'https://dashscope-intl.aliyuncs.com' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Wan {
  constructor(settings, key, fetcher = fetch, pause = delay) { this.settings = settings; this.key = key; this.fetch = fetcher; this.pause = pause; }
  async request(route, body) {
    const response = await this.fetch(ENDPOINTS[this.settings.region] + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...(body ? {'X-DashScope-Async':'enable'} : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    if (!response.ok) { const error = new Error(`Wan HTTP ${response.status}. Check region, model, quota and credentials.`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
    const data = await response.json(); if (data.code) throw new Error(`Wan: ${data.code}`); return data;
  }
  async submit(scene) {
    // Never retry POST automatically: a lost response may still have created a paid job.
    const data = await this.request('/api/v1/services/aigc/video-generation/video-synthesis', { model: this.settings.model, input: {prompt: scene.prompt, img_url: scene.image}, parameters: {resolution:'720P', duration:5, prompt_extend:true} });
    if (!data.output?.task_id) throw new Error('Wan returned no task ID. Check provider console before retrying.');
    return data.output.task_id;
  }
  async poll(id, progress) {
    for (let i=0;i<360;i++) {
      let data;
      for (let attempt=0;attempt<4;attempt++) {
        try { data = await this.request('/api/v1/tasks/' + encodeURIComponent(id)); break; }
        catch(error) { if (!error.retryable || attempt===3) throw error; await this.pause(1000 * 2**attempt); }
      }
      const out = data.output || {}; progress(out.task_status || 'UNKNOWN');
      if (out.task_status==='SUCCEEDED') { if (!out.video_url) throw new Error('Missing video URL'); return out.video_url; }
      if (['FAILED','CANCELED','UNKNOWN'].includes(out.task_status)) throw new Error(`Task ${out.task_status}: ${out.code || 'see provider console'}`);
      await this.pause(10000);
    }
    throw new Error('Polling timed out. Resume this task later; do not resubmit.');
  }
}
function validate(project, settings) {
  if (!ENDPOINTS[settings.region] || !/^wan[\w.-]+$/.test(settings.model)) throw new Error('Invalid Wan region or model');
  if (!Array.isArray(project.scenes) || !project.scenes.length || project.scenes.length>50) throw new Error('Provide 1–50 scenes');
  for (const scene of project.scenes) {
    if (typeof scene.prompt!=='string' || !scene.prompt.trim() || scene.prompt.length>2000) throw new Error('Each scene needs a prompt of at most 2000 characters');
    let url; try { url = new URL(scene.image); } catch { throw new Error('Each scene needs a public HTTPS image URL'); }
    if (url.protocol!=='https:' || url.username || url.password) throw new Error('Use public HTTPS image URLs');
  }
  const rate=Number(settings.pricePerSecond), budget=Number(settings.budget);
  if (!Number.isFinite(rate) || rate<=0 || !Number.isFinite(budget) || budget<=0) throw new Error('Enter a positive price per second and budget');
  const estimate = project.scenes.filter(s=>!s.taskId && !s.clip).length * 5 * rate;
  if (Number(project.reserved || 0) + estimate > budget + 1e-8) throw new Error('Project budget exceeded. Review reserved spend and pricing.');
  return estimate;
}
async function download(url, destination, fetcher=fetch) {
  if (new URL(url).protocol!=='https:') throw new Error('Unsafe video URL');
  const response=await fetcher(url,{signal:AbortSignal.timeout(300000)});
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
  const { Readable }=require('node:stream'); const { pipeline }=require('node:stream/promises');
  const temporary=destination+'.part';
  try { await pipeline(Readable.fromWeb(response.body), require('node:fs').createWriteStream(temporary)); await fs.rename(temporary,destination); }
  catch(error) { await fs.rm(temporary,{force:true}); throw error; }
}
function run(binary,args) { return new Promise((resolve,reject)=>{ const child=spawn(binary,args,{windowsHide:true,shell:false}); let output=''; child.stdout.on('data',d=>output=(output+d).slice(-100000)); child.stderr.on('data',d=>output=(output+d).slice(-100000)); child.on('error',()=>reject(new Error(`Cannot start ${path.basename(binary)}. Configure its executable path.`))); child.on('close',code=>code===0?resolve(output):reject(new Error(`${path.basename(binary)} failed (${code}). Check media and executable configuration.`))); }); }
async function merge(clips,folder,settings) {
  const normalized=[];
  for(let i=0;i<clips.length;i++) {
    await run(settings.ffprobe,['-v','error','-show_entries','stream=codec_type','-of','json',clips[i]]);
    const target=path.join(folder,`normalized-${i}.mp4`);
    await run(settings.ffmpeg,['-y','-i',clips[i],'-an','-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1','-r','24','-c:v','libx264','-pix_fmt','yuv420p',target]); normalized.push(target);
  }
  const list=path.join(folder,'concat.txt');
  await fs.writeFile(list,normalized.map(p=>`file '${p.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`).join('\n'));
  const output=path.join(folder,'final.mp4');
  await run(settings.ffmpeg,['-y','-f','concat','-safe','0','-i',list,'-c','copy',output]); return output;
}
module.exports={Wan,validate,download,merge,run};
