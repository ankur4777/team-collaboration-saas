import {useEffect,useRef,useState} from 'react';
import {api,type ChatMessage,type Person,type ReactionSummary} from './api';
import {SmilePlus} from 'lucide-react';

const EMOJIS=['👍','✅','👏','🙏','🤝','🎉','💡','👌','💯','❤️','😂','👀'];
const LABELS:Record<string,string>={'👍':'Agree','✅':'Completed','👏':'Well done','🙏':'Thank you','🤝':'Support','🎉':'Celebrate','💡':'Good idea','👌':'Looks good','💯':'Excellent','❤️':'Appreciate','😂':'Laugh','👀':'Seen / reviewing'};
interface Props {
  chatId:string;
  message:ChatMessage;
  currentUserId:string;
  participants:Person[];
  onUpdated:(updated:ChatMessage)=>void;
}
export default function ChatReactionBar({chatId,message,currentUserId,participants,onUpdated}:Props){
  const [reactions,setReactions]=useState<ReactionSummary[]>(message.reactions||[]);
  const [working,setWorking]=useState(false);
  const [error,setError]=useState('');
  const [expanded,setExpanded]=useState(false);
  const [detail,setDetail]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{setReactions(message.reactions||[]);},[message.reactions]);
  useEffect(()=>{
    if(!expanded&&!detail)return;
    function outside(event:PointerEvent){if(!root.current?.contains(event.target as Node)){setExpanded(false);setDetail(null);}}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){setExpanded(false);setDetail(null);trigger.current?.focus();}}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[expanded,detail]);
  const names=new Map(participants.map(person=>[person.id,person.full_name]));
  function name(id:string){return id===currentUserId?'You':names.get(id)||'Former participant';}
  if(message.deleted_at)return null;
  async function toggle(emoji:string){
    if(working)return;
    setWorking(true);setError('');
    try{
      const updated=await api.toggleChatReaction(chatId,message.id,emoji);
      setReactions(updated.reactions||[]);onUpdated(updated);
      setExpanded(false);setDetail(null);trigger.current?.focus();
    }catch(err){setError(err instanceof Error?err.message:'Could not update reaction');}
    finally{setWorking(false);}
  }
  const applied=reactions.filter(row=>row.count>0);
  const selected=applied.find(row=>row.emoji===detail);
  return <div className="chat-reaction-bar compact-reactions" aria-label="Message reactions" ref={root}>
    {applied.map(row=>{
      const mine=row.user_ids.includes(currentUserId);
      const label=LABELS[row.emoji]||'Reaction';
      return <button key={row.emoji} type="button" className={'chat-reaction-button'+(mine?' mine':'')} title={label+': '+row.user_ids.map(name).join(', ')} aria-label={row.emoji+' '+row.count+' reactions: '+row.user_ids.map(name).join(', ')} aria-expanded={detail===row.emoji} onClick={()=>{setExpanded(false);setDetail(value=>value===row.emoji?null:row.emoji);}}>
        <span>{row.emoji}</span><small>{row.count}</small>
      </button>;
    })}
    <button ref={trigger} type="button" className="chat-reaction-button more-reactions" aria-label="Choose reaction" title="Choose or change reaction" aria-expanded={expanded} disabled={working} onClick={()=>{setDetail(null);setExpanded(value=>!value);}}><SmilePlus size={15}/></button>
    {expanded&&<div className="chat-reaction-picker" role="group" aria-label="Choose an emoji">
      {EMOJIS.map(emoji=>{
        const mine=applied.some(row=>row.emoji===emoji&&row.user_ids.includes(currentUserId));
        return <button key={emoji} type="button" className={'chat-reaction-button'+(mine?' mine':'')} title={LABELS[emoji]} aria-label={(mine?'Remove ':'React with ')+LABELS[emoji]} aria-pressed={mine} disabled={working} onClick={()=>void toggle(emoji)}>{emoji}</button>;
      })}
    </div>}
    {selected&&<div className="chat-reaction-detail" role="group" aria-label="People who reacted">
      <strong>{selected.emoji} {LABELS[selected.emoji]||'Reaction'} · {selected.count}</strong>
      {selected.user_ids.map(id=><span key={id}>{name(id)}</span>)}
    </div>}
    {error&&<small role="alert" className="chat-reaction-error">{error}</small>}
  </div>;
}
