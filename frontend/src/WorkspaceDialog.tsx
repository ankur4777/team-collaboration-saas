import {useEffect,useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
export default function WorkspaceDialog({title,onClose,busy=false,children}:{title:string;onClose:()=>void;busy?:boolean;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null),previous=useRef(document.activeElement),id=useId();
  useEffect(()=>{const dialog=ref.current!,overflow=document.body.style.overflow;dialog.showModal();document.body.style.overflow='hidden';
    return()=>{dialog.close();document.body.style.overflow=overflow;if(previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus();};},[]);
  return <dialog className="org-work-dialog" ref={ref} aria-labelledby={id} aria-busy={busy} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header><h2 id={id}>{title}</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>
    <div className="org-work-dialog-body">{children}</div>
  </dialog>;
}
