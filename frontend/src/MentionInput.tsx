import {useLayoutEffect,useRef,useState,type KeyboardEvent,type RefObject} from 'react';
import type { Person } from './api';

interface Props {
  value:string;
  onChange:(value:string)=>void;
  people:Person[];
  placeholder:string;
  ariaLabel:string;
  onBlur?:()=>void;
  disabled?:boolean;
  multiline?:boolean;
  textareaRef?:RefObject<HTMLTextAreaElement|null>;
  onEnterSend?:()=>void;
}

export default function MentionInput({value,onChange,people,placeholder,ariaLabel,onBlur,disabled,multiline=false,textareaRef,onEnterSend}:Props) {
  const ownRef=useRef<HTMLTextAreaElement>(null),textRef=textareaRef||ownRef;
  useLayoutEffect(()=>{if(!multiline||!textRef.current)return;const element=textRef.current;element.style.height='auto';element.style.height=Math.min(Math.max(element.scrollHeight,40),130)+'px';},[value,multiline,textRef]);
  const [choice,setChoice]=useState(0);
  const [dismissed,setDismissed]=useState<string|null>(null);
  // A mention can contain spaces, so match the text after the last @.
  const match=/(?:^|\s)@([^@\n]{0,50})$/.exec(value);
  const query=match?.[1].trimStart().toLocaleLowerCase()||'';
  const uniqueNames=new Map<string,number>();
  for(const user of people) {
    const key=user.full_name.trim().toLocaleLowerCase();
    uniqueNames.set(key,(uniqueNames.get(key)||0)+1);
  }
  const suggestions=(match && dismissed!==value ? people.filter(user=>{
    const name=user.full_name.trim();
    return name.length>0 && uniqueNames.get(name.toLocaleLowerCase())===1
      && name.toLocaleLowerCase().startsWith(query);
  }).slice(0,6) : []);
  const index=Math.min(choice,Math.max(suggestions.length-1,0));

  function select(user:Person) {
    const at=value.lastIndexOf('@');
    if(at<0)return;
    const next=value.slice(0,at)+'@'+user.full_name.trim()+' ';
    if(next.length>4000)return;
    onChange(next);
    setChoice(0);
    setDismissed(next);
  }
  function onKeyDown(event:KeyboardEvent<HTMLInputElement|HTMLTextAreaElement>) {
    if(event.nativeEvent.isComposing)return;
    if(!suggestions.length){if(multiline&&onEnterSend&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();onEnterSend();}return;}
    if(event.key==='ArrowDown') {
      event.preventDefault();setChoice(current=>(current+1)%suggestions.length);
    } else if(event.key==='ArrowUp') {
      event.preventDefault();setChoice(current=>(current+suggestions.length-1)%suggestions.length);
    } else if(event.key==='Enter') {
      event.preventDefault();select(suggestions[index]);
    } else if(event.key==='Escape') {
      event.preventDefault();setDismissed(value);
    }
  }

  return <div className="mention-input">
    {multiline?<textarea ref={textRef} rows={1} aria-label={ariaLabel} value={value} maxLength={4000} autoComplete="off" placeholder={placeholder} disabled={disabled} onChange={event=>{setDismissed(null);setChoice(0);onChange(event.target.value);}} onBlur={onBlur} onKeyDown={onKeyDown}/>:<input aria-label={ariaLabel} value={value} maxLength={4000}
      autoComplete="off" placeholder={placeholder} disabled={disabled}
      onChange={event=>{setDismissed(null);setChoice(0);onChange(event.target.value);}}
      onBlur={onBlur} onKeyDown={onKeyDown}/>}
    {suggestions.length>0&&<div className="mention-options" role="listbox" aria-label="Mention a teammate">
      {suggestions.map((user,i)=><button type="button" key={user.id}
        className={i===index?'selected':''} role="option" aria-selected={i===index}
        onMouseDown={event=>event.preventDefault()} onClick={()=>select(user)}>
        <strong>{user.full_name}</strong><small>{user.email}</small>
      </button>)}
    </div>}
  </div>;
}

