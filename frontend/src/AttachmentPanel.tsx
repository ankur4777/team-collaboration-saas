import { useEffect, useRef, useState } from 'react';
import { api, type PrivateAttachment } from './api';

type Kind = 'chat'|'channel';
interface Props { kind:Kind; parentId:string; readOnly?:boolean }

const FILE_LIMIT = 5 * 1024 * 1024;
function displaySize(bytes:number){
  return bytes < 1024*1024 ? `${Math.ceil(bytes/1024)} KB` : `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

export default function AttachmentPanel({kind,parentId,readOnly=false}:Props) {
  const [files,setFiles] = useState<PrivateAttachment[]>([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [opened,setOpened] = useState(false);
  const inputRef=useRef<HTMLInputElement>(null);

  useEffect(()=>{
    let current=true;
    setFiles([]);setError('');setOpened(false);
    async function refresh(){
      try {
        const next = kind==='chat' ? await api.chatAttachments(parentId) : await api.channelAttachments(parentId);
        if(current)setFiles(next);
      }catch(e){if(current)setError(e instanceof Error?e.message:'Could not load files');}
    }
    void refresh();
    const interval=window.setInterval(()=>void refresh(),20000);
    return()=>{current=false;window.clearInterval(interval);};
  },[kind,parentId]);

  async function upload(file:File|undefined) {
    if(!file||readOnly)return;
    if(file.size===0||file.size>FILE_LIMIT){setError('Select a nonempty file up to 5 MB');return;}
    setError('');setBusy(true);
    try {
      const row=kind==='chat' ? await api.uploadChatAttachment(parentId,file) : await api.uploadChannelAttachment(parentId,file);
      setFiles(current=>[row,...current.filter(item=>item.id!==row.id)]);
      setOpened(true);
    }catch(e){setError(e instanceof Error?e.message:'Could not upload file');}
    finally{setBusy(false);if(inputRef.current)inputRef.current.value='';}
  }
  async function download(row:PrivateAttachment) {
    setError('');
    try {await api.downloadPrivateAttachment(row);}
    catch(e){setError(e instanceof Error?e.message:'Could not download file');}
  }

  return <section className="workspace-attachments" aria-label="Shared attachments">
    <div className="attachment-top">
      <button type="button" className="attachment-toggle" aria-expanded={opened} onClick={()=>setOpened(current=>!current)}>
        Shared files ({files.length}) {opened?'▴':'▾'}
      </button>
      {!readOnly&&<label className={`attachment-upload ${busy?'busy':''}`}>
        {busy?'Uploading...':'Attach file'}
        <input ref={inputRef} aria-label="Attach a file" type="file" disabled={busy}
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt" onChange={event=>void upload(event.target.files?.[0])}/>
      </label>}
    </div>
    {error&&<div className="attachment-error" role="alert">{error}</div>}
    {opened&&<div className="attachment-list">
      {files.length===0&&<span>No files shared in this conversation yet.</span>}
      {files.map(row=><button type="button" key={row.id} className="attachment-file" onClick={()=>void download(row)}
        title={`Download ${row.name}`}>
        <span className="attachment-file-name">{row.name}</span>
        <small>{displaySize(row.size)} · {row.uploaded_by.full_name}</small>
      </button>)}
    </div>}
  </section>;
}
