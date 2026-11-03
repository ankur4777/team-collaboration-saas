import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, MessageCircle, X } from 'lucide-react';
import { api, type ChatThread } from './api';

interface Props {
  workspaceId: string|null;
  userId: string;
  onOpenChat: (chatId:string)=>void;
  refreshVersion?: number;
}

function chatTitle(thread:ChatThread,userId:string) {
  if (thread.kind === 'group') return thread.title;
  return thread.participants.find(p=>p.user.id!==userId)?.user.full_name || 'Direct chat';
}

export default function ChatNotificationBell({workspaceId,userId,onOpenChat,refreshVersion=0}:Props) {
  const [threads,setThreads] = useState<ChatThread[]>([]);
  const [open,setOpen] = useState(false);
  const [error,setError] = useState('');
  const latestId = useRef(workspaceId);
  latestId.current = workspaceId;

  const refresh = useCallback(async()=>{
    if(!workspaceId) {setThreads([]);return;}
    try {
      const rows = await api.chats();
      if(latestId.current !== workspaceId) return;
      setThreads(rows);
      setError('');
    } catch(e) {
      if(latestId.current === workspaceId) setError(e instanceof Error ? e.message : 'Cannot load chat notifications');
    }
  },[workspaceId]);

  useEffect(()=>{
    setThreads([]);
    setOpen(false);
    void refresh();
    const interval = window.setInterval(()=>{void refresh();},20000);
    const onFocus = ()=>{void refresh();};
    window.addEventListener('focus',onFocus);
    return ()=>{window.clearInterval(interval);window.removeEventListener('focus',onFocus);};
  },[refresh]);

  useEffect(()=>{if(refreshVersion>0)void refresh();},[refreshVersion,refresh]);

  const unread = threads.filter(t=>t.unread_count>0);
  const unreadCount = unread.reduce((sum,t)=>sum+t.unread_count,0);
  return <div className="notification-bell">
    <button type="button" className="icon-button bell-trigger" title="Unread chat notifications" aria-label={`Notifications, ${unreadCount} unread chat messages`} aria-expanded={open} onClick={()=>{setOpen(value=>!value);void refresh();}}>
      <Bell size={19}/>{unreadCount>0&&<span className="bell-badge">{unreadCount>99?'99+':unreadCount}</span>}
    </button>
    {open&&<div className="notification-popover" role="dialog" aria-label="Chat notifications">
      <div className="notification-head"><div><strong>Notifications</strong><small>Unread chat messages</small></div><button className="icon-button" type="button" aria-label="Close notifications" onClick={()=>setOpen(false)}><X size={17}/></button></div>
      {error&&<div className="notification-error">{error}</div>}
      {unread.length ? <div className="notification-items">{unread.map(t=><button key={t.id} type="button" className="notification-item" onClick={()=>{onOpenChat(t.id);setOpen(false);}}>
        <MessageCircle size={18}/><span><strong>{chatTitle(t,userId)}</strong><small>{t.kind==='group'?'Group chat':'Direct message'}</small></span><b>{t.unread_count}</b>
      </button>)}</div> : <div className="notification-empty">No unread chats in this workspace.</div>}
      <div className="notification-foot">Chat alerts refresh about every 20 seconds.</div>
    </div>}
  </div>;
}
