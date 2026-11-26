import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,type LucideIcon} from 'lucide-react';

export interface PickerOption<T extends string>{value:T;label:string;icon:LucideIcon}
interface Props<T extends string>{label:string;value:T;options:PickerOption<T>[];onChange:(value:T)=>void;disabled?:boolean;fullWidth?:boolean}
export default function ThemedPicker<T extends string>({label,value,options,onChange,disabled=false,fullWidth=false}:Props<T>){
  const [position,setPosition]=useState<{top:number;left:number;width:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const open=position!==null;
  const selected=options.find(option=>option.value===value);
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
    const height=options.length*38+12;
    setPosition({width,left:Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),top:rect.bottom+height+8<=window.innerHeight?rect.bottom+4:Math.max(8,rect.top-height-4)});
  }
  return <><button type="button" ref={trigger} className={'role-picker-trigger'+(fullWidth?' full-width':'')} disabled={disabled} aria-label={label+': '+(selected?.label||'Choose')} aria-expanded={open} onClick={toggle}>
    {selected&&<selected.icon size={14}/>}<span>{selected?.label||'Choose'}</span><ChevronDown size={14} className={open?'role-chevron expanded':'role-chevron'}/>
  </button>{position&&createPortal(<div className="role-picker-popover" role="group" aria-label={label+' options'} ref={panel} style={position}>
    {options.map(option=><button key={option.value} type="button" aria-pressed={option.value===value} className={option.value===value?'selected':''} onClick={()=>{close(true);if(option.value!==value)onChange(option.value);}}>
      <option.icon size={15}/><span>{option.label}</span>{option.value===value&&<Check size={14} className="role-picker-check"/>}
    </button>)}
  </div>,document.body)}</>;
}
