import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Ellipsis,Reply,Forward,Pin,PinOff,Pencil,Trash2} from 'lucide-react';

interface Props {
  busy?:boolean;
  pinned?:boolean;
  onReply?:()=>void;
  onForward?:()=>void;
  onPin?:()=>void;
  onEdit?:()=>void;
  onDelete?:()=>void;
}
export default function MessageActions({busy=false,pinned=false,onReply,onForward,onPin,onEdit,onDelete}:Props){
  const [position,setPosition]=useState<{top:number;left:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const open=position!==null;
  const actions=[
    {label:'Reply',icon:Reply,run:onReply},
    {label:'Forward',icon:Forward,run:onForward},
    {label:pinned?'Unpin':'Pin',icon:pinned?PinOff:Pin,run:onPin},
    {label:'Edit',icon:Pencil,run:onEdit},
    {label:'Delete',icon:Trash2,run:onDelete},
  ].filter(action=>action.run);
  function close(restore=false){
    setPosition(null);
    if(restore)trigger.current?.focus();
  }
  useEffect(()=>{
    if(!open)return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    function outside(event:PointerEvent){
      const target=event.target as Node;
      if(!panel.current?.contains(target)&&!trigger.current?.contains(target))setPosition(null);
    }
    function keyboard(event:KeyboardEvent){
      if(event.key==='Escape'){event.preventDefault();setPosition(null);trigger.current?.focus();}
    }
    function scroll(event:Event){if(event.target instanceof Node&&panel.current?.contains(event.target))return;setPosition(null);}
    const resize=()=>setPosition(null);
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',keyboard);
    window.addEventListener('scroll',scroll,true);
    window.addEventListener('resize',resize);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',resize);};
  },[open]);
  if(!actions.length)return null;
  function toggle(){
    if(open){close();return;}
    const rect=trigger.current?.getBoundingClientRect();
    if(!rect)return;
    const height=actions.length*34+12;
    const top=rect.bottom+height+8<=window.innerHeight?rect.bottom+4:Math.max(8,rect.top-height-4);
    setPosition({top,left:Math.max(8,Math.min(rect.right-156,window.innerWidth-164))});
  }
  return <div className="message-action-anchor">
    <button ref={trigger} type="button" className="message-action-trigger" title="Message options" aria-label="Message options" aria-expanded={open} disabled={busy} onClick={toggle}><Ellipsis size={18}/></button>
    {position&&createPortal(<div className="message-action-popover" ref={panel} role="group" aria-label="Message actions" style={position}>
      {actions.map(action=><button key={action.label} type="button" disabled={busy} className={action.label==='Delete'?'danger':''} onClick={()=>{close(true);action.run?.();}}><action.icon size={15}/>{action.label}</button>)}
    </div>,document.body)}
  </div>;
}
