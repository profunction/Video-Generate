const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('studio',{
 settings:()=>ipcRenderer.invoke('settings:get'),saveSettings:value=>ipcRenderer.invoke('settings:save',value),
 list:()=>ipcRenderer.invoke('projects:list'),create:value=>ipcRenderer.invoke('project:create',value),
 run:id=>ipcRenderer.invoke('project:run',id),open:id=>ipcRenderer.invoke('project:open',id),
 onProgress:callback=>ipcRenderer.on('progress',(_,message)=>callback(message))
});
