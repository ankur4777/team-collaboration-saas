import {useEffect,useId,useRef,useState} from 'react';
import {Building2,Check,ChevronDown} from 'lucide-react';
import type {Org} from './api';

interface Props {organizations:Org[];activeId:string|null;disabled?:boolean;onSelect:(id:string)=>void}
function initials(name:string){return name.trim().split(/\s+/).filter(Boolean).slice(0,2).map(word=>word[0].toUpperCase()).join('')||'TW';}
function roleLabel(role:Org['role']){return role==='admin'?'Admin':'Member';}

export default function WorkspacePicker({organizations,activeId,disabled=false,onSelect}:Props){
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const listId=useId();
  const active=organizations.find(org=>org.id===activeId);
  useEffect(()=>{
    if(!open)return;
    function outside(event:PointerEvent){if(!root.current?.contains(event.target as Node))setOpen(false);}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  useEffect(()=>{setOpen(false);},[activeId]);
  return <div className="workspace-picker" ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}>
    <button ref={trigger} type="button" className="org-picker workspace-picker-trigger" aria-label="Switch organization" aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={()=>setOpen(value=>!value)}>
      <span className="org-icon">{active?initials(active.name):<Building2 size={18}/>}</span>
      <span className="org-label"><strong>{active?.name||'Choose workspace'}</strong><small>{active?roleLabel(active.role):'No organization'}</small></span>
      <ChevronDown size={16} className={open?'workspace-chevron expanded':'workspace-chevron'}/>
    </button>
    {open&&<div id={listId} className="workspace-picker-list" role="group" aria-label="Your workspaces">
      <div className="workspace-picker-caption">Your workspaces <span>{organizations.length}</span></div>
      {organizations.length===0&&<p className="workspace-picker-empty">No workspaces available.</p>}
      {organizations.map(org=><button type="button" key={org.id} className={'workspace-picker-option'+(org.id===activeId?' selected':'')} disabled={disabled} aria-pressed={org.id===activeId} onClick={()=>{setOpen(false);trigger.current?.focus();if(org.id!==activeId)onSelect(org.id);}}>
        <span className="workspace-option-avatar">{initials(org.name)}</span>
        <span className="workspace-option-label"><strong>{org.name}</strong><small>{roleLabel(org.role)}</small></span>
        {org.id===activeId&&<Check size={16} className="workspace-option-check"/>}
      </button>)}
    </div>}
  </div>;
}
