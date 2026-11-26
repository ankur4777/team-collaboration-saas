import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,ShieldCheck,UserRound} from 'lucide-react';

type Role='member'|'admin';
interface Props {label:string;value:Role;onChange:(role:Role)=>void;disabled?:boolean;allowAdmin?:boolean;fullWidth?:boolean}
const options:Role[]=['member','admin'];
export default function RolePicker({label,value,onChange,disabled=false,allowAdmin=true,fullWidth=false}:Props){
  const [position,setPosition]=useState<{top:number;left:number;width:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const open=position!==null;
  const roles=allowAdmin?options:options.slice(0,1);
  function close(focus=false){setPosition(null);if(focus)trigger.current?.focus();}
  useEffect(()=>{
    if(!open)return;
    panel.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus();
    function outside(e:PointerEvent){const target=e.target as Node;if(!trigger.current?.contains(target)&&!panel.current?.contains(target))setPosition(null);}
    function keyboard(e:KeyboardEvent){
      if(e.key==='Escape'){e.preventDefault();setPosition(null);trigger.current?.focus();}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){const buttons=Array.from(panel.current?.querySelectorAll('button')||[]);if(!buttons.length)return;e.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
      if(e.key==='Tab'){setPosition(null);trigger.current?.focus();}
    }
    function scroll(e:Event){if(e.target instanceof Node&&panel.current?.contains(e.target))return;setPosition(null);}
    const resize=()=>setPosition(null);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);
    window.addEventListener('scroll',scroll,true);window.addEventListener('resize',resize);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',resize);};
  },[open]);
  useEffect(()=>{if(disabled)setPosition(null);},[disabled]);
  function toggle(){
    if(open){close();return;}
    const rect=trigger.current?.getBoundingClientRect();if(!rect)return;
    const width=Math.min(Math.max(rect.width,142),window.innerWidth-16);
    const height=roles.length*38+12;
    setPosition({width,left:Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),top:rect.bottom+height+8<=window.innerHeight?rect.bottom+4:Math.max(8,rect.top-height-4)});
  }
  return <><button type="button" ref={trigger} className={'role-picker-trigger'+(fullWidth?' full-width':'')} disabled={disabled} aria-label={label+': '+(value==='admin'?'Admin':'Member')} aria-expanded={open} onClick={toggle}>
    {value==='admin'?<ShieldCheck size={14}/>:<UserRound size={14}/>}<span>{value==='admin'?'Admin':'Member'}</span><ChevronDown size={14} className={open?'role-chevron expanded':'role-chevron'}/>
  </button>{position&&createPortal(<div className="role-picker-popover" role="group" aria-label={label+' options'} ref={panel} style={position}>
    {roles.map(role=><button key={role} type="button" aria-pressed={role===value} className={role===value?'selected':''} onClick={()=>{close(true);if(role!==value)onChange(role);}}>
      {role==='admin'?<ShieldCheck size={15}/>:<UserRound size={15}/>}<span>{role==='admin'?'Admin':'Member'}</span>{role===value&&<Check size={14} className="role-picker-check"/>}
    </button>)}
  </div>,document.body)}</>;
}
