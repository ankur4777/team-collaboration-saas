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

interface Props { workspaceId: string|null; currentUser: Person; members: Member[] }

export default function ChatPanel({workspaceId, currentUser, members}: Props) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selected, setSelected] = useState<string|null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'direct'|'group'|null>(null);
  const [directEmail, setDirectEmail] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupEmails, setGroupEmails] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const rows = await api.chats();
      setThreads(rows);
      setSelected(current => current && rows.some(row => row.id === current) ? current : (rows[0]?.id || null));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load chats'); }
  }, []);

  useEffect(() => {
    setSelected(null);
    setMessages([]);
    setThreads([]);
    if (workspaceId) void loadThreads();
  }, [workspaceId, loadThreads]);

  useEffect(() => {
    if (!selected) { setMessages([]); setConnected(false); return; }
    let valid = true;
    setMessages([]);
    setConnected(false);
    api.chatMessages(selected).then(rows => {
      if (valid) setMessages(current => {
        const all = new Map([...rows, ...current].map(item => [item.id, item]));
        return [...all.values()].sort(messageOrder);
      });
    }).catch(e => { if (valid) setError(e instanceof Error ? e.message : 'Could not load messages'); });

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/chats/${selected}/`);
    socket.onopen = () => { if (valid) setConnected(true); };
    socket.onclose = () => { if (valid) setConnected(false); };
    socket.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as {type: string; message: ChatMessage};
        if (valid && payload.type === 'message') {
          setMessages(current => current.some(row => row.id === payload.message.id)
            ? current : [...current, payload.message].sort(messageOrder));
          void loadThreads();
        }
      } catch { /* Ignore unexpected socket events. */ }
    };
    return () => { valid = false; socket.close(); };
  }, [selected, loadThreads]);

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [messages.length]);

  const active = threads.find(thread => thread.id === selected);
  const colleagues = members.filter(member => member.user.id !== currentUser.id);
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
        </button>)}
        {visibleThreads.length === 0 && <div className="chat-list-empty">No conversations yet. Start a new chat with a colleague.</div>}
        <button type="button" className="new-group-link" onClick={() => setMode('group')}><Users size={15}/> Create group chat</button>
      </aside>
      <div className="private-chat-conversation">
        {active ? <>
          <header className="private-chat-toolbar">
            <span className="chat-thread-avatar large">{active.kind === 'group' ? <Users size={19}/> : initials(titleFor(active,currentUser.id))}</span>
            <div><h2>{titleFor(active,currentUser.id)}</h2><p>{active.participants.map(p => p.user.full_name).join(', ')}</p></div>
            <span className={`chat-connected ${connected ? 'yes' : ''}`} title={connected ? 'Live updates connected' : 'Messages saved; live updates unavailable'}/>
          </header>
          <div className="private-chat-history">
            {messages.length === 0 && <div className="private-chat-welcome"><MessageCircle size={30}/><h3>Start the conversation</h3><p>Only participants in this workspace can read these messages.</p></div>}
            {messages.map(message => <div key={message.id} className={`private-message ${message.sender.id===currentUser.id ? 'mine' : ''}`}>
              <div className="private-message-meta"><strong>{message.sender.full_name}</strong><time>{timeFor(message.created_at)}</time></div>
              <div className="private-message-body">{message.body}</div>
            </div>)}
            <div ref={bottomRef}/>
          </div>
          <form className="private-chat-compose" onSubmit={send}><input aria-label="Write a message" value={draft} maxLength={4000} placeholder="Write a message..." onChange={e => setDraft(e.target.value)}/><button className="send-button" aria-label="Send message" disabled={!draft.trim()||working}><Send size={18}/></button></form>
        </> : <div className="private-chat-welcome"><MessageCircle size={32}/><h3>Connect with your team</h3><p>Choose a conversation or start a new one.</p></div>}
      </div>
    </div>
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
