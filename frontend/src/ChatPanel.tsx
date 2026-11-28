import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, Bell, BellOff, Check, CheckCheck, CheckSquare, FileText, Info, LogOut, MessageCircle, Pin, PinOff, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react';
import { api, type ChatMessage, type ChannelMessageCursor, type ChatThread, type Member, type Person, type PresenceMap, type ChatDirectoryData } from './api';
import ChatDirectory from './ChatDirectory';
import TasksPanel from './TasksPanel';
import ChatReactionBar from './ChatReactionBar';
import {connectConversationSocket,mergeFreshHistory} from './conversationSocket';
import {ApiError} from './api';
import {ChatComposer,ChatFileMessage} from './ChatFileMessage';
import {useConversationDraft} from './conversationDrafts';
import ReplyPreview from './ReplyPreview';
import MessageActions from './MessageActions';
import MessageContext from './MessageContext';
import {PresenceStatus,presenceLabel} from './WorkspacePresence';
import PinnedMessages from './PinnedMessages';
import ForwardMessageDialog from './ForwardMessageDialog';
import ChatOptionsMenu from './ChatOptionsMenu';
import ChatDetails from './ChatDetails';
import ChatAvatar from './ChatAvatar';
import {ProfileEditor} from './ProfileMenu';
import {Pencil} from 'lucide-react';
import ChatCallControls from './ChatCallControls';
import './ChatPanel.css';
import './WhatsAppChat.css';

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

interface Props { workspaceId: string|null; currentUser: Person; members: Member[]; presence?: PresenceMap; requestedChat?: {id:string;nonce:number;messageId?:string}|null; onRead?: ()=>void; notificationVersion?:number; callsEnabled?:boolean; onProfileSaved?:(user:Person)=>void }

