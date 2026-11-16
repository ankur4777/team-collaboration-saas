import { useEffect, useState } from 'react';
import { api, type ChatMessage, type ReactionSummary } from './api';

const EMOJIS = ['👍', '❤️', '😂', '🎉', '👀'];

interface Props {
  chatId: string;
  message: ChatMessage;
  currentUserId: string;
  onUpdated: (updated:ChatMessage)=>void;
}

export default function ChatReactionBar({chatId,message,currentUserId,onUpdated}:Props) {
  const [reactions,setReactions] = useState<ReactionSummary[]>(message.reactions || []);
  const [working,setWorking] = useState<string|null>(null);
  const [error,setError] = useState('');

  useEffect(()=>{setReactions(message.reactions || []);},[message.reactions]);
  if(message.deleted_at)return null;

  async function toggle(emoji:string) {
    if(working)return;
    setWorking(emoji);
    setError('');
    try {
      const updated = await api.toggleChatReaction(chatId,message.id,emoji);
      setReactions(updated.reactions || []);
      onUpdated(updated);
    }catch(err) {
      setError(err instanceof Error?err.message:'Could not update reaction');
    }finally{
      setWorking(null);
    }
  }

  return <div className="chat-reaction-bar" aria-label="Message reactions">
    {EMOJIS.map(emoji=>{
      const summary=reactions.find(item=>item.emoji===emoji);
      const mine=summary?.user_ids.includes(currentUserId)||false;
      return <button key={emoji} type="button"
        className={`chat-reaction-button ${mine?'mine':''}`}
        title={`${mine?'Remove':'Add'} ${emoji} reaction`}
        aria-label={`${mine?'Remove':'Add'} ${emoji} reaction${summary?', '+summary.count+' total':''}`}
        aria-pressed={mine}
        disabled={!!working}
        onClick={()=>void toggle(emoji)}>
        <span>{emoji}</span>{summary&&<small>{summary.count}</small>}
      </button>;
    })}
    {error&&<small role="alert" className="chat-reaction-error">{error}</small>}
  </div>;
}
