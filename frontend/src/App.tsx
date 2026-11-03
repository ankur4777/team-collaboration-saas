import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Bell, Check, ChevronDown, Hash, Inbox,
  LayoutGrid, LockKeyhole, LogOut, Mail, Menu, Plus, Send,
  Settings2, Sparkles, Users, Video, X, CalendarDays, FolderOpen } from 'lucide-react';
import { api, csrf, type Channel, type Member, type Message, type Session, type Team } from './api';

function initials(name: string) { return name.split(' ').filter(Boolean).slice(0, 2).map(t => t[0].toUpperCase()).join('') || 'TW'; }
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong'; }
function relativeTime(iso: string) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
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
      <button type="submit" className="primary-button wide" disabled={busy}>{busy?<Spinner/>:mode==='register'?'Create workspace':'Sign in'} <ArrowRight size={17}/></button>
      <div className="auth-note"><LockKeyhole size={14}/> Your workspace data stays separate and protected.</div>
      <p className="auth-switch">{mode==='register'?'Have an account already?':'New to TeamWorkspace?'} <button type="button" className="text-link" onClick={()=>{setMode(mode==='login'?'register':'login');setError('');}}>{mode==='register'?'Sign in':'Create a workspace'}</button></p>
    </form><div className="auth-footer">© 2026 TeamWorkspace · Phase 1 development preview</div>
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
  {id:'inbox', label:'Email inbox', icon:Mail, ready:false},
  {id:'meetings', label:'Meetings', icon:Video, ready:false},
  {id:'calendar', label:'Calendar', icon:CalendarDays, ready:false},
  {id:'files', label:'Shared files', icon:FolderOpen, ready:false},
];
function Workspace({ session, onSession, onLogout }: {session:Session;onSession:(value:Session)=>void;onLogout:()=>void}) {
  const [view,setView] = useState('teams'); const [teams,setTeams] = useState<Team[]>([]);
  const [selectedTeam,setSelectedTeam] = useState<string|null>(null);
  const [channels,setChannels] = useState<Channel[]>([]);const [selectedChannel,setSelectedChannel] = useState<string|null>(null);
  const [messages,setMessages] = useState<Message[]>([]); const [members,setMembers] = useState<Member[]>([]);
  const [newTeam,setNewTeam] = useState(''); const [newChannel,setNewChannel] = useState('');
  const [inviteEmail,setInviteEmail] = useState('');const [inviteRole,setInviteRole] = useState('member');
  const [teamMemberEmail,setTeamMemberEmail] = useState('');
  const [inviteResult,setInviteResult] = useState('');
  const [memberBusyId,setMemberBusyId] = useState<string|null>(null);
  const [draft,setDraft] = useState(''); const [pending,setPending] = useState(false);
  const [error,setError] = useState('');const [modal,setModal] = useState<null|'team'|'channel'|'invite'|'members'>(null);
  const [sidebarOpen,setSidebarOpen] = useState(false);const [connected,setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeOrg = session.organizations.find(o=>o.id===session.active_organization_id);
  const activeTeam = teams.find(t=>t.id===selectedTeam);
  const activeChannel = channels.find(c=>c.id===selectedChannel);
  const canInvite = activeOrg?.role === 'owner' || activeOrg?.role === 'admin';

  const loadTeams = useCallback(async()=>{ try {const rows=await api.teams();setTeams(rows);setSelectedTeam(current=>current && rows.some(t=>t.id===current)?current:(rows[0]?.id||null));}catch(e){setError(errorText(e));}},[]);
  useEffect(()=>{setTeams([]);setChannels([]);setSelectedTeam(null);setSelectedChannel(null);setMessages([]);loadTeams();if(session.active_organization_id)api.members(session.active_organization_id).then(setMembers).catch(()=>{});},[session.active_organization_id,loadTeams]);
  useEffect(()=>{if(!selectedTeam){setChannels([]);setSelectedChannel(null);return;}let valid=true;api.channels(selectedTeam).then(rows=>{if(!valid)return;setChannels(rows);setSelectedChannel(current=>current&&rows.some(c=>c.id===current)?current:rows[0]?.id||null);}).catch(e=>valid&&setError(errorText(e)));return()=>{valid=false;};},[selectedTeam]);
  useEffect(()=>{if(!selectedChannel){setMessages([]);return;}let valid=true;setMessages([]);api.messages(selectedChannel).then(rows=>{if(valid)setMessages(rows);}).catch(e=>valid&&setError(errorText(e)));return()=>{valid=false;};},[selectedChannel]);
  useEffect(()=>{if(!selectedChannel)return;let open=true;setConnected(false);const protocol=location.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(`${protocol}//${location.host}/ws/channels/${selectedChannel}/`);
    socket.onopen=()=>{if(open)setConnected(true);};socket.onclose=()=>{if(open)setConnected(false);};
    socket.onmessage=event=>{try {const payload=JSON.parse(event.data) as {type:string;message:Message};if(payload.type==='message'&&open)setMessages(old=>old.some(m=>m.id===payload.message.id)?old:[...old,payload.message]);}catch{/* Ignore malformed server messages */}};
    return()=>{open=false;socket.close();};
  },[selectedChannel]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[messages.length]);

  async function action(fn:()=>Promise<unknown>, close=true){setError('');setPending(true);try{await fn();if(close)setModal(null);}catch(e){setError(errorText(e));}finally{setPending(false);}}
  function createTeam(e:FormEvent){e.preventDefault();void action(async()=>{const team=await api.createTeam(newTeam);setNewTeam('');await loadTeams();setSelectedTeam(team.id);});}
  function createChannel(e:FormEvent){e.preventDefault();if(!selectedTeam)return;void action(async()=>{const channel=await api.createChannel(selectedTeam,newChannel);setNewChannel('');const rows=await api.channels(selectedTeam);setChannels(rows);setSelectedChannel(channel.id);});}
  function inviteEmployee(e:FormEvent){e.preventDefault();if(!activeOrg)return;void action(async()=>{const result=await api.invite(activeOrg.id,inviteEmail,inviteRole);setInviteResult(result.development_invite_url||'Invitation sent. Check the email (or backend console in development).');setInviteEmail('');await api.members(activeOrg.id).then(setMembers);},false);}
  function addTeamMember(e:FormEvent){e.preventDefault();if(!selectedTeam)return;void action(async()=>{await api.addTeamMember(selectedTeam,teamMemberEmail);setTeamMemberEmail('');});}
  async function changeMemberRole(member:Member, role:'admin'|'member') {if(!activeOrg || member.role===role)return;setError('');setMemberBusyId(member.id);try {await api.updateMemberRole(activeOrg.id,member.id,role);setMembers(await api.members(activeOrg.id));}catch(e){setError(errorText(e));}finally{setMemberBusyId(null);}}
  async function removeEmployee(member:Member) {if(!activeOrg)return;if(!window.confirm(`Remove ${member.user.full_name} from ${activeOrg.name}? They will lose access to its teams and channels.`))return;setError('');setMemberBusyId(member.id);try{await api.removeMember(activeOrg.id,member.id);setMembers(await api.members(activeOrg.id));}catch(e){setError(errorText(e));}finally{setMemberBusyId(null);}}
  async function send(e:FormEvent){e.preventDefault();if(!selectedChannel||!draft.trim())return;const body=draft;setDraft('');try{const message=await api.sendMessage(selectedChannel,body);setMessages(old=>old.some(m=>m.id===message.id)?old:[...old,message]);}catch(err){setDraft(body);setError(errorText(err));}}
  function switchOrg(id:string){void action(async()=>{const next=await api.activate(id);onSession(next);setView('teams');},false);}
  async function signOut(){try{await api.logout();onLogout();}catch(e){setError(errorText(e));}}

  return <div className="app-layout"><aside className={`sidebar ${sidebarOpen?'mobile-visible':''}`}><div className="sidebar-header"><Brand/><button className="mobile-close icon-button" onClick={()=>setSidebarOpen(false)}><X size={20}/></button></div>
    <div className="org-picker"><div className="org-icon">{initials(activeOrg?.name||'TW')}</div><div className="org-label"><strong>{activeOrg?.name||'Choose workspace'}</strong><small>{activeOrg?.role||'No organization'}</small></div><ChevronDown size={16}/>
      <select aria-label="Switch organization" value={session.active_organization_id||''} onChange={e=>switchOrg(e.target.value)}>{session.organizations.map(org=><option key={org.id} value={org.id}>{org.name}</option>)}</select>
    </div>
    <div className="sidebar-title">WORKSPACE</div><nav className="nav-list">{navItems.map(item=><button key={item.id} className={`nav-item ${view===item.id?'active':''}`} onClick={()=>{setView(item.id);setSidebarOpen(false);}}><item.icon size={18}/><span>{item.label}</span>{!item.ready&&<span className="soon-dot" title="Coming next"/>}</button>)}</nav>
    <div className="sidebar-title teams-title">YOUR TEAMS <button className="icon-button" aria-label="Create team" onClick={()=>{setError('');setModal('team');setView('teams');}}><Plus size={17}/></button></div>
    <div className="team-tree">{teams.map(team=><div key={team.id}><button className={`tree-team ${selectedTeam===team.id&&view==='teams'?'selected':''}`} onClick={()=>{setSelectedTeam(team.id);setView('teams');setSidebarOpen(false);}}><span className="tree-team-icon">{initials(team.name)}</span><span>{team.name}</span><ChevronDown size={13}/></button>
      {selectedTeam===team.id&&view==='teams'&&channels.map(channel=><button className={`tree-channel ${selectedChannel===channel.id?'selected':''}`} key={channel.id} onClick={()=>setSelectedChannel(channel.id)}><Hash size={14}/>{channel.name}</button>)}</div>)}
    {teams.length===0&&<div className="sidebar-empty">Your teams will appear here.</div>}</div>
    <div className="sidebar-bottom"><button className="nav-item" onClick={()=>setModal('members')}><Users size={18}/>Members <span className="count-chip">{members.length}</span></button><button className="nav-item" onClick={()=>setView('settings')}><Settings2 size={18}/>Settings <span className="soon-dot"/></button><div className="profile"><div className="avatar">{initials(session.user.full_name)}</div><div className="profile-name"><strong>{session.user.full_name}</strong><small>{session.user.email}</small></div><button className="icon-button" aria-label="Log out" title="Log out" onClick={signOut}><LogOut size={18}/></button></div></div>
  </aside>
  {sidebarOpen&&<div className="mobile-shade" onClick={()=>setSidebarOpen(false)}/>}
  <main className="main-panel"><header className="top-bar"><div className="top-bar-left"><button className="mobile-menu icon-button" onClick={()=>setSidebarOpen(true)}><Menu/></button><span className="crumb">Workspace</span><span className="crumb-divider">/</span><strong>{view==='teams'?(activeTeam?.name||'Teams'):navItems.find(n=>n.id===view)?.label||'Settings'}</strong></div><div className="top-bar-right"><span className="preview-pill"><span/> PHASE 1 PREVIEW</span><button className="icon-button" title="Notifications coming soon"><Bell size={19}/></button><div className="top-avatar">{initials(session.user.full_name)}</div></div></header>
  {error&&<div className="floating-error"><ErrorBanner message={error} onClose={()=>setError('')}/></div>}
  {view==='teams' ? <>{!activeTeam?<div className="hero-empty"><Empty icon={<Users size={32}/>} title="Bring your team together" description="Create your first team to begin organizing conversations and projects." action={<button className="primary-button" onClick={()=>setModal('team')}><Plus size={17}/>Create your first team</button>}/></div>:
    <><div className="workspace-heading"><div><div className="eyebrow">YOUR WORKSPACE / TEAMS</div><h1>{activeTeam.name}</h1><p className="muted">Collaborate, share updates, and keep your team in sync.</p></div><div className="heading-actions"><button className="outline-button" onClick={()=>setModal('members')}><Users size={16}/> Manage members</button><button className="primary-button" onClick={()=>setModal('channel')}><Plus size={17}/> New channel</button></div></div>
      <div className="chat-workspace"><section className="channels-panel"><div className="panel-title">CHANNELS <button className="icon-button" title="New channel" onClick={()=>setModal('channel')}><Plus size={17}/></button></div>{channels.map(ch=><button className={`channel-card ${selectedChannel===ch.id?'active':''}`} key={ch.id} onClick={()=>setSelectedChannel(ch.id)}><span className="channel-symbol"><Hash size={17}/></span><span>{ch.name}</span>{selectedChannel===ch.id&&<span className="selected-indicator"/>}</button>)}<div className="channel-help"><Sparkles size={18}/><strong>A place for every topic</strong><p>Create channels to keep discussions organized.</p></div></section>
        <section className="conversation-panel">{activeChannel?<><div className="conversation-top"><div className="channel-avatar"><Hash size={23}/></div><div><h3>{activeChannel.name}</h3><p>{activeTeam.name} · {connected?'Live updates connected':'Messages are saved securely'}</p></div><span className={`connection-light ${connected?'online':''}`} title={connected?'WebSocket connected':'WebSocket disconnected'}/></div>
          <div className="message-area"><div className="channel-intro"><div className="channel-intro-mark"><Hash size={26}/></div><h2>Welcome to #{activeChannel.name}</h2><p>This is the beginning of the conversation in this channel.</p></div>
          <div className="message-list">{messages.map((message,index)=>{const previous=messages[index-1];const samePerson=previous?.sender.id===message.sender.id;return <div className={`message ${samePerson?'consecutive':''}`} key={message.id}>{!samePerson?<div className="msg-avatar">{initials(message.sender.full_name)}</div>:<div className="msg-avatar-placeholder"/>}<div className="msg-content">{!samePerson&&<div className="msg-meta"><strong>{message.sender.full_name}</strong><span>{relativeTime(message.created_at)}</span></div>}<div className="msg-body">{message.body}</div></div></div>;})}<div ref={bottomRef}/></div></div>
          <form className="message-compose" onSubmit={send}><div className="compose-box"><input value={draft} maxLength={4000} onChange={e=>setDraft(e.target.value)} placeholder={`Message #${activeChannel.name}`} aria-label="New message"/><button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><Send size={18}/></button></div><div className="compose-caption">Enter to send · Only team members can read this channel</div></form>
        </>:<Empty icon={<Hash size={32}/>} title="Choose a channel" description="Select a channel to see its conversations."/>}</section></div>
    </>}
  </>:<div className="future-page"><div className="future-icon">{view==='inbox'?<Inbox size={32}/>:view==='meetings'?<Video size={32}/>:view==='calendar'?<CalendarDays size={32}/>:view==='files'?<FolderOpen size={32}/>:<Settings2 size={32}/>}</div><div className="eyebrow">COMING IN A FUTURE PHASE</div><h1>{navItems.find(n=>n.id===view)?.label||'Workspace settings'}</h1><p>{view==='inbox'?'Connect Gmail and Outlook accounts, read inbox threads and send, reply or forward emails from your own mailbox.':view==='meetings'?'Schedule secure team meetings with audio, video and screen sharing.':'This module is planned after the authentication and real-time team chat foundation.'}</p><button className="outline-button" onClick={()=>setView('teams')}><ArrowLeft size={16}/>Back to Teams</button></div>}
  </main>
  {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null);}}><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><div><div className="eyebrow">TEAMWORKSPACE</div><h2>{modal==='team'?'Create a team':modal==='channel'?'Create a channel':modal==='invite'?'Invite an employee':'Workspace members'}</h2></div><button className="icon-button" onClick={()=>setModal(null)} aria-label="Close"><X size={21}/></button></div>
    {error&&<ErrorBanner message={error}/>}
    {modal==='team'&&<form onSubmit={createTeam} className="modal-body"><p className="muted">Teams bring people, channels and conversations together.</p><label>Team name<input autoFocus required maxLength={120} value={newTeam} onChange={e=>setNewTeam(e.target.value)} placeholder="e.g. Product & Design"/></label><div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" disabled={pending||!newTeam.trim()}>Create team <ArrowRight size={16}/></button></div></form>}
    {modal==='channel'&&<form onSubmit={createChannel} className="modal-body"><p className="muted">Organize specific conversations inside {activeTeam?.name}.</p><label>Channel name<input autoFocus required maxLength={100} value={newChannel} onChange={e=>setNewChannel(e.target.value)} placeholder="e.g. Weekly updates"/></label><div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" disabled={pending||!newChannel.trim()}>Create channel <ArrowRight size={16}/></button></div></form>}
    {modal==='invite'&&<form onSubmit={inviteEmployee} className="modal-body"><p className="muted">Invite a colleague to join {activeOrg?.name}. A private invitation link will be emailed to them.</p><label>Email address<input type="email" required autoFocus value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="colleague@company.com"/></label><label>Workspace role<select value={inviteRole} onChange={e=>setInviteRole(e.target.value)}><option value="member">Member</option>{activeOrg?.role==='owner'&&<option value="admin">Administrator</option>}</select></label>{inviteResult&&<div className="success-note"><Check size={16}/> <span>{inviteResult.startsWith('http')?<><span>Development invitation link:</span><a href={inviteResult}>{inviteResult}</a></>:inviteResult}</span></div>}<div className="modal-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Close</button><button className="primary-button" disabled={pending}>Send invite <ArrowRight size={16}/></button></div></form>}
    {modal==='members'&&<div className="modal-body"><p className="muted">{activeOrg?.name} · {members.length} members</p><div className="member-list">{members.map(m=><div className="member-row" key={m.id}><div className="avatar small-avatar">{initials(m.user.full_name)}</div><div><strong>{m.user.full_name}</strong><small>{m.user.email}</small></div><div className="member-actions">{activeOrg?.role==='owner' && m.role!=='owner' && m.user.id!==session.user.id ? <select className="member-role-select" aria-label={`Role for ${m.user.full_name}`} value={m.role} disabled={memberBusyId!==null} onChange={e=>void changeMemberRole(m,e.target.value as 'admin'|'member')}><option value="member">Member</option><option value="admin">Admin</option></select> : <span className="role-pill">{m.role}</span>}{m.user.id!==session.user.id && m.role!=='owner' && (activeOrg?.role==='owner' || (activeOrg?.role==='admin' && m.role==='member')) && <button type="button" className="member-remove" disabled={memberBusyId!==null} onClick={()=>void removeEmployee(m)}>{memberBusyId===m.id?'Working...':'Remove'}</button>}</div></div>)}</div>
      {selectedTeam&&<form className="quick-add" onSubmit={addTeamMember}><label>Add organization member to {activeTeam?.name}<input type="email" placeholder="Member email address" value={teamMemberEmail} onChange={e=>setTeamMemberEmail(e.target.value)} required/></label><button disabled={pending} className="outline-button"><Plus size={15}/>Add to team</button></form>}
      {canInvite&&<button className="primary-button wide" onClick={()=>{setInviteResult('');setModal('invite');}}><Plus size={16}/>Invite new employee</button>}</div>}
  </div></div>}
  </div>;
}

export default function App() {
  const [session,setSession] = useState<Session|null|undefined>(undefined);
  const [bootError,setBootError] = useState('');
  const inviteMode = location.pathname === '/invite';
  useEffect(()=>{let active=true;csrf().then(()=>api.me()).then(s=>{if(active)setSession(s);}).catch(e=>{if(!active)return;if('status' in (e as object) && (e as {status:number}).status===401) setSession(null);else {setBootError(errorText(e));setSession(null);}});return()=>{active=false;};},[]);
  if(session===undefined)return <div className="page-loader"><Brand/><Spinner/><span>Preparing your workspace...</span></div>;
  if(inviteMode)return <InviteScreen session={session} onDone={s=>{setSession(s);history.replaceState({},'','/');}} onBack={()=>{location.href='/';}}/>;
  if(!session)return <>{bootError&&<div className="boot-error"><ErrorBanner message={bootError}/></div>}<AuthScreen onAuth={setSession}/></>;
  return <Workspace session={session} onSession={setSession} onLogout={()=>setSession(null)}/>;
}
