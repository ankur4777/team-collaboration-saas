import {useEffect,useRef,useState,type FormEvent} from 'react';
import {FileText,Image as ImageIcon,Search,Users,X} from 'lucide-react';
import {api,type ChannelMessageCursor,type ChatMessage,type ChatThread,type PrivateAttachment} from './api';
import {ChatFileMessage} from './ChatFileMessage';

export default function ChatDetails({chat,mode,currentUserId,onClose,onOpenMessage}:{chat:ChatThread;mode:'info'|'search'|'media';currentUserId:string;onClose:()=>void;onOpenMessage:(id:string)=>void}){
  const [query,setQuery]=useState(''),[messages,setMessages]=useState<ChatMessage[]>([]),[files,setFiles]=useState<PrivateAttachment[]>([]),[cursor,setCursor]=useState<ChannelMessageCursor|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[searched,setSearched]=useState(false),[filter,setFilter]=useState<'all'|'photos'|'documents'|'audio'>('all');
  const sequence=useRef(0),root=useRef<HTMLElement>(null),previous=useRef(document.activeElement);
  useEffect(()=>{root.current?.querySelector<HTMLElement>('input,button')?.focus();return()=>{sequence.current++;if(previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus();};},[]);
  async function load(more=false){
    if(busy)return;const run=++sequence.current;setBusy(true);setError('');
    try{
      if(mode==='media'){
        const page=await api.chatMedia(chat.id,more?cursor:null);if(sequence.current!==run)return;
        setFiles(old=>more?[...new Map([...old,...page.items].map(row=>[row.id,row])).values()]:page.items);setCursor(page.next_cursor);
      }else{
        if(!query.trim())return;const page=await api.searchChatMessages(chat.id,query.trim(),more?cursor:null);if(sequence.current!==run)return;
        setMessages(old=>more?[...new Map([...old,...page.items].map(row=>[row.id,row])).values()]:page.items);setCursor(page.next_cursor);setSearched(true);
      }
    }catch(reason){if(sequence.current===run)setError(reason instanceof Error?reason.message:'Could not load this chat.');}
    finally{if(sequence.current===run)setBusy(false);}
  }
  useEffect(()=>{if(mode==='media')void load();return()=>{sequence.current++;};},[chat.id,mode]);
  const visible=files.filter(row=>filter==='all'||filter==='photos'&&row.content_type.startsWith('image/')||filter==='audio'&&row.content_type.startsWith('audio/')||filter==='documents'&&!/^(image|audio)\//.test(row.content_type));
  const title=mode==='search'?'Search in conversation':mode==='media'?'Shared media & files':chat.kind==='group'?'Group info':'Contact info';
  return <aside ref={root} className="chat-details-panel" aria-label={title} onKeyDown={event=>{if(event.key==='Escape')onClose();}}>
    <header><h3>{title}</h3><button type="button" className="icon-button" aria-label="Close chat details" onClick={onClose}><X size={19}/></button></header>
    {mode==='search'&&<form className="chat-details-search" onSubmit={(event:FormEvent)=>{event.preventDefault();void load();}}><input autoFocus type="search" maxLength={100} aria-label="Search this conversation" placeholder="Search messages or filenames" value={query} onChange={event=>{sequence.current++;setBusy(false);setQuery(event.target.value);setSearched(false);setMessages([]);setCursor(null);}}/><button type="submit" className="icon-button" aria-label="Find messages" disabled={busy||!query.trim()}><Search size={18}/></button></form>}
    {mode==='media'&&<div className="chat-media-filters" role="group" aria-label="Shared media type">{([['all','All'],['photos','Photos'],['documents','Docs'],['audio','Audio']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>}
    <div className="chat-details-content">
      {error&&<p role="alert" className="chat-file-error">{error}<button type="button" onClick={()=>void load()}>Retry</button></p>}
      {mode==='info'&&<><div className="chat-details-avatar"><Users size={30}/></div><h4>{chat.kind==='group'?chat.title:chat.participants.find(row=>row.user.id!==currentUserId)?.user.full_name||'Contact'}</h4><p className="chat-details-hint">{chat.kind==='group'?`${chat.participants.length} participants`:'Workspace conversation'}</p><h5>Participants</h5>{chat.participants.map(row=><div className="chat-details-person" key={row.user.id}><span>{row.user.full_name.slice(0,1)}</span><div><strong>{row.user.full_name}{row.user.id===currentUserId?' (You)':''}</strong><small>{row.user.email}</small></div>{chat.kind==='group'&&row.user.id===chat.created_by.id&&<small>Group admin</small>}</div>)}</>}
      {mode==='search'&&messages.map(row=><button type="button" className="chat-search-result" key={row.id} onClick={()=>{onOpenMessage(row.id);onClose();}}><strong>{row.sender.full_name}</strong><small>{new Date(row.created_at).toLocaleString()}</small><p>{row.body||row.attachment?.name}</p>{row.attachment&&<span><FileText size={13}/> {row.attachment.name}</span>}</button>)}
      {mode==='search'&&!busy&&searched&&!messages.length&&<p className="chat-details-hint">No matching messages in this conversation.</p>}
      {mode==='search'&&!searched&&!busy&&<p className="chat-details-hint">Find a message in this chat, including older history.</p>}
      {mode==='media'&&visible.map(row=><div className="chat-shared-file" key={row.id}><small>{row.uploaded_by.full_name} · {new Date(row.created_at).toLocaleDateString()}</small><ChatFileMessage file={row}/></div>)}
      {mode==='media'&&!busy&&!visible.length&&<div className="chat-details-empty"><ImageIcon size={30}/><p>No shared files in this category.</p></div>}
      {busy&&<p role="status" className="chat-details-hint">Loading…</p>}
      {cursor&&<button type="button" className="outline-button" disabled={busy} onClick={()=>void load(true)}>Load more</button>}
    </div>
  </aside>;
}
