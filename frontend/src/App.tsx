import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Hash, Inbox, MessageCircle,
  LayoutGrid, LockKeyhole, LogOut, Mail, Menu, Plus, Send,
  Settings2, Sparkles, Users, Video, X, CalendarDays, FolderOpen, Search } from 'lucide-react';
import { api, csrf, type Channel, type ChannelMessageCursor, type ChannelNotice, type Member, type Message, type Person, type Session, type Team } from './api';
import ChatPanel from './ChatPanel';
import {connectConversationSocket,mergeFreshHistory} from './conversationSocket';
import {ApiError} from './api';
import {useWorkspacePresence,PresenceStatus} from './WorkspacePresence';
import MeetingsPanel, {ChannelMeetingCards} from './MeetingsPanel';
import ChannelMessageItem from './ChannelMessageItem';
import ReplyPreview from './ReplyPreview';
import PinnedMessages from './PinnedMessages';
import ForwardMessageDialog from './ForwardMessageDialog';
import AttachmentPanel from './AttachmentPanel';
import MentionInput from './MentionInput';
import EmailPanel from './EmailPanel';
import MessageSearchPanel from './MessageSearchPanel';
import MessageContext from './MessageContext';
import ChatNotificationBell from './ChatNotificationBell';
import SettingsPanel from './SettingsPanel';
import AccountRecoveryScreen from './AccountRecoveryScreen';
import SharedFilesPanel from './SharedFilesPanel';

function initials(name: string) { return name.split(' ').filter(Boolean).slice(0, 2).map(t => t[0].toUpperCase()).join('') || 'TW'; }
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong'; }
function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand-mark"><LayoutGrid size={19} strokeWidth={2.6}/></span>{!compact && <span>team<span className="brand-accent">workspace</span></span>}</div>;
}
function Spinner() { return <div className="spin" aria-label="Loading"/>; }
function ErrorBanner({ message, onClose }: {message:string;onClose?:()=>void}) {
  return <div className="error-banner" role="alert">{message}{onClose && <button className="icon-button" onClick={onClose} aria-label="Dismiss"><X size={15}/></button>}</div>;
}
function Empty({ icon, title, description, action }: {icon:ReactNode;title:string;description:string;action?:ReactNode}) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

