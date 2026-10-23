const {app,BrowserWindow,ipcMain,dialog,safeStorage,shell}=require('electron');
const fs=require('node:fs/promises'); const path=require('node:path'); const crypto=require('node:crypto');
const {Wan,validate,download,merge}=require('./engine');
let win,busy=false; const defaults={region:'china',model:'wan2.2-i2v-flash',pricePerSecond:0,budget:10,ffmpeg:'ffmpeg',ffprobe:'ffprobe'};
const root=()=>app.getPath('userData');
async function read(file,fallback) { try {return JSON.parse(await fs.readFile(file,'utf8'));} catch(e){if(e.code==='ENOENT')return fallback;throw e;} }
async function save(file,value) {await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2)); await fs.rename(file+'.tmp',file);}
async function settings(){return {...defaults,...await read(path.join(root(),'settings.json'),{})};}
const emit=(message)=>win?.webContents.send('progress',message);
function projectPath(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid project');return path.join(root(),'projects',id,'project.json');}
app.whenReady().then(()=>{
 win=new BrowserWindow({width:1180,height:850,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.loadFile(path.join(__dirname,'index.html')); win.webContents.setWindowOpenHandler(()=>({action:'deny'})); win.webContents.on('will-navigate',e=>e.preventDefault());
 ipcMain.handle('settings:get',async()=>({...await settings(),hasKey:await fs.access(path.join(root(),'key.bin')).then(()=>true,()=>false)}));
 ipcMain.handle('settings:save',async(_,value)=>{
  if(busy)throw Error('Wait until generation finishes');
  const config={};for(const k of Object.keys(defaults))config[k]=value[k]??defaults[k];
  if(value.key){if(!safeStorage.isEncryptionAvailable() || (process.platform==='linux' && safeStorage.getSelectedStorageBackend()==='basic_text'))throw Error('Secure credential storage unavailable'); await fs.writeFile(path.join(root(),'key.bin'),safeStorage.encryptString(value.key),{mode:0o600});}
  await save(path.join(root(),'settings.json'),config);return true;
 });
 ipcMain.handle('projects:list',async()=>{const dir=path.join(root(),'projects');await fs.mkdir(dir,{recursive:true});const names=await fs.readdir(dir);const projects=[];for(const id of names){projects.push(await read(projectPath(id),null));}return projects.filter(Boolean);});
 ipcMain.handle('project:create',async(_,input)=>{if(busy)throw Error('Generation is running');const p={id:crypto.randomUUID(),name:String(input.name||'Untitled').slice(0,100),scenes:input.scenes.map(s=>({prompt:s.prompt,image:s.image})),reserved:0,createdAt:new Date().toISOString()};if(!p.scenes.length || p.scenes.length>50)throw Error('Provide 1–50 scenes');await save(projectPath(p.id),p);return p;});
 ipcMain.handle('project:open',async(_,id)=>{await shell.openPath(path.dirname(projectPath(id)));});
 ipcMain.handle('project:run',async(_,id)=>{
  if(busy)throw Error('Another project is running');busy=true;
  try {
   const file=projectPath(id),p=await read(file,null);if(!p)throw Error('Project not found');const cfg=await settings();const estimate=validate(p,cfg);
   const key=safeStorage.decryptString(await fs.readFile(path.join(root(),'key.bin')));
   const count=p.scenes.filter(s=>!s.taskId&&!s.clip).length;
   if(count){const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Approve paid generation'],defaultId:0,cancelId:0,message:`Submit ${count} paid Wan jobs?`,detail:`Estimated additional cost: ${estimate.toFixed(2)}. Project reserved: ${Number(p.reserved).toFixed(2)}. Budget: ${cfg.budget}. All amounts use the currency of your entered unit price. Estimates are not billing guarantees. Verify current provider pricing.`});if(result.response!==1)return {canceled:true};}
   const wan=new Wan(cfg,key),folder=path.dirname(file);
   for(let i=0;i<p.scenes.length;i++){
    const s=p.scenes[i];if(s.clip){await fs.access(path.join(folder,s.clip));continue;}
    if(s.uncertain)throw Error(`Scene ${i+1} has an uncertain submission. Check Alibaba console before creating a replacement project.`);
    if(!s.taskId){s.uncertain=true;p.reserved+=5*Number(cfg.pricePerSecond);await save(file,p);emit(`Submitting scene ${i+1}…`);s.taskId=await wan.submit(s);s.region=cfg.region;s.model=cfg.model;s.uncertain=false;await save(file,p);}
    if(s.region!==cfg.region)throw Error('Switch settings back to the region used for this task');
    const url=await wan.poll(s.taskId,status=>emit(`Scene ${i+1}/${p.scenes.length}: ${status}`));
    emit(`Downloading scene ${i+1}…`);s.clip=`clip-${i+1}.mp4`;try{await download(url,path.join(folder,s.clip));}catch(e){delete s.clip;throw e;}await save(file,p);
   }
   emit('Merging clips with FFmpeg…');p.output=await merge(p.scenes.map(s=>path.join(folder,s.clip)),folder,cfg);await save(file,p);emit('Finished: '+p.output);return p;
  } finally {busy=false;}
 });
});
app.on('before-quit',e=>{if(busy){e.preventDefault();emit('A job is active. Keep this window open until it finishes or reports an error.');}});
app.on('window-all-closed',()=>{if(!busy)app.quit();});