export default function ChatPanel({workspaceId, currentUser, members, presence={}, requestedChat, onRead,notificationVersion=0,callsEnabled=false,onProfileSaved}: Props) {
  const [editingOwnProfile,setEditingOwnProfile]=useState(false);
  const [details,setDetails]=useState<'info'|'search'|'media'|null>(null),[searchJump,setSearchJump]=useState<{id:string;nonce:number}|null>(null),[notice,setNotice]=useState('');
  useEffect(()=>{setDetails(null);setSearchJump(null);},[workspaceId]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),2200);return()=>clearTimeout(timer);},[notice]);
  const [section,setSection]=useState<'chats'|'tasks'>('chats');
  const [listView,setListView]=useState<'messages'|'people'>('messages');
  const [directory,setDirectory]=useState<ChatDirectoryData|null>(null),[directoryLoading,setDirectoryLoading]=useState(true);
  const [threadKind,setThreadKind]=useState<'all'|'direct'|'group'>('all');
  const directoryRun=useRef(0);
  const loadDirectory=useCallback(async()=>{const run=++directoryRun.current;if(!workspaceId)return;setDirectoryLoading(true);try{const rows=await api.chatDirectory();if(run===directoryRun.current)setDirectory(rows);}catch{/* Directory displays an unavailable state; existing chats remain accessible. */}finally{if(run===directoryRun.current)setDirectoryLoading(false);}},[workspaceId]);
  useEffect(()=>{setDirectory(null);void loadDirectory();return()=>{directoryRun.current++;};},[loadDirectory]);
  const [jumpClosed,setJumpClosed]=useState<number|null>(null);
  const [showArchived,setShowArchived]=useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadsLoading,setThreadsLoading]=useState(true);
  const [selected, setSelected] = useState<string|null>(null);
  useEffect(()=>{setDetails(null);setSearchJump(null);},[selected]);
  const [pinVersion,setPinVersion]=useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyCursor, setHistoryCursor] = useState<ChannelMessageCursor|null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  const scrollRestoreRef = useRef<{height:number;top:number}|null>(null);
  const scopeRef = useRef({selected,workspaceId});
  scopeRef.current = {selected,workspaceId};
  const {draft,setDraft,writeDraft}=useConversationDraft(currentUser.id,workspaceId,'chat',selected);
  const [forwardId,setForwardId]=useState<string|null>(null);
  const forwardTarget=messages.find(row=>row.id===forwardId);
  const [replyTo,setReplyTo] = useState<{chatId:string;messageId:string}|null>(null);
  const replyTarget=replyTo?.chatId===selected?messages.find(row=>row.id===replyTo.messageId&&!row.deleted_at):undefined;
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

  const listRequest=useRef(0);
  const loadThreads = useCallback(async () => {
    const run=++listRequest.current;
    const org=scopeRef.current.workspaceId;
    if(!org){setThreadsLoading(false);return;}
    setThreadsLoading(true);
    try {
      const rows = await api.chats();
      if(run!==listRequest.current||scopeRef.current.workspaceId!==org)return;
      setThreads(rows);
      // Loading or refreshing the list must never open a conversation by itself.
      setSelected(current => current && rows.some(row => row.id === current) ? current : null);
    } catch (e) { if(run===listRequest.current&&scopeRef.current.workspaceId===org)setError(e instanceof Error ? e.message : 'Could not load chats'); }
    finally{if(run===listRequest.current&&scopeRef.current.workspaceId===org)setThreadsLoading(false);}
  }, []);

  useEffect(() => {
    setSelected(requestedChatRef.current?.id || null);
    setMessages([]);
    setLoadedChatId(null);
    lastMarkedRef.current = null;
    setEditingId(null);
    setManagingGroup(false);
    setThreads([]);
    setThreadsLoading(Boolean(workspaceId));
    if (workspaceId) void loadThreads();
    return()=>{listRequest.current++;};
  }, [workspaceId, loadThreads]);

  useEffect(()=>{
    if(!workspaceId)return;
    const refresh=()=>{if(!document.hidden){void loadThreads();void loadDirectory();}};
    const timer=window.setInterval(refresh,15000);
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[workspaceId,loadThreads,loadDirectory]);
  useEffect(()=>{if(notificationVersion>0&&workspaceId)void loadThreads();},[notificationVersion,workspaceId,loadThreads]);

  useEffect(() => {
    if(requestedChat?.id) {setSelected(requestedChat.id);setSection('chats');setListView('messages');}
  },[requestedChat?.nonce, requestedChat?.id]);

  const markViewed = useCallback(async(chatId:string, messageId:string)=>{
    try{
      const read = await api.markChatRead(chatId,messageId);
      setThreads(current=>current.map(t=>t.id===chatId
        ? {...t,participants:t.participants.map(p=>p.user.id===currentUser.id
          ? {...p,last_read_at:read.last_read_at} : p)} : t));
      void loadThreads();
      onReadRef.current?.();
    }catch(e){lastMarkedRef.current=null;setError(e instanceof Error?e.message:'Could not mark chat read');}
  },[currentUser.id,loadThreads]);

  useEffect(() => {
    setReplyTo(null);setForwardId(null);
    historyRequestRef.current++;
    setHistoryCursor(null);
    setLoadingOlder(false);
    scrollRestoreRef.current = null;
    if (!selected) { setMessages([]); setLoadedChatId(null); setConnected(false); return; }
    let valid = true;
    setMessages([]);
    setLoadedChatId(null);
    setTypingUsers({});
    setEditingId(null);
    setConnected(false);
    let revision=0,syncing=false,stopSocket=()=>{};
    const live=new Map<string,ChatMessage>();
    function denied(){
      if(!valid)return;valid=false;revision++;historyRequestRef.current++;
      stopSocket();socketRef.current=null;setConnected(false);setHistoryCursor(null);setLoadingOlder(false);
      setLoadedChatId(null);setMessages([]);setReplyTo(null);setForwardId(null);writeDraft(selected,'');
      setThreads(old=>old.filter(t=>t.id!==selected));setSelected(null);void loadThreads();
    }
    async function refresh(){
      const run=++revision;syncing=true;live.clear();
      historyRequestRef.current++;setLoadingOlder(false);setHistoryCursor(null);scrollRestoreRef.current=null;
      try{
        const page=await api.chatMessagePage(selected!);
        if(!valid||run!==revision)return;
        setHistoryCursor(page.next_cursor);setLoadedChatId(selected);
        setMessages(mergeFreshHistory(page.items,live));setPinVersion(v=>v+1);
      }catch(e){
        if(!valid||run!==revision)return;
        if(e instanceof ApiError&&[401,403,404].includes(e.status)){denied();return;}
        setError(e instanceof Error?e.message:'Could not load messages');
      }finally{if(valid&&run===revision){syncing=false;live.clear();}}
    }
    stopSocket=connectConversationSocket(`/ws/chats/${selected}/`,{
      onAttempt:()=>{void refresh();},
      onOpen:socket=>{if(valid){socketRef.current=socket;setConnected(true);void refresh();void loadThreads();}},
      onDisconnected:()=>{if(valid){socketRef.current=null;setConnected(false);setTypingUsers({});}},
      onDenied:denied,
      onMessage:event=>{
      try {
        const payload = JSON.parse(event.data) as {
          type:string; message:ChatMessage; user_id?:string;
          full_name?:string; active?:boolean; last_read_at?:string;
        };
        if (!valid) return;
        if(syncing&&payload.message&&['message','message.updated','message.deleted'].includes(payload.type))live.set(payload.message.id,payload.message);
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
          setMessages(current => current.map(row => row.id === payload.message.id ? payload.message : row));setPinVersion(value=>value+1);
        } else if (payload.type === 'participants_changed') {
          void loadThreads();
        }
      } catch { /* Ignore unexpected socket events. */ }
      },
    });
    if(!navigator.onLine)void refresh();
    return () => {
      valid = false;revision++;historyRequestRef.current++;
      socketRef.current=null;
      if(stopTypingRef.current) clearTimeout(stopTypingRef.current);
      typingTimersRef.current.forEach(timer=>clearTimeout(timer));
      typingTimersRef.current.clear();
      stopSocket();
    };
  }, [selected, workspaceId, loadThreads,writeDraft]);

  const latest = messages[messages.length-1];
  const latestId = latest?.id;
  useEffect(() => { if(latestId && section==='chats') bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [selected,latestId,section]);
  useLayoutEffect(() => {
    const old = scrollRestoreRef.current;
    if(old && historyRef.current) {
      historyRef.current.scrollTop = old.top + historyRef.current.scrollHeight - old.height;
      scrollRestoreRef.current = null;
    }
  },[messages,loadingOlder]);
  useEffect(()=>{
    if(section!=='chats' || !selected || loadedChatId!==selected || !latestId || document.visibilityState!=='visible')return;
    const key=`${selected}:${latestId}`;
    if(lastMarkedRef.current===key)return;
    lastMarkedRef.current=key;
    void markViewed(selected,latestId);
  },[section,selected,loadedChatId,latestId,markViewed]);

  useEffect(()=>{
    const handleVisibility=()=>{
      if(section==='chats' && document.visibilityState==='visible' && selected && latestId && loadedChatId===selected)
        void markViewed(selected,latestId);
    };
    document.addEventListener('visibilitychange',handleVisibility);
    return()=>document.removeEventListener('visibilitychange',handleVisibility);
  },[section,selected,latestId,loadedChatId,markViewed]);

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
  function dayLabel(value:string){const date=new Date(value),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);return date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString([],{day:'numeric',month:'long',year:'numeric'});}
  const peerId=active?.participants.find(p=>p.user.id!==currentUser.id)?.user.id;
  const onlineCount=active?.participants.filter(p=>presence[p.user.id]?.online).length||0;
  const colleagues = (directory?.members||members).filter(member => member.user.id !== currentUser.id);
  const groupCandidates = colleagues.filter(m => !active?.participants.some(p => p.user.id === m.user.id));
  const visibleThreads = threads.filter(thread =>
    Boolean(thread.archived_at)===showArchived && (threadKind==='all'||thread.kind===threadKind) && titleFor(thread, currentUser.id).toLowerCase().includes(filter.toLowerCase()),
  ).sort((a,b)=>Number(Boolean(b.is_pinned))-Number(Boolean(a.is_pinned)));

  async function loadOlder() {
    if (!selected || !historyCursor || loadingOlder || loadedChatId!==selected) return;
    const chatId = selected, orgId = workspaceId;
    const token = ++historyRequestRef.current;
    const isCurrent = () => token===historyRequestRef.current && scopeRef.current.selected===chatId && scopeRef.current.workspaceId===orgId;
    setLoadingOlder(true); setError('');
    try {
      const page = await api.chatMessagePage(chatId, historyCursor);
      if (!isCurrent()) return;
      if (historyRef.current) scrollRestoreRef.current = {height:historyRef.current.scrollHeight,top:historyRef.current.scrollTop};
      setMessages(current => [...new Map([...page.items,...current].map(item=>[item.id,item])).values()].sort(messageOrder));
      setHistoryCursor(page.next_cursor);
    } catch(e) {
      if(isCurrent()) setError(e instanceof Error ? e.message : 'Could not load older messages');
    } finally { if(isCurrent()) setLoadingOlder(false); }
  }

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
      setShowArchived(false);setThreadKind('all');setFilter('');setListView('messages');setSelected(thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create conversation');
    } finally { setWorking(false); }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!selected || !draft.trim() || working) return;
    const originalDraft=draft;
    const body = draft.trim();
    const chatId=selected,orgId=workspaceId,original=replyTarget?.id;
    writeDraft(chatId,'');setReplyTo(null);
    emitTyping(false);
    if(stopTypingRef.current) clearTimeout(stopTypingRef.current);
    setError('');
    setWorking(true);
    try {
      const sent = await api.sendChatMessage(chatId, body, original);
      if(scopeRef.current.selected!==chatId||scopeRef.current.workspaceId!==orgId)return;
      setMessages(current => current.some(row => row.id === sent.id)
        ? current : [...current, sent].sort(messageOrder));
      await loadThreads();
    } catch (e) {
      if(scopeRef.current.workspaceId===orgId){writeDraft(chatId,current=>current||originalDraft);if(scopeRef.current.selected===chatId){setError(e instanceof Error ? e.message : 'Could not send message');if(original)setReplyTo(current=>current||{chatId,messageId:original});}}
    } finally { setWorking(false); }
  }

  async function sendAttachment(file:File){
    if(!selected||working)throw new Error('Wait for the current action to finish.');
    const chatId=selected,orgId=workspaceId,originalDraft=draft,replyId=replyTarget?.id;
    setWorking(true);emitTyping(false);
    try{
      const result=await api.uploadChatAttachment(chatId,file,draft.trim(),replyId);
      if(scopeRef.current.workspaceId!==orgId)return;
      writeDraft(chatId,value=>value===originalDraft?'':value);
      if(scopeRef.current.selected===chatId){
        setReplyTo(null);
        setMessages(rows=>rows.some(row=>row.id===result.message.id)?rows:[...rows,result.message].sort(messageOrder));
      }
      await loadThreads();
    }finally{setWorking(false);}
  }

  async function editMessage(e: FormEvent, messageId: string) {
    e.preventDefault();
    if (!selected || !editDraft.trim() || working) return;
    setWorking(true);
    setError('');
    try {
      const updated = await api.editChatMessage(selected, messageId, editDraft);
      setMessages(current => current.map(row => row.id === updated.id ? updated : row));setPinVersion(value=>value+1);
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
      if(scopeRef.current.selected===selected && scopeRef.current.workspaceId===workspaceId) {
        setMessages(current => current.map(row => row.id===message.id && !row.deleted_at
          ? {...row, body:'', pinned_at:null, deleted_at:new Date().toISOString(), reactions:[]} : row));
      }
      setPinVersion(value=>value+1);
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

  async function pinMessage(message:ChatMessage){
    if(!selected||working||message.deleted_at)return;
    const chatId=selected,orgId=workspaceId;
    setWorking(true);setError('');
    try{const updated=await api.pinChatMessage(chatId,message.id,!message.pinned_at);
      if(scopeRef.current.selected===chatId&&scopeRef.current.workspaceId===orgId){setMessages(old=>old.map(row=>row.id===updated.id?updated:row));setPinVersion(value=>value+1);}
    }catch(e){setError(e instanceof Error?e.message:'Could not change pin');}
    finally{setWorking(false);}
  }

  async function changeChatPreference(key:'is_muted'|'is_pinned'){
    if(!active||working)return;setWorking(true);setError('');
    try{const result=await api.chatPreferences(active.id,{[key]:!active[key]});setThreads(old=>old.map(row=>row.id===active.id?{...row,...result}:row));onReadRef.current?.();}
    catch(e){setError(e instanceof Error?e.message:'Could not update settings');}finally{setWorking(false);}
  }

  async function archiveActiveChat(){
    if(!active||working)return;
    const archived=!active.archived_at;
    setWorking(true);setError('');
    try{const result=await api.archiveChat(active.id,archived);setThreads(old=>old.map(row=>row.id===active.id?{...row,archived_at:result.archived_at}:row));setShowArchived(archived);}
    catch(e){setError(e instanceof Error?e.message:'Could not change archive status');}
    finally{setWorking(false);}
  }

  async function renameGroup(){
    if(!selected||!active||working)return;
    const title=window.prompt('Group name',active.title)?.trim();
    if(!title||title===active.title)return;
    setWorking(true);setError('');
    try{await api.renameGroup(selected,title);await loadThreads();}
    catch(e){setError(e instanceof Error?e.message:'Could not rename group');}
    finally{setWorking(false);}
  }

  async function transferOwnership(user: Person) {
    if (!selected || working || !window.confirm(`Transfer group ownership to ${user.full_name}?`)) return;
    setWorking(true); setError('');
    try {
      await api.transferGroupOwnership(selected, user.id);
      setManagingGroup(false);
      await loadThreads();
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not transfer ownership'); }
    finally { setWorking(false); }
  }

  async function leaveGroup() {
    if (!selected || working || !window.confirm('Leave this group? You will lose access to its messages and attachments.')) return;
    setWorking(true); setError('');
    try {
      await api.leaveGroup(selected);
      setThreads(old => old.filter(thread => thread.id !== selected));
      setMessages([]); setSelected(null); setManagingGroup(false); writeDraft(selected,'');
      await loadThreads();
      onReadRef.current?.();
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not leave group'); }
    finally { setWorking(false); }
  }

  async function openEmployeeChat(email:string) {
    if(working)return;setWorking(true);setError('');
    const org=workspaceId;
    try{const thread=await api.startDirectChat(email);if(scopeRef.current.workspaceId!==org)return;await loadThreads();setShowArchived(false);setThreadKind('all');setFilter('');setListView('messages');setSelected(thread.id);}
    catch(e){if(scopeRef.current.workspaceId===org)setError(e instanceof Error?e.message:'Could not open employee chat');}
    finally{setWorking(false);}
  }

  async function deleteGroup() {
    if(!active||!active.can_delete||working||!window.confirm(`Delete project group "${active.title}" for all participants? Messages and attachments will be permanently removed.`))return;
    const id=active.id,org=workspaceId;setWorking(true);setError('');
    try{await api.deleteProjectGroup(id);if(scopeRef.current.workspaceId!==org)return;setSelected(null);setMessages([]);setManagingGroup(false);writeDraft(id,'');setThreads(rows=>rows.filter(row=>row.id!==id));await loadThreads();onReadRef.current?.();}
    catch(e){if(scopeRef.current.workspaceId===org)setError(e instanceof Error?e.message:'Could not delete group');}finally{setWorking(false);}
  }

  return <section className={`private-chat-page simple-chats${active?' has-chat':''}`}>
    {editingOwnProfile&&onProfileSaved&&<ProfileEditor user={currentUser} onSaved={onProfileSaved} onClose={()=>setEditingOwnProfile(false)}/>}
    {notice&&<div className="chat-copy-notice" role="status">{notice}</div>}
    {selected&&forwardTarget&&<ForwardMessageDialog key={selected+forwardTarget.id} kind="chat" sourceId={selected} message={forwardTarget} onClose={()=>setForwardId(null)} onSent={result=>{if(result.kind==='chat'&&result.destination_id===selected&&'reactions' in result.message){const sent=result.message;setMessages(old=>old.some(row=>row.id===sent.id)?old:[...old,sent].sort(messageOrder));}void loadThreads();}}/>}
    <div className="private-chat-heading">
      <div><h1>Chats &amp; Groups</h1><p>Conversations and project work, in one place.</p></div>
      {section==='chats'&&<div className="org-chat-heading-actions">{directory?.can_create_groups&&<button className="outline-button" type="button" aria-label="Create project group" onClick={()=>setMode('group')}><Users size={16}/><span>New group</span></button>}<button className="primary-button" type="button" onClick={() => setMode('direct')}><Plus size={17}/> New chat</button></div>}
    </div>
    <div className="org-chat-section-switch" role="group" aria-label="Chats and groups sections">
      <button className="outline-button" type="button" aria-pressed={section==='chats'} onClick={()=>setSection('chats')}><MessageCircle size={16}/>Chats &amp; Groups</button>
      <button className="outline-button" type="button" aria-pressed={section==='tasks'} onClick={()=>setSection('tasks')}><CheckSquare size={16}/>Tasks</button>
    </div>
    {error && <div className="chat-alert" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
    {section==='tasks'?<div className="org-chat-tasks"><TasksPanel key={workspaceId||'none'} workspaceId={workspaceId}/></div>:<div className="private-chat-layout">
      <aside className="private-chat-list">
        <div className="chat-list-tabs" role="group" aria-label="Browse chats"><button type="button" aria-pressed={listView==='messages'} onClick={()=>setListView('messages')}><MessageCircle size={16}/>Messages</button><button type="button" aria-pressed={listView==='people'} onClick={()=>setListView('people')}><Users size={16}/>People</button></div>
        <div className="chat-people-pane" hidden={listView!=='people'}>
          <p className="chat-people-help">Choose a department, then a team to find a colleague.</p>
          <button type="button" className="icon-button chat-directory-refresh" aria-label="Refresh people" title="Refresh people" onClick={()=>void loadDirectory()}><RefreshCw size={15}/></button>
          <ChatDirectory data={directory} loading={directoryLoading} currentUserId={currentUser.id} busy={working} onReload={()=>void loadDirectory()} onStartChat={email=>void openEmployeeChat(email)}/>
        </div>
        <div className="chat-messages-pane" hidden={listView!=='messages'}>
        <div className="chat-list-controls">
        <div className="private-chat-list-heading"><strong>{showArchived?'Archived conversations':'Conversations'}</strong><button type="button" className="icon-button" aria-label="Refresh chats" title="Refresh chats" onClick={() => void loadThreads()}><RefreshCw size={16}/></button></div>
        <div className="chat-search-field"><Search size={16} aria-hidden="true"/><input className="chat-filter" aria-label="Search conversations" placeholder="Search by name" value={filter} onChange={e => setFilter(e.target.value)}/>{filter&&<button type="button" className="icon-button" aria-label="Clear conversation search" onClick={()=>setFilter('')}><X size={14}/></button>}</div>
        <div className="org-chat-kind-filter" role="group" aria-label="Conversation type">{([['all','All'],['direct','Chats'],['group','Groups']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={threadKind===value} onClick={()=>setThreadKind(value)}>{label}</button>)}</div>
        </div>
        <div className="chat-thread-scroll">
        {visibleThreads.map(thread => <button type="button" key={thread.id} aria-current={selected===thread.id?'true':undefined} className={`chat-thread ${selected === thread.id ? 'selected' : ''}${thread.unread_count>0?' has-unread':''}`} onClick={() => setSelected(thread.id)}>
          <span className={`chat-thread-avatar${thread.kind==='group'?' is-group':''}`}>{thread.kind === 'group' ? <Users size={18}/> : <ChatAvatar person={thread.participants.find(p=>p.user.id!==currentUser.id)?.user}/>}</span>
          <span className="chat-thread-details"><strong>{titleFor(thread,currentUser.id)}</strong><small>{thread.kind === 'group' ? `${thread.participants.length} members` : presenceLabel(presence[thread.participants.find(p=>p.user.id!==currentUser.id)?.user.id||''])}</small></span>
          <span className="chat-thread-indicators">{thread.is_pinned&&<Pin size={13} aria-label="Pinned chat"/>}{thread.is_muted&&<BellOff size={13} aria-label="Muted chat"/>}
          {thread.unread_count>0&&<span className="chat-unread-badge" aria-label={`${thread.unread_count} unread messages`}>{thread.unread_count>99?'99+':thread.unread_count}</span>}
          </span>
        </button>)}
        {threadsLoading&&threads.length===0?<div className="chat-list-empty" role="status">Loading conversations…</div>:visibleThreads.length===0&&<div className="chat-list-empty"><MessageCircle size={24}/><strong>{filter?'No matching conversations':showArchived?'No archived conversations':threadKind==='group'?'No groups yet':'No conversations yet'}</strong><p>{filter?'Try a different name or clear your search.':showArchived?'Conversations you archive will appear here.':threadKind==='group'?'Project groups you join will appear here.':'Start a new chat or find a colleague in People.'}</p></div>}
        </div>
        <button type="button" className="chat-archive-toggle" aria-pressed={showArchived} onClick={()=>setShowArchived(value=>!value)}>{showArchived?<ArrowLeft size={16}/>:<Archive size={16}/>}<span>{showArchived?'Back to active chats':'Archived chats'}</span><span className="chat-archive-count">{threads.filter(thread=>Boolean(thread.archived_at)).length}</span></button>
        </div>
      </aside>
      <div className="private-chat-conversation">
        {active ? <>
          <header className="private-chat-toolbar">
            <button type="button" className="icon-button chat-back-button" aria-label="Back to conversations" onClick={()=>setSelected(null)}><ArrowLeft size={20}/></button>
            <span className="chat-thread-avatar large">{active.kind === 'group' ? <Users size={19}/> : <ChatAvatar person={active.participants.find(p=>p.user.id===peerId)?.user}/>}</span>
            <div className="chat-conversation-title"><button type="button" className="chat-title-button" aria-label={active.kind==='group'?'Open group info':'Open contact info'} onClick={()=>setDetails('info')}><h2>{titleFor(active,currentUser.id)}</h2></button>{active.kind==='direct'?<PresenceStatus row={presence[peerId||'']}/>:<p>{active.participants.length} participants · {onlineCount} online</p>}</div>
            <div className="chat-toolbar-actions">
              {callsEnabled&&<ChatCallControls key={'calls:'+selected} chat={active} userId={currentUser.id} onActivity={onRead}/>}
              <button type="button" className="conversation-icon-button chat-search-button" aria-label="Search in conversation" title="Search in conversation" onClick={()=>setDetails('search')}><Search size={17}/></button>
              {active.kind==='group'&&active.created_by.id===currentUser.id&&<button type="button" className="conversation-icon-button chat-manage-button" aria-label="Manage group" title="Manage group" disabled={working} onClick={()=>setManagingGroup(true)}><Users size={17}/></button>}
              <PinnedMessages key={'chat-pins:'+selected} kind="chat" id={selected!} compact version={pinVersion} onUnpin={updated=>{if('reactions' in updated){setMessages(old=>old.map(row=>row.id===updated.id?updated as ChatMessage:row));setPinVersion(value=>value+1);}}}/>
              <ChatOptionsMenu key={selected} busy={working} items={[
                {label:active.kind==='group'?'Group info':'Contact info',icon:Info,onSelect:()=>setDetails('info')},
                {label:'Search in conversation',icon:Search,onSelect:()=>setDetails('search')},
                {label:'Shared media and files',icon:FileText,onSelect:()=>setDetails('media')},
                ...(onProfileSaved?[{label:'Edit my profile',icon:Pencil,onSelect:()=>setEditingOwnProfile(true)}]:[]),
                {label:active.is_pinned?'Unpin chat':'Pin chat',icon:active.is_pinned?PinOff:Pin,onSelect:()=>void changeChatPreference('is_pinned')},
                {label:active.is_muted?'Unmute':'Mute',icon:active.is_muted?Bell:BellOff,onSelect:()=>void changeChatPreference('is_muted')},
                {label:active.archived_at?'Restore chat':'Archive chat',icon:active.archived_at?ArchiveRestore:Archive,onSelect:()=>void archiveActiveChat()},
                ...(active.kind==='group'&&active.created_by.id!==currentUser.id?[{label:'Leave group',icon:LogOut,onSelect:()=>void leaveGroup()}]:[]),
                ...(active.kind==='group'&&active.can_delete?[{label:'Delete group',icon:Trash2,danger:true,onSelect:()=>void deleteGroup()}]:[]),
              ]}/>
              <span className={`chat-connected ${connected ? 'yes' : ''}`} title={connected ? 'Live updates connected' : 'Messages saved; live updates unavailable'}/>
            </div>
          </header>
          {requestedChat?.id===selected&&requestedChat.messageId&&jumpClosed!==requestedChat.nonce&&<MessageContext key={'chat-context:'+requestedChat.nonce} kind="chat" id={selected!} messageId={requestedChat.messageId} version={pinVersion} onClose={()=>setJumpClosed(requestedChat.nonce)}/>}
          {searchJump&&<MessageContext key={'search-jump:'+selected+':'+searchJump.nonce} kind="chat" id={selected!} messageId={searchJump.id} version={pinVersion} onClose={()=>setSearchJump(null)}/>}
          <div className="private-chat-history" ref={historyRef}>
            {historyCursor && <div style={{textAlign:"center",padding:"8px"}}><button type="button" className="outline-button" disabled={loadingOlder} onClick={()=>void loadOlder()}>{loadingOlder?"Loading…":"Load older messages"}</button></div>}
            {messages.length === 0 && <div className="private-chat-welcome"><MessageCircle size={30}/><h3>Start the conversation</h3><p>Only participants in this workspace can read these messages.</p></div>}
            {messages.map((message,index) => <div key={message.id} className="chat-timeline-entry">{(index===0||new Date(messages[index-1].created_at).toDateString()!==new Date(message.created_at).toDateString())&&<div className="chat-day-label"><span>{dayLabel(message.created_at)}</span></div>}<div className={`private-message ${message.sender.id===currentUser.id ? 'mine' : ''}${message.attachment&&!message.deleted_at?' has-file':''}`}>
              <div className="private-message-meta"><strong>{message.sender.full_name}</strong><time>{timeFor(message.created_at)}</time>
                {!message.deleted_at&&editingId!==message.id&&<MessageActions busy={working} pinned={Boolean(message.pinned_at)}
                onReply={()=>setReplyTo({chatId:selected!,messageId:message.id})} onForward={()=>setForwardId(message.id)} onCopy={()=>{if(!navigator.clipboard){setError('Clipboard access is unavailable in this browser.');return;}void navigator.clipboard.writeText(message.body).then(()=>setNotice('Message copied')).catch(()=>setError('Could not copy the message.'));}}
                onPin={()=>void pinMessage(message)}
                onEdit={message.sender.id===currentUser.id?()=>{setEditingId(message.id);setEditDraft(message.body);}:undefined}
                onDelete={message.sender.id===currentUser.id?()=>void deleteMessage(message):undefined}/>}
              </div>
              {!message.deleted_at&&message.pinned_at&&<div className="forwarded-label">Pinned</div>}
              {!message.deleted_at&&message.is_forwarded&&<div className="forwarded-label">Forwarded</div>}
              {!message.deleted_at&&message.reply_to_id&&<ReplyPreview message={messages.find(row=>row.id===message.reply_to_id)}/>}
              {editingId===message.id ? <form className="message-edit-form" onSubmit={e => void editMessage(e,message.id)}>
                <input autoFocus aria-label="Edit message" maxLength={4000} value={editDraft} onChange={e => setEditDraft(e.target.value)}/>
                <div><button type="button" onClick={() => setEditingId(null)} disabled={working}>Cancel</button><button type="submit" disabled={working || !editDraft.trim()}>Save</button></div>
              </form> : <div className={`private-message-body ${message.deleted_at ? 'deleted' : ''}`}>{message.deleted_at?'Message deleted':message.attachment?<><ChatFileMessage file={message.attachment}/>{message.body!==message.attachment.name&&<div className="chat-file-caption">{message.body}</div>}</>:message.body}{!message.deleted_at && message.edited_at && <small className="edited-note"> (edited)</small>}</div>}
              {message.sender.id===currentUser.id && <div className="chat-read-receipt">{
                active.participants.some(p=>p.user.id!==currentUser.id && p.last_read_at && new Date(p.last_read_at).getTime()>=new Date(message.created_at).getTime())
                  ? <span className="chat-read-ticks seen" aria-label={active.kind==='direct'?'Seen':`Seen by ${active.participants.filter(p=>p.user.id!==currentUser.id&&p.last_read_at&&new Date(p.last_read_at).getTime()>=new Date(message.created_at).getTime()).length}`} title="Read"><CheckCheck size={16}/></span>
                  : <span className="chat-read-ticks" aria-label="Sent" title="Sent"><Check size={15}/></span>
              }</div>}
              <ChatReactionBar key={'reactions:'+message.id} chatId={selected!} message={message} currentUserId={currentUser.id} participants={active.participants.map(p=>p.user)}
                onUpdated={updated=>setMessages(current=>current.map(item=>item.id===updated.id?updated:item))}/>
            </div></div>)}
            <div ref={bottomRef}/>
          </div>
          {Object.keys(typingUsers).length>0&&<div className="chat-typing-indicator" aria-live="polite">{Object.values(typingUsers).join(', ')} {Object.keys(typingUsers).length>1?'are':'is'} typing…</div>}
          {replyTarget&&<div className="chat-reply-compose"><ReplyPreview message={replyTarget} onCancel={()=>setReplyTo(null)}/></div>}
          <ChatComposer key={'composer:'+workspaceId+':'+selected} draft={draft} onDraft={changeDraft} onBlur={()=>emitTyping(false)} people={active.participants.map(p=>p.user).filter(user=>user.id!==currentUser.id)} busy={working} onSendText={send} onSendFile={sendAttachment}/>
          {details&&<ChatDetails key={selected+':'+details} chat={active} mode={details} currentUserId={currentUser.id} onClose={()=>setDetails(null)} onOpenMessage={id=>{setJumpClosed(requestedChat?.nonce??null);setSearchJump({id,nonce:Date.now()});setDetails(null);}}/>}
        </> : <div className="private-chat-welcome"><MessageCircle size={32}/><h3>Select a conversation</h3><p>Choose a chat or group from the list to start messaging.</p></div>}
      </div>
    </div>
    }
    {managingGroup && active?.kind==='group' && active.created_by.id===currentUser.id && <div className="modal-backdrop" onMouseDown={e => {if (e.target===e.currentTarget) setManagingGroup(false);}}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Manage group participants">
        <div className="modal-head"><div><div className="eyebrow">GROUP CHAT</div><h2>Manage group</h2></div><button className="icon-button" onClick={() => setManagingGroup(false)} aria-label="Close"><X size={19}/></button></div>
        <div className="modal-body">
          <p className="muted">New participants see messages from the time they join, not earlier chat history. Transfer ownership before leaving this group.</p>
          <button type="button" className="outline-button" disabled={working} onClick={()=>void renameGroup()}>Rename group</button>
          <div className="member-list">{active.participants.map(p => <div className="member-row" key={p.user.id}><div className="avatar small-avatar">{initials(p.user.full_name)}</div><div><strong>{p.user.full_name}</strong><small>{p.user.email}</small><PresenceStatus row={presence[p.user.id]}/></div>{p.user.id===active.created_by.id ? <span className="role-pill">Owner</span> : <div><button type="button" className="member-remove" disabled={working} onClick={() => void transferOwnership(p.user)}>Transfer ownership</button><button type="button" className="member-remove" disabled={working} onClick={() => void removeParticipant(p.user)}>Remove</button></div>}</div>)}</div>
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
            <div className="group-people-picker" role="group" aria-label="Select teammates">{colleagues.map(m => <label key={m.id} className={'group-person-row'+(groupEmails.includes(m.user.email)?' selected':'')}><input type="checkbox" aria-label={m.user.full_name+' ('+m.user.email+')'} checked={groupEmails.includes(m.user.email)} onChange={e => setGroupEmails(old => e.target.checked ? [...old,m.user.email] : old.filter(email => email!==m.user.email))}/><span className="group-person-avatar" aria-hidden="true">{initials(m.user.full_name)}</span><span className="group-person-details"><strong>{m.user.full_name}</strong><small>{m.user.email}</small></span></label>)}</div>
          </>}
          {colleagues.length===0&&<p className="muted">Invite employees to your company before starting chats.</p>}
          <div className="modal-actions"><button type="button" className="outline-button" onClick={() => setMode(null)}>Cancel</button><button className="primary-button" disabled={working || (mode==='direct' ? !directEmail : !groupTitle.trim()||groupEmails.length<2)}>Create <ArrowRight size={16}/></button></div>
        </form>
      </div>
    </div>}
  </section>;
}

