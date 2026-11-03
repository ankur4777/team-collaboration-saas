import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, MessageCircle, Plus, RefreshCw, Send, Users, X } from 'lucide-react';
import { api, type ChatMessage, type ChatThread, type Member, type Person } from './api';

function titleFor(chat: ChatThread, userId: string) {
  if (chat.kind === 'group') return chat.title;
  return chat.participants.find(p => p.user.id !== userId)?.user.full_name || 'Direct conversation';
}
function timeFor(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('');
}
function messageOrder(a: ChatMessage, b: ChatMessage) {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

interface Props { workspaceId: string|null; currentUser: Person; members: Member[]; requestedChat?: {id:string;nonce:number}|null; onRead?: ()=>void }

export default function ChatPanel({workspaceId, currentUser, members, requestedChat, onRead}: Props) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selected, setSelected] = useState<string|null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'direct'|'group'|null>(null);
  const [directEmail, setDirectEmail] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupEmails, setGroupEmails] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [editingId, setEditingId] = useState<string|null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [managingGroup, setManagingGroup] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket|null>(null);
  const lastTypingAtRef = useRef(0);
  const stopTypingRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const typingTimersRef = useRef<Map<string,ReturnType<typeof setTimeout>>>(new Map());
  const [typingUsers,setTypingUsers] = useState<Record<string,string>>({});
  const [loadedChatId,setLoadedChatId] = useState<string|null>(null);
  const lastMarkedRef = useRef<string|null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const requestedChatRef = useRef(requestedChat);
  requestedChatRef.current = requestedChat;

  const loadThreads = useCallback(async () => {
    try {
      const rows = await api.chats();
      setThreads(rows);
      setSelected(current => current && rows.some(row => row.id === current) ? current
        : (requestedChatRef.current && rows.some(row=>row.id===requestedChatRef.current?.id)
          ? requestedChatRef.current.id : (rows[0]?.id || null)));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load chats'); }
  }, []);

  useEffect(() => {
    setSelected(requestedChatRef.current?.id || null);
    setMessages([]);
    setLoadedChatId(null);
    lastMarkedRef.current = null;
    setEditingId(null);
    setManagingGroup(false);
    setThreads([]);
    if (workspaceId) void loadThreads();
  }, [workspaceId, loadThreads]);

  useEffect(() => {
    if(requestedChat?.id) setSelected(requestedChat.id);
  },[requestedChat?.nonce, requestedChat?.id]);

  const markViewed = useCallback(async(chatId:string, messageId:string)=>{
    try{
      const read = await api.markChatRead(chatId,messageId);
      setThreads(current=>current.map(t=>t.id===chatId
        ? {...t,unread_count:0,participants:t.participants.map(p=>p.user.id===currentUser.id
          ? {...p,last_read_at:read.last_read_at} : p)} : t));
      onReadRef.current?.();
    }catch(e){setError(e instanceof Error?e.message:'Could not mark chat read');}
  },[currentUser.id]);

  useEffect(() => {
    if (!selected) { setMessages([]); setLoadedChatId(null); setConnected(false); return; }
    let valid = true;
    setMessages([]);
    setLoadedChatId(null);
    setTypingUsers({});
    setEditingId(null);
    setConnected(false);
    api.chatMessages(selected).then(rows => {
      if (valid) {
        setLoadedChatId(selected);
        setMessages(current => {
        const all = new Map([...rows, ...current].map(item => [item.id, item]));
        return [...all.values()].sort(messageOrder);
        });
      }
    }).catch(e => { if (valid) setError(e instanceof Error ? e.message : 'Could not load messages'); });

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/chats/${selected}/`);
    socketRef.current = socket;
    socket.onopen = () => { if (valid) setConnected(true); };
    socket.onclose = () => { if (valid) setConnected(false); };
    socket.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as {
          type:string; message:ChatMessage; user_id?:string;
          full_name?:string; active?:boolean; last_read_at?:string;
        };
        if (!valid) return;
        if (payload.type === 'typing' && payload.user_id && payload.full_name) {
          const id=payload.user_id;
          const oldTimer=typingTimersRef.current.get(id);
          if(oldTimer) clearTimeout(oldTimer);
          if(payload.active) {
            setTypingUsers(old=>({...old,[id]:payload.full_name!}));
            typingTimersRef.current.set(id,setTimeout(()=>{
              setTypingUsers(old=>{const next={...old};delete next[id];return next;});
              typingTimersRef.current.delete(id);
            },3000));
          } else {
            setTypingUsers(old=>{const next={...old};delete next[id];return next;});
            typingTimersRef.current.delete(id);
          }
        } else if (payload.type === 'read_receipt' && payload.user_id && payload.last_read_at) {
          const id=payload.user_id,readAt=payload.last_read_at;
          setThreads(old=>old.map(t=>t.id===selected
            ? {...t,participants:t.participants.map(p=>p.user.id===id ? {...p,last_read_at:readAt} : p)} : t));
        } else if (payload.type === 'message' && payload.message) {
          setMessages(current => current.some(row => row.id === payload.message.id)
            ? current : [...current, payload.message].sort(messageOrder));
          void loadThreads();
        } else if ((payload.type === 'message.updated' || payload.type === 'message.deleted') && payload.message) {
          setMessages(current => current.map(row => row.id === payload.message.id ? payload.message : row));
        } else if (payload.type === 'participants_changed') {
          void loadThreads();
        }
      } catch { /* Ignore unexpected socket events. */ }
    };
    return () => {
      valid = false;
      if(socketRef.current===socket) socketRef.current=null;
      if(stopTypingRef.current) clearTimeout(stopTypingRef.current);
      typingTimersRef.current.forEach(timer=>clearTimeout(timer));
      typingTimersRef.current.clear();
      socket.close();
    };
  }, [selected, loadThreads]);

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [messages.length]);

  const latest = messages[messages.length-1];
  const latestId = latest?.id;
  useEffect(()=>{
    if(!selected || loadedChatId!==selected || !latestId || document.visibilityState!=='visible')return;
    const key=`${selected}:${latestId}`;
    if(lastMarkedRef.current===key)return;
    lastMarkedRef.current=key;
    void markViewed(selected,latestId);
  },[selected,loadedChatId,latestId,markViewed]);

  useEffect(()=>{
    const handleVisibility=()=>{
      if(document.visibilityState==='visible' && selected && latestId && loadedChatId===selected)
        void markViewed(selected,latestId);
    };
    document.addEventListener('visibilitychange',handleVisibility);
    return()=>document.removeEventListener('visibilitychange',handleVisibility);
  },[selected,latestId,loadedChatId,markViewed]);

  function emitTyping(active:boolean) {
    const socket=socketRef.current;
    if(!socket || socket.readyState!==WebSocket.OPEN)return;
    const now=Date.now();
    if(active && now-lastTypingAtRef.current<1500)return;
    lastTypingAtRef.current=now;
    socket.send(JSON.stringify({type:'typing',active}));
  }
  function changeDraft(value:string) {
    setDraft(value);
    if(stopTypingRef.current)clearTimeout(stopTypingRef.current);
    if(!value.trim()){emitTyping(false);return;}
    emitTyping(true);
    stopTypingRef.current=setTimeout(()=>emitTyping(false),2200);
  }

  const active = threads.find(thread => thread.id === selected);
  const colleagues = members.filter(member => member.user.id !== currentUser.id);
  const groupCandidates = colleagues.filter(m => !active?.participants.some(p => p.user.id === m.user.id));
  const visibleThreads = threads.filter(thread =>
    titleFor(thread, currentUser.id).toLowerCase().includes(filter.toLowerCase()),
  );

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    setWorking(true);
    try {
      const thread = mode === 'direct'
        ? await api.startDirectChat(directEmail)
        : await api.startGroupChat(groupTitle, groupEmails);
      setMode(null);
      setDirectEmail('');
      setGroupTitle('');
      setGroupEmails([]);
      await loadThreads();
      setSelected(thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create conversation');
    } finally { setWorking(false); }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!selected || !draft.trim() || working) return;
    const body = draft.trim();
    setDraft('');
    emitTyping(false);
    if(stopTypingRef.current) clearTimeout(stopTypingRef.current);
    setError('');
    setWorking(true);
    try {
      const sent = await api.sendChatMessage(selected, body);
      setMessages(current => current.some(row => row.id === sent.id)
        ? current : [...current, sent].sort(messageOrder));
      await loadThreads();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send message');
      setDraft(body);
    } finally { setWorking(false); }
  }

  async function editMessage(e: FormEvent, messageId: string) {
    e.preventDefault();
    if (!selected || !editDraft.trim() || working) return;
    setWorking(true);
    setError('');
    try {
      const updated = await api.editChatMessage(selected, messageId, editDraft);
      setMessages(current => current.map(row => row.id === updated.id ? updated : row));
      setEditingId(null);
      setEditDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not edit message');
    } finally { setWorking(false); }
  }

  async function deleteMessage(message: ChatMessage) {
    if (!selected || working || !window.confirm('Delete this message for everyone in the chat?')) return;
    setWorking(true);
    setError('');
    try {
      await api.deleteChatMessage(selected, message.id);
      const rows = await api.chatMessages(selected);
      setMessages(rows);
      if (editingId === message.id) setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete message');
    } finally { setWorking(false); }
  }

  async function addParticipant(e: FormEvent) {
    e.preventDefault();
    if (!selected || !addEmail || working) return;
    setWorking(true);
    setError('');
    try {
      await api.addGroupParticipant(selected, addEmail);
      setAddEmail('');
      await loadThreads();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add teammate');
    } finally { setWorking(false); }
  }

  async function removeParticipant(user: Person) {
    if (!selected || working || !window.confirm(`Remove ${user.full_name} from this group chat?`)) return;
    setWorking(true);
    setError('');
    try {
      await api.removeGroupParticipant(selected, user.id);
      await loadThreads();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove teammate');
    } finally { setWorking(false); }
  }

  return <section className="private-chat-page">
    <div className="private-chat-heading">
      <div><div className="eyebrow">YOUR WORKSPACE / MESSAGES</div><h1>Chats</h1><p>Private conversations with teammates in this company.</p></div>
      <button className="primary-button" type="button" onClick={() => setMode('direct')}><Plus size={17}/> New chat</button>
    </div>
    {error && <div className="chat-alert" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
    <div className="private-chat-layout">
      <aside className="private-chat-list">
        <div className="private-chat-list-heading"><strong>Conversations</strong><button type="button" className="icon-button" aria-label="Refresh chats" title="Refresh chats" onClick={() => void loadThreads()}><RefreshCw size={16}/></button></div>
        <input className="chat-filter" aria-label="Search conversations" placeholder="Search conversations" value={filter} onChange={e => setFilter(e.target.value)}/>
        {visibleThreads.map(thread => <button type="button" key={thread.id} className={`chat-thread ${selected === thread.id ? 'selected' : ''}`} onClick={() => setSelected(thread.id)}>
          <span className="chat-thread-avatar">{thread.kind === 'group' ? <Users size={17}/> : initials(titleFor(thread,currentUser.id))}</span>
          <span className="chat-thread-details"><strong>{titleFor(thread,currentUser.id)}</strong><small>{thread.kind === 'group' ? `${thread.participants.length} participants` : 'Direct message'}</small></span>
          {thread.unread_count>0&&<span className="chat-unread-badge" aria-label={`${thread.unread_count} unread messages`}>{thread.unread_count>99?'99+':thread.unread_count}</span>}
        </button>)}
        {visibleThreads.length === 0 && <div className="chat-list-empty">No conversations yet. Start a new chat with a colleague.</div>}
        <button type="button" className="new-group-link" onClick={() => setMode('group')}><Users size={15}/> Create group chat</button>
      </aside>
      <div className="private-chat-conversation">
        {active ? <>
          <header className="private-chat-toolbar">
            <span className="chat-thread-avatar large">{active.kind === 'group' ? <Users size={19}/> : initials(titleFor(active,currentUser.id))}</span>
            <div><h2>{titleFor(active,currentUser.id)}</h2><p>{active.participants.map(p => p.user.full_name).join(', ')}</p></div>
            {active.kind==='group' && active.created_by.id===currentUser.id && <button type="button" className="group-manage-button" onClick={() => setManagingGroup(true)}><Users size={15}/> Manage group</button>}
            <span className={`chat-connected ${connected ? 'yes' : ''}`} title={connected ? 'Live updates connected' : 'Messages saved; live updates unavailable'}/>
          </header>
          <div className="private-chat-history">
            {messages.length === 0 && <div className="private-chat-welcome"><MessageCircle size={30}/><h3>Start the conversation</h3><p>Only participants in this workspace can read these messages.</p></div>}
            {messages.map(message => <div key={message.id} className={`private-message ${message.sender.id===currentUser.id ? 'mine' : ''}`}>
              <div className="private-message-meta"><strong>{message.sender.full_name}</strong><time>{timeFor(message.created_at)}</time></div>
              {editingId===message.id ? <form className="message-edit-form" onSubmit={e => void editMessage(e,message.id)}>
                <input autoFocus aria-label="Edit message" maxLength={4000} value={editDraft} onChange={e => setEditDraft(e.target.value)}/>
                <div><button type="button" onClick={() => setEditingId(null)} disabled={working}>Cancel</button><button type="submit" disabled={working || !editDraft.trim()}>Save</button></div>
              </form> : <div className={`private-message-body ${message.deleted_at ? 'deleted' : ''}`}>{message.deleted_at ? 'Message deleted' : message.body}{!message.deleted_at && message.edited_at && <small className="edited-note"> (edited)</small>}</div>}
              {message.sender.id===currentUser.id && <div className="chat-read-receipt">{
                active.participants.some(p=>p.user.id!==currentUser.id && p.last_read_at && new Date(p.last_read_at).getTime()>=new Date(message.created_at).getTime())
                  ? (active.kind==='direct' ? 'Seen' : `Seen by ${active.participants.filter(p=>p.user.id!==currentUser.id && p.last_read_at && new Date(p.last_read_at).getTime()>=new Date(message.created_at).getTime()).length}`)
                  : 'Sent'
              }</div>}
              {message.sender.id===currentUser.id && !message.deleted_at && editingId!==message.id && <div className="private-message-actions"><button type="button" disabled={working} onClick={() => {setEditingId(message.id);setEditDraft(message.body);}}>Edit</button><button type="button" disabled={working} onClick={() => void deleteMessage(message)}>Delete</button></div>}
            </div>)}
            <div ref={bottomRef}/>
          </div>
          {Object.keys(typingUsers).length>0&&<div className="chat-typing-indicator" aria-live="polite">{Object.values(typingUsers).join(', ')} {Object.keys(typingUsers).length>1?'are':'is'} typing…</div>}
          <form className="private-chat-compose" onSubmit={send}><input aria-label="Write a message" value={draft} maxLength={4000} placeholder="Write a message..." onChange={e => changeDraft(e.target.value)} onBlur={()=>emitTyping(false)}/><button className="send-button" aria-label="Send message" disabled={!draft.trim()||working}><Send size={18}/></button></form>
        </> : <div className="private-chat-welcome"><MessageCircle size={32}/><h3>Connect with your team</h3><p>Choose a conversation or start a new one.</p></div>}
      </div>
    </div>
    {managingGroup && active?.kind==='group' && active.created_by.id===currentUser.id && <div className="modal-backdrop" onMouseDown={e => {if (e.target===e.currentTarget) setManagingGroup(false);}}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Manage group participants">
        <div className="modal-head"><div><div className="eyebrow">GROUP CHAT</div><h2>Manage participants</h2></div><button className="icon-button" onClick={() => setManagingGroup(false)} aria-label="Close"><X size={19}/></button></div>
        <div className="modal-body">
          <p className="muted">New participants see messages from the time they join, not earlier chat history.</p>
          <div className="member-list">{active.participants.map(p => <div className="member-row" key={p.user.id}><div className="avatar small-avatar">{initials(p.user.full_name)}</div><div><strong>{p.user.full_name}</strong><small>{p.user.email}</small></div>{p.user.id===active.created_by.id ? <span className="role-pill">Creator</span> : <button className="member-remove" disabled={working} onClick={() => void removeParticipant(p.user)}>Remove</button>}</div>)}</div>
          <form className="group-manage-add" onSubmit={addParticipant}>
            <label>Add teammate<select aria-label="Select teammate to add" value={addEmail} onChange={e => setAddEmail(e.target.value)} required><option value="">Choose a member</option>{groupCandidates.map(m => <option key={m.id} value={m.user.email}>{m.user.full_name} ({m.user.email})</option>)}</select></label>
            <button type="submit" className="primary-button" disabled={!addEmail || working || active.participants.length>=25}><Plus size={15}/> Add to group</button>
          </form>
          {active.participants.length>=25 && <p className="muted">Group is at the 25-person limit.</p>}
        </div>
      </div>
    </div>}
    {mode && <div className="modal-backdrop" onMouseDown={e => {if (e.target === e.currentTarget) setMode(null);}}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={mode==='direct'?'New direct chat':'New group chat'}>
        <div className="modal-head"><div><div className="eyebrow">TEAMWORKSPACE</div><h2>{mode==='direct'?'New direct chat':'Create group chat'}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setMode(null)}><X size={19}/></button></div>
        <form className="modal-body" onSubmit={create}>
          {mode==='direct' ? <>
            <p className="muted">Choose an employee in the current company workspace.</p>
            <label>Teammate<select required value={directEmail} onChange={e => setDirectEmail(e.target.value)}><option value="">Select teammate</option>{colleagues.map(m => <option key={m.id} value={m.user.email}>{m.user.full_name} ({m.user.email})</option>)}</select></label>
          </> : <>
            <label>Group name<input required minLength={2} maxLength={100} value={groupTitle} onChange={e => setGroupTitle(e.target.value)} placeholder="e.g. Design discussion"/></label>
            <p className="muted">Select at least two teammates.</p>
            <div className="group-people-picker">{colleagues.map(m => <label key={m.id}><input type="checkbox" checked={groupEmails.includes(m.user.email)} onChange={e => setGroupEmails(old => e.target.checked ? [...old,m.user.email] : old.filter(email => email!==m.user.email))}/><span>{m.user.full_name} <small>{m.user.email}</small></span></label>)}</div>
          </>}
          {colleagues.length===0&&<p className="muted">Invite employees to your company before starting chats.</p>}
          <div className="modal-actions"><button type="button" className="outline-button" onClick={() => setMode(null)}>Cancel</button><button className="primary-button" disabled={working || (mode==='direct' ? !directEmail : !groupTitle.trim()||groupEmails.length<2)}>Create <ArrowRight size={16}/></button></div>
        </form>
      </div>
    </div>}
  </section>;
}
