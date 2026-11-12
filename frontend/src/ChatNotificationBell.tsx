import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Hash, MessageCircle, X } from 'lucide-react';
import { api, type ChannelNotice, type ChatThread, type NotificationPreferences } from './api';

interface Props {
  workspaceId: string|null;
  userId: string;
  onOpenChat: (chatId:string)=>void;
  onOpenChannel: (teamId:string, channelId:string)=>void;
  refreshVersion?: number;
  onRealtimeNotification?: ()=>void;
}

function chatTitle(thread:ChatThread,userId:string) {
  if (thread.kind === 'group') return thread.title;
  return thread.participants.find(p=>p.user.id!==userId)?.user.full_name || 'Direct chat';
}

export default function ChatNotificationBell({workspaceId,userId,onOpenChat,onOpenChannel,onRealtimeNotification,refreshVersion=0}:Props) {
  const [threads,setThreads] = useState<ChatThread[]>([]);
  const [channels,setChannels] = useState<ChannelNotice[]>([]);
  const [preferences,setPreferences] = useState<NotificationPreferences>({direct_chats:true,group_chats:true,team_channels:true});
  const [open,setOpen] = useState(false);
  const [live,setLive] = useState(false);
  const onRealtimeRef = useRef(onRealtimeNotification);
  onRealtimeRef.current=onRealtimeNotification;
  const [error,setError] = useState('');
  const latestId = useRef(workspaceId);
  latestId.current = workspaceId;

  const refresh = useCallback(async()=>{
    if(!workspaceId){setThreads([]);setChannels([]);return;}
    try{
      const [chatRows,channelRows,settings] = await Promise.all([api.chats(),api.channelNotifications(),api.notificationPreferences()]);
      if(latestId.current!==workspaceId)return;
      setThreads(chatRows);
      setChannels(channelRows);
      setPreferences(settings);
      setError('');
    }catch(e){
      if(latestId.current===workspaceId)setError(e instanceof Error?e.message:'Could not load notifications');
    }
  },[workspaceId]);

  useEffect(()=>{
    setThreads([]);
    setChannels([]);
    setPreferences({direct_chats:true,group_chats:true,team_channels:true});
    setOpen(false);
    void refresh();
    const interval = window.setInterval(()=>{void refresh();},20000);
    const onFocus=()=>{void refresh();};
    window.addEventListener('focus',onFocus);
    return ()=>{window.clearInterval(interval);window.removeEventListener('focus',onFocus);};
  },[refresh]);

  useEffect(()=>{if(refreshVersion>0)void refresh();},[refreshVersion,refresh]);

  useEffect(()=>{
    if(!workspaceId){setLive(false);return;}
    let active=true;
    let socket:WebSocket|null=null;
    let reconnect:ReturnType<typeof setTimeout>|undefined;
    let debounce:ReturnType<typeof setTimeout>|undefined;
    let failures=0;
    function connect(){
      if(!active)return;
      const protocol=location.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(`${protocol}//${location.host}/ws/notifications/`);
      socket.onopen=()=>{if(active){failures=0;setLive(true);void refresh();}};
      socket.onmessage=event=>{
        try{
          const message=JSON.parse(event.data) as {type:string};
          if(message.type!=='refresh'||!active)return;
          if(debounce)clearTimeout(debounce);
          debounce=setTimeout(()=>{
            if(!active)return;
            void refresh();
            onRealtimeRef.current?.();
          },200);
        }catch{/* Ignore unrecognized socket messages. */}
      };
      socket.onerror=()=>socket?.close();
      socket.onclose=event=>{
        if(!active)return;
        setLive(false);
        if(event.code===4401||event.code===4403)return;
        failures=Math.min(failures+1,5);
        reconnect=setTimeout(connect,Math.min(15000,1000*2**(failures-1)));
      };
    }
    connect();
    return()=>{
      active=false;
      if(reconnect)clearTimeout(reconnect);
      if(debounce)clearTimeout(debounce);
      socket?.close();
    };
  },[workspaceId,refresh]);

  const unreadChats=threads.filter(t=>t.unread_count>0 && (t.kind==='direct'?preferences.direct_chats:preferences.group_chats));
  const unreadChannels=channels.filter(c=>c.unread_count>0&&preferences.team_channels);
  const unreadCount=unreadChats.reduce((sum,t)=>sum+t.unread_count,0)
    +unreadChannels.reduce((sum,c)=>sum+c.unread_count,0);

  return <div className="notification-bell">
    <button type="button" className="icon-button bell-trigger" title="Workspace notifications"
      aria-label={`Notifications, ${unreadCount} unread messages`} aria-expanded={open}
      onClick={()=>{setOpen(value=>!value);void refresh();}}>
      <Bell size={19}/>{unreadCount>0&&<span className="bell-badge">{unreadCount>99?'99+':unreadCount}</span>}
    </button>
    {open&&<div className="notification-popover" role="dialog" aria-label="Workspace notifications">
      <div className="notification-head"><div><strong>Notifications</strong><small>Unread chats and team channels</small></div><button className="icon-button" type="button" aria-label="Close notifications" onClick={()=>setOpen(false)}><X size={17}/></button></div>
      {error&&<div className="notification-error">{error}</div>}
      {(unreadChats.length>0||unreadChannels.length>0) ? <div className="notification-items">
        {unreadChats.map(t=><button key={t.id} type="button" className="notification-item" onClick={()=>{onOpenChat(t.id);setOpen(false);}}>
          <MessageCircle size={18}/><span><strong>{chatTitle(t,userId)}</strong><small>{t.kind==='group'?'Group chat':'Direct message'}</small></span><b>{t.unread_count}</b>
        </button>)}
        {unreadChannels.map(c=><button key={c.channel_id} type="button" className="notification-item" onClick={()=>{onOpenChannel(c.team_id,c.channel_id);setOpen(false);}}>
          <Hash size={18}/><span><strong>#{c.channel_name}</strong><small>{c.team_name} · Team channel</small></span><b>{c.unread_count}</b>
        </button>)}
      </div> : <div className="notification-empty">No unread conversations in this workspace.</div>}
      <div className="notification-foot">{live?'Live notifications connected':'Checking for updates every 20 seconds'} · Manage alerts in Settings.</div>
    </div>}
  </div>;
}
