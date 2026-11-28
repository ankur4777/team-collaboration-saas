import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Ellipsis,type LucideIcon} from 'lucide-react';

export interface ChatOption {label:string;icon:LucideIcon;onSelect:()=>void;danger?:boolean}

export default function ChatOptionsMenu({items,busy=false}:{items:ChatOption[];busy?:boolean}){
  const [position,setPosition]=useState<{top:number;left:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!position)return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(event:PointerEvent){const target=event.target as Node;if(!panel.current?.contains(target)&&!trigger.current?.contains(target))setPosition(null);}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();setPosition(null);trigger.current?.focus();}}
    function scroll(event:Event){if(event.target instanceof Node&&panel.current?.contains(event.target))return;setPosition(null);}
    const resize=()=>setPosition(null);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    window.addEventListener('resize',resize);window.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',resize);window.removeEventListener('scroll',scroll,true);};
  },[position]);
  return <>
    <button ref={trigger} type="button" className="conversation-icon-button" aria-label="Conversation options" title="Conversation options" aria-expanded={Boolean(position)} disabled={busy} onClick={()=>{
      if(position){setPosition(null);return;}
      const rect=trigger.current!.getBoundingClientRect(),height=items.length*40+16;
      setPosition({left:Math.max(8,Math.min(rect.right-218,window.innerWidth-226)),top:rect.bottom+height+8<window.innerHeight?rect.bottom+6:Math.max(8,rect.top-height-6)});
    }}><Ellipsis size={20}/></button>
    {position&&createPortal(<div ref={panel} className="chat-options-popover" role="group" aria-label="Conversation actions" style={position} onKeyDown={event=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();const buttons=Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
    }}>{items.map(item=><button key={item.label} type="button" className={item.danger?'danger':''} disabled={busy} onClick={()=>{setPosition(null);trigger.current?.focus();item.onSelect();}}><item.icon size={16}/>{item.label}</button>)}</div>,document.body)}
  </>;
}
