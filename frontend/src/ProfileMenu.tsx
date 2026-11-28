import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Camera,Maximize2,Pencil,Settings2,Trash2} from 'lucide-react';
import {api,type Person} from './api';
import WorkspaceDialog from './WorkspaceDialog';
import './OrganizationWork.css';
import './ProfileMenu.css';

function initials(name:string){return name.split(' ').filter(Boolean).slice(0,2).map(part=>part[0].toUpperCase()).join('')||'TW';}

function ProfilePhotoViewer({source,onClose}:{source:string;onClose:()=>void}){
  return <WorkspaceDialog title="Profile photo" onClose={onClose}>
    <div className="profile-photo-viewer"><img src={source} alt="Full size profile photo"/></div>
  </WorkspaceDialog>;
}

function ProfileEditor({user,onSaved,onClose}:{user:Person;onSaved:(person:Person)=>void;onClose:()=>void}){
  const [name,setName]=useState(user.full_name),[photo,setPhoto]=useState<File|null>(null);
  const [remove,setRemove]=useState(false),[preview,setPreview]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [viewingPhoto,setViewingPhoto]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null),fileId=useId();
  useEffect(()=>{
    if(!photo){setPreview('');return;}
    const url=URL.createObjectURL(photo);setPreview(url);
    return()=>URL.revokeObjectURL(url);
  },[photo]);
  const source=photo?preview:remove?'':user.avatar_url;
  async function save(event:FormEvent){
    event.preventDefault();if(busy)return;
    if(!name.trim()){setError('Enter your display name.');return;}
    setBusy(true);setError('');
    try{const person=await api.updateProfile(name.trim(),photo,remove);onSaved(person);onClose();}
    catch(reason){setError(reason instanceof Error?reason.message:'Your profile could not be saved.');setBusy(false);}
  }
  return <><WorkspaceDialog title="Edit profile" onClose={onClose} busy={busy}>
    <form className="profile-editor org-work-form" onSubmit={save}>
      <div className="profile-photo-controls">
        {source?<button type="button" className="profile-photo-preview profile-photo-open" aria-label="View profile photo" title="View profile photo" disabled={busy} onClick={()=>setViewingPhoto(true)}><img src={source} alt="Your profile"/><span><Maximize2 size={20}/></span></button>:<div className="profile-photo-preview" aria-label="Profile photo preview">{initials(name)}</div>}
        <div><input ref={fileInput} id={fileId} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} className="profile-file-input" aria-label="Choose profile photo" onChange={event=>{
          const selected=event.target.files?.[0];event.target.value='';if(!selected)return;
          if(!/\.(png|jpe?g|webp)$/i.test(selected.name)||!['image/png','image/jpeg','image/webp'].includes(selected.type)){setError('Choose a PNG, JPEG, or WebP image.');return;}
          if(!selected.size||selected.size>2*1024*1024){setError('Choose a photo up to 2 MB.');return;}
          setPhoto(selected);setRemove(false);setError('');
        }}/>
          <button type="button" className="outline-button" disabled={busy} onClick={()=>fileInput.current?.click()}><Camera size={16}/>Change photo</button>
          {(photo||(!remove&&user.avatar_url))&&<button type="button" className="profile-remove-photo" disabled={busy} onClick={()=>{setPhoto(null);setRemove(true);setError('');}}><Trash2 size={14}/>Remove photo</button>}
          <p className="profile-photo-help">PNG, JPEG, or WebP · Up to 2 MB</p>
        </div>
      </div>
      <label>Display name<input autoFocus value={name} onChange={event=>setName(event.target.value)} maxLength={150} required disabled={busy} autoComplete="name"/></label>
      <label>Email<input type="email" value={user.email} readOnly/></label>
      {error&&<p className="error-banner" role="alert">{error}</p>}
      <div className="org-work-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy||!name.trim()} type="submit">{busy?'Saving…':'Save changes'}</button></div>
    </form>
  </WorkspaceDialog>{viewingPhoto&&source&&<ProfilePhotoViewer source={source} onClose={()=>setViewingPhoto(false)}/>}</>;
}

export default function ProfileMenu({user,onSaved,onOpenSettings,variant='header'}:{user:Person;onSaved:(person:Person)=>void;onOpenSettings?:()=>void;variant?:'header'|'sidebar'}){
  const [open,setOpen]=useState(false),[editing,setEditing]=useState(false),[failedUrl,setFailedUrl]=useState<string|null>(null);
  const [viewingPhoto,setViewingPhoto]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),editButton=useRef<HTMLButtonElement>(null),menuId=useId();
  useEffect(()=>{
    if(!open)return;
    editButton.current?.focus();
    function outside(event:PointerEvent){if(!root.current?.contains(event.target as Node))setOpen(false);}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  function closeEditor(){setEditing(false);trigger.current?.focus();}
  return <div className={`profile-menu profile-menu-${variant}`} ref={root}>
    <button ref={trigger} type="button" className={`${variant==='header'?'top-avatar':'avatar'} profile-trigger`} aria-label="Open profile menu" aria-expanded={open} aria-controls={open?menuId:undefined} title="Your profile" onClick={()=>setOpen(value=>!value)}>
      {user.avatar_url&&failedUrl!==user.avatar_url?<img src={user.avatar_url} alt="" onError={()=>setFailedUrl(user.avatar_url||null)}/>:initials(user.full_name)}
    </button>
    {open&&<div className="profile-popover" id={menuId} role="group" aria-label="Your profile">
      <div className="profile-popover-identity"><strong>{user.full_name}</strong><small>{user.email}</small></div>
      {user.avatar_url&&failedUrl!==user.avatar_url&&<button type="button" onClick={()=>{trigger.current?.focus();setOpen(false);setViewingPhoto(true);}}><Maximize2 size={16}/>View photo</button>}
      <button ref={editButton} type="button" onClick={()=>{trigger.current?.focus();setOpen(false);setEditing(true);}}><Pencil size={16}/>Edit profile</button>
      {onOpenSettings&&<button type="button" onClick={()=>{setOpen(false);trigger.current?.focus();onOpenSettings();}}><Settings2 size={16}/>Account settings</button>}
    </div>}
    {editing&&<ProfileEditor user={user} onSaved={onSaved} onClose={closeEditor}/>}
    {viewingPhoto&&user.avatar_url&&<ProfilePhotoViewer source={user.avatar_url} onClose={()=>{setViewingPhoto(false);trigger.current?.focus();}}/>}
  </div>;
}
