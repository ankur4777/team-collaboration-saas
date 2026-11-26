import { useState, type FormEvent } from 'react';
import { api, type Message } from './api';
import ReplyPreview from './ReplyPreview';
import MessageActions from './MessageActions';

interface Props {
  channelId: string;
  message: Message;
  isMine: boolean;
  samePerson: boolean;
  onUpdated: (message: Message) => void;
  replyTarget?: Message;
  onReply?: () => void;
  onForward?: () => void;
  readOnly?:boolean;
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2)
    .map(value => value[0].toUpperCase()).join('') || '?';
}

export default function ChannelMessageItem({channelId,message,isMine,samePerson,onUpdated,replyTarget,onReply,onForward,readOnly=false}:Props) {
  const [editing,setEditing] = useState(false);
  const [draft,setDraft] = useState(message.body);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');

  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!draft.trim() || draft.trim().length>4000 || busy)return;
    setBusy(true);setError('');
    try {
      const changed=await api.editChannelMessage(channelId,message.id,draft.trim());
      onUpdated(changed);
      setEditing(false);
    }catch(err){setError(err instanceof Error?err.message:'Could not edit message');}
    finally{setBusy(false);}
  }

  async function pin(){
    if(busy||message.deleted_at)return;
    setBusy(true);setError('');
    try{onUpdated(await api.pinChannelMessage(channelId,message.id,!message.pinned_at));}
    catch(e){setError(e instanceof Error?e.message:'Could not change pin');}
    finally{setBusy(false);}
  }

  async function remove() {
    if(busy || !window.confirm('Delete this message?'))return;
    setBusy(true);setError('');
    try {
      await api.deleteChannelMessage(channelId,message.id);
      setEditing(false);
      onUpdated({...message,body:'',pinned_at:null,deleted_at:new Date().toISOString()});
    }catch(err){setError(err instanceof Error?err.message:'Could not delete message');}
    finally{setBusy(false);}
  }

  return <div className={`message ${samePerson?'consecutive':''}`}>
    {!samePerson?<div className="msg-avatar">{initials(message.sender.full_name)}</div>:<div className="msg-avatar-placeholder"/>}
    <div className="msg-content">
      <div className="msg-meta">{!samePerson&&<strong>{message.sender.full_name}</strong>}<span>{new Date(message.created_at).toLocaleString([], {hour:'2-digit',minute:'2-digit'})}</span>
        {!message.deleted_at&&!editing&&<MessageActions busy={busy} pinned={Boolean(message.pinned_at)}
        onReply={!readOnly?onReply:undefined} onForward={onForward}
        onPin={!readOnly?()=>void pin():undefined}
        onEdit={!readOnly&&isMine?()=>{setDraft(message.body);setError('');setEditing(true);}:undefined}
        onDelete={!readOnly&&isMine?()=>void remove():undefined}/>}
      </div>
      {!message.deleted_at&&message.pinned_at&&<div className="forwarded-label">Pinned</div>}
      {!message.deleted_at&&message.is_forwarded&&<div className="forwarded-label">Forwarded</div>}
      {!message.deleted_at&&message.reply_to_id&&<ReplyPreview message={replyTarget}/>}
      {editing && !message.deleted_at && !readOnly
        ? <form className="channel-message-edit" onSubmit={event=>void save(event)}>
          <textarea aria-label="Edit channel message" maxLength={4000} rows={2} value={draft} onChange={event=>setDraft(event.target.value)} disabled={busy}/>
          <div><button type="button" disabled={busy} onClick={()=>{setEditing(false);setError('');}}>Cancel</button>
            <button type="submit" disabled={busy||!draft.trim()}>Save</button></div>
        </form>
        : <div className={`msg-body ${message.deleted_at?'deleted':''}`}>
          {message.deleted_at?'Message deleted':message.body}
          {!message.deleted_at&&message.edited_at&&<small className="channel-edited-note"> (edited)</small>}
        </div>}
      {error&&<div role="alert" className="channel-message-error">{error}</div>}
    </div>
  </div>;
}