type AuthMode = 'login' | 'register';
function AuthScreen({ onAuth }: {onAuth:(session:Session)=>void}) {
  const [mode,setMode] = useState<AuthMode>('register');
  const [email,setEmail] = useState(''); const [password,setPassword] = useState('');
  const [fullName,setFullName] = useState(''); const [orgName,setOrgName] = useState('');
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  async function submit(e:FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const session = mode === 'login' ? await api.login(email,password) : await api.register({email,password,full_name:fullName,organization_name:orgName});
      onAuth(session);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-aside"><Brand/><div className="aside-copy">
    <div className="eyebrow light"><span className="little-star">✳</span> BUILT FOR BETTER TEAMWORK</div>
    <h1>One place.<br/>Every conversation.<br/><em>More possibilities.</em></h1>
    <p>Bring your people, projects and ideas together in a workspace designed to help everyone do their best work.</p>
    <div className="testimonial"><span className="testimonial-icon">“</span><p>Less time switching between apps. More time making things happen.</p><span>YOUR TEAM, CONNECTED</span></div>
  </div><div className="aside-foot"><span className="status-dot"/> Secure workspaces for every organization</div></section>
  <section className="auth-main"><div className="auth-top">Already have an account? <button className="text-link" onClick={()=>{setMode(mode==='login'?'register':'login');setError('');}}>{mode==='login'?'Create workspace':'Sign in'} <ArrowRight size={15}/></button></div>
    <form className="auth-card" onSubmit={submit}><div className="mini-mark"><LayoutGrid size={23}/></div>
      <div className="eyebrow">{mode==='register'?'GET STARTED — IT’S FREE':'WELCOME BACK'}</div>
      <h2>{mode==='register'?'Create your workspace':'Sign in to your workspace'}</h2>
      <p className="muted auth-subtitle">{mode==='register'?'A better way for your team to work together starts here.':'Everything your team needs, right where you left it.'}</p>
      {error && <ErrorBanner message={error}/>}
      {mode==='register' && <><label>Full name<input required maxLength={150} value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Your full name"/></label><label>Organization name<input required maxLength={140} value={orgName} onChange={e=>setOrgName(e.target.value)} placeholder="e.g. Acme Studio"/></label></>}
      <label>Work email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com"/></label>
      <label>Password<input type="password" autoComplete={mode==='login'?'current-password':'new-password'} minLength={mode==='register'?10:undefined} required value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='register'?'At least 10 characters':'Enter your password'}/></label>
      {mode==='login'&&<div className="forgot-password-link"><a href="/forgot-password">Forgot password?</a></div>}
      <button type="submit" className="primary-button wide" disabled={busy}>{busy?<Spinner/>:mode==='register'?'Create workspace':'Sign in'} <ArrowRight size={17}/></button>
      <div className="auth-note"><LockKeyhole size={14}/> Your workspace data stays separate and protected.</div>
      <p className="auth-switch">{mode==='register'?'Have an account already?':'New to TeamWorkspace?'} <button type="button" className="text-link" onClick={()=>{setMode(mode==='login'?'register':'login');setError('');}}>{mode==='register'?'Sign in':'Create a workspace'}</button></p>
    </form><div className="auth-footer">© 2026 TeamWorkspace · Account security preview</div>
  </section></main>;
}

function InviteScreen({ session, onDone, onBack }: {session:Session|null;onDone:(session:Session)=>void;onBack:()=>void}) {
  const token = new URLSearchParams(location.search).get('token') || '';
  const [invite,setInvite] = useState<{organization_name:string;email:string;role:string}|null>(null);
  const [name,setName] = useState(''); const [password,setPassword] = useState('');
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  useEffect(()=>{ api.previewInvite(token).then(setInvite).catch(e=>setError(errorText(e))); },[token]);
  async function accept(e:FormEvent) { e.preventDefault();setBusy(true);setError(''); try {
    const result=await api.acceptInvite(token,name,password);
    history.replaceState({},'', '/'); onDone(result);
  } catch(e) {setError(errorText(e));} finally {setBusy(false);} }
  return <div className="invite-shell"><div className="invite-card"><Brand/><button className="back-link" onClick={onBack}><ArrowLeft size={16}/> Back to workspace</button><div className="mini-mark"><Mail/></div><h2>You're invited!</h2>
  {error && <ErrorBanner message={error}/>}
  {invite && <><p className="muted">Join <strong>{invite.organization_name}</strong> as a {invite.role}.</p><div className="detail-line"><Mail size={17}/>{invite.email}</div>
  <form onSubmit={accept}>{!session && <><label>Your name<input required value={name} onChange={e=>setName(e.target.value)}/></label><label>Create password<input type="password" minLength={10} autoComplete="new-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label></>}
  {session && <p className="muted small">You are signed in as {session.user.email}. The invitation must match your account email.</p>}
  <button className="primary-button wide" disabled={busy}>{busy?<Spinner/>:'Accept invitation'} <ArrowRight size={16}/></button></form></>}
  </div></div>;
}

const navItems = [
  {id:'teams', label:'Teams & Channels', icon:Users, ready:true},
  {id:'chats', label:'Chats & Groups', icon:MessageCircle, ready:true},
  {id:'search', label:'Search messages', icon:Search, ready:true},
  {id:'inbox', label:'Email inbox', icon:Mail, ready:true},
  {id:'meetings', label:'Meetings', icon:Video, ready:true},
  {id:'calendar', label:'Calendar', icon:CalendarDays, ready:true},
  {id:'files', label:'Shared files', icon:FolderOpen, ready:true},
];
function Workspace({ session, onSession, onLogout }: {session:Session;onSession:(value:Session)=>void;onLogout:()=>void}) {
  const presence=useWorkspacePresence(session.active_organization_id);
  const [view,setView] = useState(new URLSearchParams(location.search).has('meeting')?'meetings':new URLSearchParams(location.search).has('mail')?'inbox':'teams'); const [teams,setTeams] = useState<Team[]>([]);
  const [openChatRequest,setOpenChatRequest] = useState<{id:string;nonce:number;messageId?:string}|null>(null);
  const [channelJump,setChannelJump]=useState<{id:string;messageId:string;nonce:number}|null>(null);
  const [notificationRefresh,setNotificationRefresh] = useState(0);
  const [openMeetingRequest,setOpenMeetingRequest] = useState<{id:string;nonce:number}|null>(()=>{const id=new URLSearchParams(location.search).get('meeting');return id?{id,nonce:Date.now()}:null;});
  const [channelNotices,setChannelNotices] = useState<ChannelNotice[]>([]);
  const currentOrgRef = useRef(session.active_organization_id);
  currentOrgRef.current = session.active_organization_id;
  const lastChannelReadRef = useRef<string|null>(null);
  const [loadedChannelId,setLoadedChannelId] = useState<string|null>(null);
  const [channelCursor,setChannelCursor] = useState<ChannelMessageCursor|null>(null);
  const [channelHasMore,setChannelHasMore] = useState(false);
  const [channelLoadingOlder,setChannelLoadingOlder] = useState(false);
  const olderRequestRef = useRef(false);
  const channelHistoryGeneration=useRef(0);
  const channelScrollRef = useRef<HTMLDivElement>(null);
  const channelScrollAnchorRef = useRef<{height:number;top:number}|null>(null);
  const channelAutoScrollRef = useRef(true);
  const [selectedTeam,setSelectedTeam] = useState<string|null>(null);
  const [channels,setChannels] = useState<Channel[]>([]);const [selectedChannel,setSelectedChannel] = useState<string|null>(null);
  const [pinVersion,setPinVersion]=useState(0);
  const [messages,setMessages] = useState<Message[]>([]); const [members,setMembers] = useState<Member[]>([]);
  const [newTeam,setNewTeam] = useState(''); const [newChannel,setNewChannel] = useState('');
  const [inviteEmail,setInviteEmail] = useState('');const [inviteRole,setInviteRole] = useState('member');
  const [teamMemberEmail,setTeamMemberEmail] = useState('');
  const [inviteResult,setInviteResult] = useState('');
  const [memberBusyId,setMemberBusyId] = useState<string|null>(null);
  const [forwardId,setForwardId]=useState<string|null>(null);
  const forwardTarget=messages.find(row=>row.id===forwardId);
  const [replyTo,setReplyTo] = useState<{channelId:string;messageId:string}|null>(null);
  const replyTarget=replyTo?.channelId===selectedChannel?messages.find(row=>row.id===replyTo.messageId&&!row.deleted_at):undefined;
  const [draft,setDraft] = useState(''); const [pending,setPending] = useState(false);
  const [teamMentionPeople,setTeamMentionPeople] = useState<Person[]>([]);
  const [teamRoster,setTeamRoster] = useState<Array<{user:Person;role:string}>>([]);
  const myTeamRole=teamRoster.find(row=>row.user.id===session.user.id)?.role;
  const [error,setError] = useState('');const [modal,setModal] = useState<null|'team'|'channel'|'invite'|'members'>(null);
  const [sidebarOpen,setSidebarOpen] = useState(false);const [connected,setConnected] = useState(false);

  const selectedTeamRef=useRef(selectedTeam);selectedTeamRef.current=selectedTeam;
  const selectedChannelRef = useRef(selectedChannel);
  selectedChannelRef.current = selectedChannel;
  const activeOrg = session.organizations.find(o=>o.id===session.active_organization_id);
  const activeTeam = teams.find(t=>t.id===selectedTeam);
  const activeChannel = channels.find(c=>c.id===selectedChannel);
  const channelReadOnly=Boolean(activeTeam?.archived_at||activeChannel?.archived_at);
  const canInvite = activeOrg?.role === 'owner' || activeOrg?.role === 'admin';
  const channelPreference=channelNotices.find(n=>n.channel_id===selectedChannel);
  function changeChannelPreference(key:'is_muted'|'is_pinned'){
    if(!selectedChannel)return;const id=selectedChannel;void action(async()=>{await api.channelPreferences(id,{[key]:!channelPreference?.[key]});await loadChannelNotices();setNotificationRefresh(v=>v+1);},false);
  }
  const channelUnread = (id:string) => channelNotices.find(n=>n.channel_id===id)?.unread_count || 0;
  const loadChannelNotices = useCallback(async()=>{
    const organizationId = session.active_organization_id;
    if(!organizationId){setChannelNotices([]);return;}
    try{
      const rows=await api.channelNotifications();
      if(currentOrgRef.current===organizationId)setChannelNotices(rows);
    }catch{/* Retain the last safe count until the next refresh. */}
  },[session.active_organization_id]);

  useEffect(()=>{
    setChannelNotices([]);
    void loadChannelNotices();
    const timer=window.setInterval(()=>{void loadChannelNotices();},20000);
    const focus=()=>{void loadChannelNotices();};
    window.addEventListener('focus',focus);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',focus);};
  },[loadChannelNotices]);

  const loadTeams = useCallback(async()=>{
    const orgId=currentOrgRef.current;
    try{
      const rows=await api.teams();
      if(currentOrgRef.current!==orgId)return;
      const current=selectedTeamRef.current;
      if(current&&!rows.some(t=>t.id===current)){
        setChannels([]);setSelectedChannel(null);setMessages([]);setLoadedChannelId(null);
        setReplyTo(null);setForwardId(null);setDraft('');setModal(null);
      }
      setTeams(rows);setSelectedTeam(old=>old&&rows.some(t=>t.id===old)?old:(rows[0]?.id||null));
    }catch(e){if(currentOrgRef.current===orgId)setError(errorText(e));}
  },[]);
  useEffect(()=>{setTeams([]);setChannels([]);setMembers([]);setSelectedTeam(null);setSelectedChannel(null);setMessages([]);loadTeams();if(session.active_organization_id)api.members(session.active_organization_id).then(setMembers).catch(()=>{});},[session.active_organization_id,loadTeams]);
  useEffect(()=>{
    setTeamMentionPeople([]);setTeamRoster([]);
    if(!selectedTeam)return;
    let valid=true;
    api.teamMembers(selectedTeam).then(rows=>{
      if(valid){setTeamMentionPeople(rows.map(row=>row.user));setTeamRoster(rows);}
    }).catch(()=>{});
    return()=>{valid=false;};
  },[selectedTeam,session.active_organization_id]);
  useEffect(()=>{if(!selectedTeam){setChannels([]);setSelectedChannel(null);return;}let valid=true;api.channels(selectedTeam).then(rows=>{if(!valid)return;setChannels(rows);setSelectedChannel(current=>current&&rows.some(c=>c.id===current)?current:rows[0]?.id||null);}).catch(e=>valid&&setError(errorText(e)));return()=>{valid=false;};},[selectedTeam]);
  useEffect(()=>{
    channelAutoScrollRef.current=true;channelScrollAnchorRef.current=null;
    channelHistoryGeneration.current++;olderRequestRef.current=false;
    setChannelCursor(null);setChannelHasMore(false);setChannelLoadingOlder(false);
    setMessages([]);setLoadedChannelId(null);setConnected(false);
    if(!selectedChannel)return;
    const channelId=selectedChannel;
    let valid=true,revision=0,syncing=false,stopSocket=()=>{};
    const live=new Map<string,Message>();
    function denied(){
      if(!valid)return;valid=false;revision++;channelHistoryGeneration.current++;
      stopSocket();setConnected(false);setMessages([]);setLoadedChannelId(null);
      setSelectedChannel(null);setChannels([]);setReplyTo(null);setForwardId(null);setDraft('');
      void loadTeams();void loadChannelNotices();
    }
    async function refresh(){
      const run=++revision;syncing=true;live.clear();
      channelHistoryGeneration.current++;olderRequestRef.current=false;
      setChannelLoadingOlder(false);channelScrollAnchorRef.current=null;setChannelHasMore(false);
      try{
        const page=await api.channelMessagePage(channelId);
        if(!valid||run!==revision)return;
        setMessages(mergeFreshHistory(page.items,live));setChannelCursor(page.next_cursor);
        setChannelHasMore(page.has_more);setLoadedChannelId(channelId);setPinVersion(v=>v+1);
      }catch(e){
        if(!valid||run!==revision)return;
        if(e instanceof ApiError&&[401,403,404].includes(e.status)){denied();return;}
        setError(errorText(e));
      }finally{if(valid&&run===revision){syncing=false;live.clear();}}
    }
    stopSocket=connectConversationSocket(`/ws/channels/${channelId}/`,{
      onAttempt:()=>{void refresh();},
      onOpen:()=>{if(valid){setConnected(true);void refresh();void loadChannelNotices();}},
      onDisconnected:()=>{if(valid)setConnected(false);},
      onDenied:denied,
      onMessage:event=>{try{
        if(!valid)return;
        const payload=JSON.parse(event.data) as {type:string;message:Message};
        if(payload.type==='team_membership_changed'){const teamId=selectedTeamRef.current;if(teamId)void api.teamMembers(teamId).then(rows=>{if(valid&&selectedTeamRef.current===teamId){setTeamRoster(rows);setTeamMentionPeople(rows.map(row=>row.user));}}).catch(()=>{});return;}
        if(!payload.message)return;
        if(syncing&&['message','message.updated','message.deleted'].includes(payload.type))live.set(payload.message.id,payload.message);
        if(payload.type==='message')setMessages(old=>old.some(m=>m.id===payload.message.id)?old:mergeFreshHistory(old,new Map([[payload.message.id,payload.message]])));
        else if(payload.type==='message.updated'||payload.type==='message.deleted'){setMessages(old=>old.map(row=>row.id===payload.message.id?payload.message:row));setPinVersion(value=>value+1);}
      }catch{/* Ignore malformed events. */}},
    });
    // REST history remains available even when the network/socket is initially offline.
    if(!navigator.onLine)void refresh();
    return()=>{valid=false;revision++;channelHistoryGeneration.current++;stopSocket();};
  },[selectedChannel,session.active_organization_id,loadTeams,loadChannelNotices]);
  useLayoutEffect(()=>{
    const area=channelScrollRef.current;
    if(!area)return;
    const anchor=channelScrollAnchorRef.current;
    if(anchor){
      channelScrollAnchorRef.current=null;
      area.scrollTop=anchor.top+(area.scrollHeight-anchor.height);
    }else if(channelAutoScrollRef.current){
      area.scrollTop=area.scrollHeight;
    }
  },[messages.length,selectedChannel]);

  const latestChannelMessage = messages[messages.length-1];
  const latestChannelMessageId = latestChannelMessage?.id;
  const currentChannelNotice = channelNotices.find(n=>n.channel_id===selectedChannel);
  const currentChannelJoinDate = currentChannelNotice?.joined_at;
  const markVisibleChannelRead=useCallback(()=>{
    if(view!=='teams'||!selectedChannel||loadedChannelId!==selectedChannel||
       !latestChannelMessageId||!latestChannelMessage||!currentChannelJoinDate||
       document.visibilityState!=='visible')return;
    if(new Date(latestChannelMessage.created_at).getTime()<new Date(currentChannelJoinDate).getTime())return;
    const key=`${selectedChannel}:${latestChannelMessageId}`;
    if(lastChannelReadRef.current===key)return;
    lastChannelReadRef.current=key;
    void api.markChannelRead(selectedChannel,latestChannelMessageId).then(()=>{
      void loadChannelNotices();
      setNotificationRefresh(v=>v+1);
    }).catch(e=>{lastChannelReadRef.current=null;setError(errorText(e));});
  },[view,selectedChannel,loadedChannelId,latestChannelMessageId,latestChannelMessage,currentChannelJoinDate,loadChannelNotices]);

  useEffect(()=>{markVisibleChannelRead();},[markVisibleChannelRead]);
  useEffect(()=>{
    const onVisible=()=>markVisibleChannelRead();
    document.addEventListener('visibilitychange',onVisible);
    window.addEventListener('focus',onVisible);
    return()=>{
      document.removeEventListener('visibilitychange',onVisible);
      window.removeEventListener('focus',onVisible);
    };
  },[markVisibleChannelRead]);

  async function action(fn:()=>Promise<unknown>, close=true){setError('');setPending(true);try{await fn();if(close)setModal(null);}catch(e){setError(errorText(e));}finally{setPending(false);}}
  function createTeam(e:FormEvent){e.preventDefault();void action(async()=>{const team=await api.createTeam(newTeam);setNewTeam('');await loadTeams();setSelectedTeam(team.id);void loadChannelNotices();});}
  function createChannel(e:FormEvent){e.preventDefault();if(!selectedTeam)return;void action(async()=>{const channel=await api.createChannel(selectedTeam,newChannel);setNewChannel('');const rows=await api.channels(selectedTeam);setChannels(rows);setSelectedChannel(channel.id);void loadChannelNotices();});}
  function inviteEmployee(e:FormEvent){e.preventDefault();if(!activeOrg)return;void action(async()=>{const result=await api.invite(activeOrg.id,inviteEmail,inviteRole);setInviteResult(result.development_invite_url||'Invitation sent. Check the email (or backend console in development).');setInviteEmail('');await api.members(activeOrg.id).then(setMembers);},false);}
  async function refreshTeamRoster(teamId:string){
    const rows=await api.teamMembers(teamId);
    setTeamRoster(rows);setTeamMentionPeople(rows.map(row=>row.user));
  }
  function addTeamMember(e:FormEvent){e.preventDefault();if(!selectedTeam)return;void action(async()=>{await api.addTeamMember(selectedTeam,teamMemberEmail);setTeamMemberEmail('');await refreshTeamRoster(selectedTeam);},false);}
  function changeTeamMember(user:Person,transfer:boolean){
    if(!selectedTeam||pending||!window.confirm(transfer?`Transfer team ownership to ${user.full_name}?`:`Remove ${user.full_name} from this team only?`))return;
    void action(async()=>{if(transfer)await api.transferTeamOwnership(selectedTeam,user.id);else await api.removeTeamMember(selectedTeam,user.id);await refreshTeamRoster(selectedTeam);void loadChannelNotices();},false);
  }
  function leaveActiveTeam(){
    if(!activeTeam||pending||myTeamRole!=='member')return;
    if(!window.confirm('Leave '+activeTeam.name+'? You will lose access to its channels and files, but remain in this workspace.'))return;
    const teamId=activeTeam.id,orgId=currentOrgRef.current;
    void action(async()=>{
      await api.leaveTeam(teamId);
      if(currentOrgRef.current!==orgId)return;
      setTeams(old=>old.filter(row=>row.id!==teamId));
      if(selectedTeamRef.current===teamId){
        setSelectedTeam(null);setSelectedChannel(null);setChannels([]);setMessages([]);
        setLoadedChannelId(null);setTeamRoster([]);setTeamMentionPeople([]);
        setDraft('');setReplyTo(null);setForwardId(null);setModal(null);
      }
      await loadTeams();void loadChannelNotices();
    },false);
  }
  function archiveTeamOrChannel(channel=false){
    if(!activeTeam||pending||(channel&&!activeChannel))return;
    const archived=!(channel?activeChannel!.archived_at:activeTeam.archived_at);
    if(!window.confirm(archived?'Archive this '+(channel?'channel':'team')+'? Its messages and files will remain readable.':'Restore this '+(channel?'channel':'team')+'?'))return;
    void action(async()=>{
      if(channel){const row=await api.archiveChannel(activeTeam.id,activeChannel!.id,archived);setChannels(old=>old.map(c=>c.id===row.id?row:c));}
      else{const row=await api.archiveTeam(activeTeam.id,archived);setTeams(old=>old.map(t=>t.id===row.id?row:t));}
      void loadChannelNotices();
    },false);
  }
  function renameTeamOrChannel(channel=false){
    if(!activeTeam||pending||(channel&&!activeChannel))return;
    const current=channel?activeChannel!.name:activeTeam.name;
    const name=window.prompt(channel?'Channel name':'Team name',current)?.trim();
    if(!name||name===current)return;
    void action(async()=>{if(channel){const updated=await api.renameChannel(activeTeam.id,activeChannel!.id,name);setChannels(old=>old.map(row=>row.id===updated.id?updated:row));}
    else{await api.renameTeam(activeTeam.id,name);await loadTeams();}},false);
  }
  async function changeMemberRole(member:Member, role:'admin'|'member') {if(!activeOrg || member.role===role)return;setError('');setMemberBusyId(member.id);try {await api.updateMemberRole(activeOrg.id,member.id,role);setMembers(await api.members(activeOrg.id));}catch(e){setError(errorText(e));}finally{setMemberBusyId(null);}}
  async function removeEmployee(member:Member) {if(!activeOrg)return;if(!window.confirm(`Remove ${member.user.full_name} from ${activeOrg.name}? They will lose access to its teams and channels.`))return;setError('');setMemberBusyId(member.id);try{await api.removeMember(activeOrg.id,member.id);setMembers(await api.members(activeOrg.id));}catch(e){setError(errorText(e));}finally{setMemberBusyId(null);}}
  useEffect(()=>{setReplyTo(null);setForwardId(null);},[selectedChannel,session.active_organization_id,view]);
  async function send(e:FormEvent){e.preventDefault();if(!selectedChannel||!draft.trim()||channelReadOnly)return;
    const channelId=selectedChannel,orgId=session.active_organization_id,body=draft,original=replyTarget?.id;
    setDraft('');setReplyTo(null);
    try{const message=await api.sendMessage(channelId,body,original);
      if(selectedChannelRef.current!==channelId||currentOrgRef.current!==orgId)return;
      channelAutoScrollRef.current=true;setMessages(old=>old.some(m=>m.id===message.id)?old:[...old,message]);
    }catch(err){if(selectedChannelRef.current===channelId&&currentOrgRef.current===orgId){setDraft(current=>current||body);if(original)setReplyTo(current=>current||{channelId,messageId:original});setError(errorText(err));}}
  }

  async function loadOlderChannelMessages(){
    const channelId=selectedChannel;
    const cursor=channelCursor;
    if(!channelId||!cursor||!channelHasMore||channelLoadingOlder||olderRequestRef.current)return;
    const generation=channelHistoryGeneration.current;
    olderRequestRef.current=true;
    setChannelLoadingOlder(true);
    const area=channelScrollRef.current;
    channelScrollAnchorRef.current=area?{height:area.scrollHeight,top:area.scrollTop}:null;
    const organizationId=session.active_organization_id;
    try{
      const page=await api.channelMessagePage(channelId,cursor);
      if(generation!==channelHistoryGeneration.current||selectedChannelRef.current!==channelId||currentOrgRef.current!==organizationId)return;
      if(page.items.length){
        setMessages(current=>{
          const all=new Map([...page.items,...current].map(m=>[m.id,m]));
          return [...all.values()].sort((a,b)=>
            a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
        });
      }else{
        channelScrollAnchorRef.current=null;
      }
      setChannelCursor(page.next_cursor);
      setChannelHasMore(page.has_more);
    }catch(e){
      if(generation===channelHistoryGeneration.current&&selectedChannelRef.current===channelId){
        channelScrollAnchorRef.current=null;
        setError(errorText(e));
      }
    }finally{
      if(generation!==channelHistoryGeneration.current)return;
      olderRequestRef.current=false;
      if(selectedChannelRef.current===channelId&&currentOrgRef.current===organizationId){
        setChannelLoadingOlder(false);
      }
    }
  }
  function switchOrg(id:string){void action(async()=>{const next=await api.activate(id);onSession(next);setOpenChatRequest(null);setChannelJump(null);setView('teams');},false);}
  async function signOut(){try{await api.logout();onLogout();}catch(e){setError(errorText(e));}}

  return <div className={`app-layout${view==='inbox'?' mail-view':''}`}><aside className={`sidebar ${sidebarOpen?'mobile-visible':''}`}><div className="sidebar-scroll"><div className="sidebar-header"><Brand/><button className="mobile-close icon-button" onClick={()=>setSidebarOpen(false)}><X size={20}/></button></div>
    <div className="org-picker"><div className="org-icon">{initials(activeOrg?.name||'TW')}</div><div className="org-label"><strong>{activeOrg?.name||'Choose workspace'}</strong><small>{activeOrg?.role||'No organization'}</small></div><ChevronDown size={16}/>
      <select aria-label="Switch organization" value={session.active_organization_id||''} onChange={e=>switchOrg(e.target.value)}>{session.organizations.map(org=><option key={org.id} value={org.id}>{org.name}</option>)}</select>
    </div>
    <div className="sidebar-title">WORKSPACE</div><nav className="nav-list">{navItems.map(item=><button key={item.id} className={`nav-item ${view===item.id?'active':''}`} onClick={()=>{setView(item.id);setSidebarOpen(false);}}><item.icon size={18}/><span>{item.label}</span>{!item.ready&&<span className="soon-dot" title="Coming next"/>}</button>)}</nav>
    <button className="nav-item" onClick={()=>{setModal('members');setSidebarOpen(false);}}><Users size={18}/><span>Members</span><span className="count-chip">{members.length}</span></button>
    <button className={`nav-item ${view==='settings'?'active':''}`} onClick={()=>{setView('settings');setSidebarOpen(false);}}><Settings2 size={18}/>Settings</button>
    <div className="sidebar-title teams-title">YOUR TEAMS <button className="icon-button" aria-label="Create team" onClick={()=>{setError('');setModal('team');setView('teams');}}><Plus size={17}/></button></div>
    <div className="team-tree">{teams.map(team=><div key={team.id}><button className={`tree-team ${selectedTeam===team.id&&view==='teams'?'selected':''}`} onClick={()=>{setSelectedTeam(team.id);setView('teams');setSidebarOpen(false);}}><span className="tree-team-icon">{initials(team.name)}</span><span>{team.name}{team.archived_at?' (Archived)':''}</span><ChevronDown size={13}/></button>
      {selectedTeam===team.id&&view==='teams'&&channels.map(channel=><button className={`tree-channel ${selectedChannel===channel.id?'selected':''}`} key={channel.id} onClick={()=>setSelectedChannel(channel.id)}><Hash size={14}/>{channel.name}{channel.archived_at?' (Archived)':''}{channelUnread(channel.id)>0&&<span className="channel-unread-count" aria-label={`${channelUnread(channel.id)} unread messages`}>{channelUnread(channel.id)>99?'99+':channelUnread(channel.id)}</span>}</button>)}</div>)}
    {teams.length===0&&<div className="sidebar-empty">Your teams will appear here.</div>}</div>
    </div>
    <div className="sidebar-bottom"><div className="profile"><div className="avatar">{initials(session.user.full_name)}</div><div className="profile-name"><strong>{session.user.full_name}</strong><small>{session.user.email}</small></div><button className="icon-button" aria-label="Log out" title="Log out" onClick={signOut}><LogOut size={18}/></button></div></div>
  </aside>
  {sidebarOpen&&<div className="mobile-shade" onClick={()=>setSidebarOpen(false)}/>}
  <main className={"main-panel"+(view==='meetings'||view==='calendar'?' meetings-main':'')}><header className="top-bar"><div className="top-bar-left"><button className="mobile-menu icon-button" onClick={()=>setSidebarOpen(true)}><Menu/></button><span className="crumb">Workspace</span><span className="crumb-divider">/</span><strong>{view==='teams'?(activeTeam?.name||'Teams'):navItems.find(n=>n.id===view)?.label||'Settings'}</strong></div><div className="top-bar-right"><span className="preview-pill"><span/> PHASE 2 PREVIEW</span><ChatNotificationBell workspaceId={session.active_organization_id} userId={session.user.id} emailVerified={session.user.email_verified} onOpenMeeting={id=>{setOpenMeetingRequest({id,nonce:Date.now()});setView('meetings');setSidebarOpen(false);}} refreshVersion={notificationRefresh} onRealtimeNotification={()=>{void loadChannelNotices();}}
          onOpenChat={id=>{setOpenChatRequest({id,nonce:Date.now()});setView('chats');setSidebarOpen(false);}}
          onOpenChannel={(teamId,channelId)=>{setSelectedTeam(teamId);setSelectedChannel(channelId);setView('teams');setSidebarOpen(false);}}/><div className="top-avatar">{initials(session.user.full_name)}</div></div></header>
  {error&&<div className="floating-error"><ErrorBanner message={error} onClose={()=>setError('')}/></div>}
  {view==='teams' ? <>{!activeTeam?<div className="hero-empty"><Empty icon={<Users size={32}/>} title="Bring your team together" description="Create your first team to begin organizing conversations and projects." action={<button className="primary-button" onClick={()=>setModal('team')}><Plus size={17}/>Create your first team</button>}/></div>:
    <><div className="workspace-heading"><div><div className="eyebrow">YOUR WORKSPACE / TEAMS</div><h1>{activeTeam.name}{activeTeam.archived_at?' · Archived':''}</h1><p className="muted">Collaborate, share updates, and keep your team in sync.</p></div><div className="heading-actions">{(myTeamRole==='owner'||activeOrg?.role==='owner'||activeOrg?.role==='admin')&&<button className="outline-button" disabled={pending} onClick={()=>renameTeamOrChannel()} >Rename team</button>}{(myTeamRole==='owner'||activeOrg?.role==='owner'||activeOrg?.role==='admin')&&<button type="button" className="outline-button" disabled={pending} onClick={()=>archiveTeamOrChannel()}>{activeTeam.archived_at?'Restore team':'Archive team'}</button>}<button className="outline-button" onClick={()=>setModal('members')}><Users size={16}/> Manage members</button>{myTeamRole==='member'&&<button type="button" className="outline-button" disabled={pending} onClick={leaveActiveTeam}>Leave team</button>}<button className="primary-button" disabled={Boolean(activeTeam.archived_at)} onClick={()=>setModal('channel')}><Plus size={17}/> New channel</button></div></div>
      <div className="chat-workspace"><section className="channels-panel"><div className="panel-title">CHANNELS <button className="icon-button" title="New channel" disabled={Boolean(activeTeam.archived_at)} onClick={()=>setModal('channel')}><Plus size={17}/></button></div>{[...channels].sort((a,b)=>Number(Boolean(channelNotices.find(n=>n.channel_id===b.id)?.is_pinned))-Number(Boolean(channelNotices.find(n=>n.channel_id===a.id)?.is_pinned))).map(ch=><button className={`channel-card ${selectedChannel===ch.id?'active':''}`} key={ch.id} onClick={()=>setSelectedChannel(ch.id)}><span className="channel-symbol"><Hash size={17}/></span><span>{channelNotices.find(n=>n.channel_id===ch.id)?.is_pinned?'★ ':''}{ch.name}{ch.archived_at?' (Archived)':''}</span>{channelUnread(ch.id)>0&&<span className="channel-unread-count" aria-label={`${channelUnread(ch.id)} unread messages`}>{channelUnread(ch.id)>99?'99+':channelUnread(ch.id)}</span>}{selectedChannel===ch.id&&<span className="selected-indicator"/>}</button>)}<div className="channel-help"><Sparkles size={18}/><strong>A place for every topic</strong><p>Create channels to keep discussions organized.</p></div></section>
        <section className="conversation-panel">{activeChannel?<><div className="conversation-top"><div className="channel-avatar"><Hash size={23}/></div><div><h3>{activeChannel.name}{channelReadOnly?' · Read-only':''}</h3><p>{activeTeam.name} · {connected?'Live updates connected':'Messages are saved securely'}</p></div>{(myTeamRole==='owner'||activeOrg?.role==='owner'||activeOrg?.role==='admin')&&<button className="outline-button" disabled={pending} onClick={()=>renameTeamOrChannel(true)} >Rename channel</button>}{(myTeamRole==='owner'||activeOrg?.role==='owner'||activeOrg?.role==='admin')&&<button type="button" className="outline-button" disabled={pending} onClick={()=>archiveTeamOrChannel(true)}>{activeChannel.archived_at?'Restore channel':'Archive channel'}</button>}<button className="outline-button" type="button" disabled={pending} onClick={()=>changeChannelPreference('is_pinned')}>{channelPreference?.is_pinned?'Unpin channel':'Pin channel'}</button><button className="outline-button" type="button" disabled={pending} onClick={()=>changeChannelPreference('is_muted')}>{channelPreference?.is_muted?'Unmute':'Mute'}</button><span className={`connection-light ${connected?'online':''}`} title={connected?'WebSocket connected':'WebSocket disconnected'}/></div>
          {channelJump?.id===selectedChannel&&<MessageContext key={channelJump.nonce} kind="channel" id={selectedChannel!} messageId={channelJump.messageId} onClose={()=>setChannelJump(null)}/>}
          <PinnedMessages key={selectedChannel!} kind="channel" id={selectedChannel!} version={pinVersion} readOnly={channelReadOnly} onUnpin={updated=>{setMessages(old=>old.map(row=>row.id===updated.id?updated:row));setPinVersion(value=>value+1);}}/>
          <div className="message-area" ref={channelScrollRef} onScroll={e=>{
              const el=e.currentTarget;
              if(!olderRequestRef.current&&!channelScrollAnchorRef.current){
                channelAutoScrollRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;
              }
            }}><div className="channel-intro"><div className="channel-intro-mark"><Hash size={26}/></div><h2>Welcome to #{activeChannel.name}</h2><p>This is the beginning of the conversation in this channel.</p></div>
          <div className="message-list">{loadedChannelId===selectedChannel&&channelHasMore&&
            <button className="channel-load-older" type="button" disabled={channelLoadingOlder}
              aria-label="Load older channel messages"
              onClick={()=>void loadOlderChannelMessages()}>{channelLoadingOlder?'Loading older messages…':'Load older messages'}</button>}
            {messages.map((message,index)=><ChannelMessageItem key={message.id} channelId={selectedChannel!} message={message} readOnly={channelReadOnly} onForward={()=>setForwardId(message.id)} replyTarget={messages.find(row=>row.id===message.reply_to_id)} onReply={()=>setReplyTo({channelId:selectedChannel!,messageId:message.id})} isMine={message.sender.id===session.user.id} samePerson={messages[index-1]?.sender.id===message.sender.id} onUpdated={updated=>{setMessages(current=>current.map(row=>row.id===updated.id?updated:row));setPinVersion(value=>value+1);}}/>)}</div></div>
          <ChannelMeetingCards key={'meetings-'+selectedChannel} channelId={selectedChannel!} onOpen={id=>{setOpenMeetingRequest({id,nonce:Date.now()});setView('meetings');setSidebarOpen(false);}}/>
          <div className="channel-meeting-shortcut"><button className="text-link" onClick={()=>{setView('meetings');setSidebarOpen(false);}}><Video size={15}/>Open workspace meetings</button></div>
          <AttachmentPanel key={selectedChannel!} kind="channel" parentId={selectedChannel!} readOnly={channelReadOnly}/>
           {channelReadOnly?<div className="compose-caption">Archived conversation — restore it to send messages or upload files.</div>:<form className="message-compose" onSubmit={send}>{replyTarget&&<ReplyPreview message={replyTarget} onCancel={()=>setReplyTo(null)}/>}<div className="compose-box"><MentionInput value={draft} onChange={setDraft} people={teamMentionPeople.filter(person=>person.id!==session.user.id)} placeholder={`Message #${activeChannel.name}`} ariaLabel="New message"/><button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><Send size={18}/></button></div><div className="compose-caption">Type @ to mention a teammate · Enter to send · Only team members can read this channel</div></form>}
        </>:<Empty icon={<Hash size={32}/>} title="Choose a channel" description="Select a channel to see its conversations."/>}</section></div>
    </>}
  </>:view==='chats' ? <ChatPanel key={session.active_organization_id||'none'} workspaceId={session.active_organization_id} currentUser={session.user} members={members} presence={presence} requestedChat={openChatRequest} onRead={()=>setNotificationRefresh(current=>current+1)}/>
   :view==='inbox' ? <EmailPanel key={session.active_organization_id||'none'} workspaceId={session.active_organization_id} user={session.user}/>
   :view==='files' ? <SharedFilesPanel key={session.active_organization_id||'none'} workspaceId={session.active_organization_id}/>
   :view==='meetings'||view==='calendar' ? <MeetingsPanel key={(session.active_organization_id||'none')+view} workspaceId={session.active_organization_id} userId={session.user.id} members={members} teams={teams} calendar={view==='calendar'} requestedMeeting={openMeetingRequest} onChanged={()=>setNotificationRefresh(v=>v+1)}/>
   :view==='settings' ? <SettingsPanel key={session.active_organization_id||'none'} workspaceId={session.active_organization_id} workspaceName={activeOrg?.name||'your workspace'} user={session.user} onPreferencesSaved={()=>setNotificationRefresh(v=>v+1)}/>
   :view==='search' ? <MessageSearchPanel key={session.active_organization_id||'none'}
        onOpenChat={(id,messageId)=>{setOpenChatRequest({id,messageId,nonce:Date.now()});setView('chats');setSidebarOpen(false);}}
        onOpenChannel={(teamId,channelId,messageId)=>{setChannelJump({id:channelId,messageId,nonce:Date.now()});setSelectedTeam(teamId);setSelectedChannel(channelId);setView('teams');setSidebarOpen(false);}}/>
   : <div className="future-page"><div className="future-icon">{view==='inbox'?<Inbox size={32}/>:view==='meetings'?<Video size={32}/>:view==='calendar'?<CalendarDays size={32}/>:view==='files'?<FolderOpen size={32}/>:<Settings2 size={32}/>}</div><div className="eyebrow">COMING IN A FUTURE PHASE</div><h1>{navItems.find(n=>n.id===view)?.label||'Workspace settings'}</h1><p>{view==='inbox'?'Connect Gmail and Outlook accounts, read inbox threads and send, reply or forward emails from your own mailbox.':view==='meetings'?'Schedule secure team meetings with audio, video and screen sharing.':'This module is planned after the authentication and real-time team chat foundation.'}</p><button className="outline-button" onClick={()=>setView('teams')}><ArrowLeft size={16}/>Back to Teams</button></div>}
  </main>
  {view==='teams'&&selectedChannel&&forwardTarget&&<ForwardMessageDialog key={selectedChannel+forwardTarget.id} kind="channel" sourceId={selectedChannel} message={forwardTarget} onClose={()=>setForwardId(null)} onSent={result=>{if(result.kind==='channel'&&result.destination_id===selectedChannel)setMessages(old=>old.some(row=>row.id===result.message.id)?old:[...old,result.message]);}}/>}
  {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null);}}><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><div><div className="eyebrow">TEAMWORKSPACE</div><h2>{modal==='team'?'Create a team':modal==='channel'?'Create a channel':modal==='invite'?'Invite an employee':'Workspace members'}</h2></div><button className="icon-button" onClick={()=>setModal(null)} aria-label="Close"><X size={21}/></button></div>
    {error&&<ErrorBanner message={error}/>}
    {modal==='team'&&<form onSubmit={createTeam} className="modal-body"><p className="muted">Teams bring people, channels and conversations together.</p><label>Team name<input autoFocus required maxLength={120} value={newTeam} onChange={e=>setNewTeam(e.target.value)} placeholder="e.g. Product & Design"/></label><div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" disabled={pending||!newTeam.trim()}>Create team <ArrowRight size={16}/></button></div></form>}
    {modal==='channel'&&<form onSubmit={createChannel} className="modal-body"><p className="muted">Organize specific conversations inside {activeTeam?.name}.</p><label>Channel name<input autoFocus required maxLength={100} value={newChannel} onChange={e=>setNewChannel(e.target.value)} placeholder="e.g. Weekly updates"/></label><div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" disabled={pending||!newChannel.trim()}>Create channel <ArrowRight size={16}/></button></div></form>}
    {modal==='invite'&&<form onSubmit={inviteEmployee} className="modal-body"><p className="muted">Invite a colleague to join {activeOrg?.name}. A private invitation link will be emailed to them.</p><label>Email address<input type="email" required autoFocus value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="colleague@company.com"/></label><label>Workspace role<select value={inviteRole} onChange={e=>setInviteRole(e.target.value)}><option value="member">Member</option>{activeOrg?.role==='owner'&&<option value="admin">Administrator</option>}</select></label>{inviteResult&&<div className="success-note"><Check size={16}/> <span>{inviteResult.startsWith('http')?<><span>Development invitation link:</span><a href={inviteResult}>{inviteResult}</a></>:inviteResult}</span></div>}<div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Close</button><button className="primary-button" disabled={pending}>Send invite <ArrowRight size={16}/></button></div></form>}
    {modal==='members'&&<div className="modal-body"><p className="muted">{activeOrg?.name} · {members.length} members</p><div className="member-list">{members.map(m=><div className="member-row" key={m.id}><div className="avatar small-avatar">{initials(m.user.full_name)}</div><div><strong>{m.user.full_name}</strong><small>{m.user.email}</small></div><div className="member-actions">{activeOrg?.role==='owner' && m.role!=='owner' && m.user.id!==session.user.id ? <select className="member-role-select" aria-label={`Role for ${m.user.full_name}`} value={m.role} disabled={memberBusyId!==null} onChange={e=>void changeMemberRole(m,e.target.value as 'admin'|'member')}><option value="member">Member</option><option value="admin">Admin</option></select> : <span className="role-pill">{m.role}</span>}{m.user.id!==session.user.id && m.role!=='owner' && (activeOrg?.role==='owner' || (activeOrg?.role==='admin' && m.role==='member')) && <button type="button" className="member-remove" disabled={memberBusyId!==null} onClick={()=>void removeEmployee(m)}>{memberBusyId===m.id?'Working...':'Remove'}</button>}</div></div>)}</div>
      {selectedTeam&&<><h3>Team members — {activeTeam?.name}</h3><div className="member-list">{teamRoster.map(row=><div className="member-row" key={row.user.id}><div><strong>{row.user.full_name}</strong><small>{row.user.email}</small><PresenceStatus row={presence[row.user.id]}/></div><div className="member-actions"><span className="role-pill">{row.role}</span>{row.role!=='owner'&&row.user.id!==session.user.id&&(myTeamRole==='owner'||activeOrg?.role==='owner'||activeOrg?.role==='admin')&&<button type="button" className="member-remove" disabled={pending} onClick={()=>changeTeamMember(row.user,false)}>Remove from team</button>}{row.user.id!==session.user.id&&myTeamRole==='owner'&&<button type="button" className="member-remove" disabled={pending} onClick={()=>changeTeamMember(row.user,true)}>Transfer ownership</button>}</div></div>)}</div></>}
      {selectedTeam&&<form className="quick-add" onSubmit={addTeamMember}><label>Add organization member to {activeTeam?.name}<input type="email" placeholder="Member email address" value={teamMemberEmail} onChange={e=>setTeamMemberEmail(e.target.value)} required/></label><button disabled={pending} className="outline-button"><Plus size={15}/>Add to team</button></form>}
      {canInvite&&<button className="primary-button wide" onClick={()=>{setInviteResult('');setModal('invite');}}><Plus size={16}/>Invite new employee</button>}</div>}
  </div></div>}
  </div>;
}

export default function App() {
  const [session,setSession] = useState<Session|null|undefined>(undefined);
  const [bootError,setBootError] = useState('');
  const inviteMode = location.pathname === '/invite';
  const recoveryMode = location.pathname === '/forgot-password' ? 'forgot'
    : location.pathname === '/reset-password' ? 'reset'
    : location.pathname === '/verify-email' ? 'verify' : null;
  useEffect(()=>{let active=true;csrf().then(()=>api.me()).then(s=>{if(active)setSession(s);}).catch(e=>{if(!active)return;if('status' in (e as object) && (e as {status:number}).status===401) setSession(null);else {setBootError(errorText(e));setSession(null);}});return()=>{active=false;};},[]);
  if(session===undefined)return <div className="page-loader"><Brand/><Spinner/><span>Preparing your workspace...</span></div>;
  if(recoveryMode)return <AccountRecoveryScreen mode={recoveryMode}/>;
  if(inviteMode)return <InviteScreen session={session} onDone={s=>{setSession(s);history.replaceState({},'','/');}} onBack={()=>{location.href='/';}}/>;
  if(!session)return <>{bootError&&<div className="boot-error"><ErrorBanner message={bootError}/></div>}<AuthScreen onAuth={setSession}/></>;
  return <Workspace session={session} onSession={setSession} onLogout={()=>setSession(null)}/>;
}



