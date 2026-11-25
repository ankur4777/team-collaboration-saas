import type {Message} from './api';

export default function ReplyPreview({message,onCancel}:{message?:Message;onCancel?:()=>void}){
  return <div className="message-reply-preview">
    <div className="message-reply-text">
      <strong>{message&&!message.deleted_at?message.sender.full_name:'Original message'}</strong>
      <span>{!message?'Unavailable or earlier history — load older messages to view.':message.deleted_at?'Message deleted':message.body}</span>
    </div>
    {onCancel&&<button type="button" aria-label="Cancel reply" onClick={onCancel}>×</button>}
  </div>;
}
