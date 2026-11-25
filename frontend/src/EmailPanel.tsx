import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Archive,ArrowLeft,ArrowRight,Check,ChevronDown,Download,FileText,Folder,Forward,Inbox,Mail,MailOpen,
  Paperclip,Plus,RefreshCw,Reply,ReplyAll,Search,Send,Settings2,ShieldAlert,Star,Trash2,X} from 'lucide-react';
import {attachmentUrl,mailApi,MailApiError,type ComposePayload,type FolderId,type MailAccount,type MailConfig,
  type MailFolder,type MailMessage,type UploadFile} from './mailApi';
import './EmailPanel.css';

const FOLDERS:Array<{id:FolderId;label:string;icon:typeof Inbox}>= [
  {id:'inbox',label:'Inbox',icon:Inbox},{id:'sent',label:'Sent',icon:Send},{id:'drafts',label:'Drafts',icon:FileText},
  {id:'starred',label:'Starred',icon:Star},{id:'archive',label:'Archive',icon:Archive},
  {id:'junk',label:'Junk',icon:ShieldAlert},{id:'trash',label:'Deleted',icon:Trash2},
];
type Editor={to:string;cc:string;bcc:string;subject:string;body:string;attachments:UploadFile[];draft_id:string;
  reply_id:string;mode:ComposePayload['mode'];key:string;uncertain:boolean};
const errorText=(e:unknown)=>e instanceof Error?e.message:'The mailbox request failed.';
const fresh=():Editor=>({to:'',cc:'',bcc:'',subject:'',body:'',attachments:[],draft_id:'',reply_id:'',mode:'new',key:crypto.randomUUID(),uncertain:false});
const split=(v:string)=>v.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
const bytes=(n:number)=>n<1024?n+' B':n<1048576?(n/1024).toFixed(0)+' KB':(n/1048576).toFixed(1)+' MB';
function date(value:string,full=false){
  const d=new Date(value);return isNaN(d.getTime())?'':d.toLocaleString(undefined,full?
    {dateStyle:'medium',timeStyle:'short'}:{month:'short',day:'numeric'});
}
function avatar(value:string){return value.split(/[\s@.]+/).filter(Boolean).slice(0,2).map(v=>v[0].toUpperCase()).join('')||'M';}
function toBase64(blob:Blob):Promise<string>{
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read this attachment.'));
    r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob);});
}
function Button({label,icon:Icon,onClick,disabled=false}:{label:string;icon:typeof Inbox;onClick:()=>void;disabled?:boolean}){
  return <button type="button" className="mail-tool" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon size={18}/></button>;
}

export default function EmailPanel({workspaceId,user}:{workspaceId:string|null;user:{email:string;email_verified:boolean}}){
  const [accounts,setAccounts]=useState<MailAccount[]>([]);
  const [accountId,setAccountId]=useState('');
  const [config,setConfig]=useState<MailConfig|null>(null);
  const [folders,setFolders]=useState<MailFolder[]>([]);
  const [folder,setFolder]=useState<FolderId>('inbox');
  const [rows,setRows]=useState<MailMessage[]>([]);
  const [selectedId,setSelectedId]=useState('');
  const [message,setMessage]=useState<MailMessage|null>(null);
  const [query,setQuery]=useState('');const [search,setSearch]=useState('');
  const [next,setNext]=useState('');const [page,setPage]=useState('');const [history,setHistory]=useState<string[]>([]);
  const [checked,setChecked]=useState<Set<string>>(new Set());
  const [unreadOnly,setUnreadOnly]=useState(false);
  const [loading,setLoading]=useState(false);const [reading,setReading]=useState(false);
  const [initializing,setInitializing]=useState(true);const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [manager,setManager]=useState(false);const [folderMenu,setFolderMenu]=useState(false);
  const [version,setVersion]=useState(0);const [editor,setEditor]=useState<Editor|null>(null);
  const [composeError,setComposeError]=useState('');const [composeNotice,setComposeNotice]=useState('');
  const [editingBusy,setEditingBusy]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null);const dialog=useRef<HTMLDivElement>(null);
  const account=accounts.find(a=>a.id===accountId);
  const currentAccount=useRef(accountId);currentAccount.current=accountId;
  const folderLabel=FOLDERS.find(f=>f.id===folder)?.label||'Inbox';
  const refresh=()=>{setError('');setVersion(v=>v+1);};

  useEffect(()=>{
    const controller=new AbortController();
    setInitializing(true);
    Promise.all([mailApi.accounts(controller.signal),mailApi.config(controller.signal)]).then(([a,c])=>{
      if(controller.signal.aborted)return;
      setAccounts(a);setConfig(c);setAccountId(a[0]?.id||'');
    }).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));})
      .finally(()=>{if(!controller.signal.aborted)setInitializing(false);});
    const params=new URLSearchParams(location.search);
    if(params.get('mail')==='connected')setNotice('Mailbox connected. Your latest messages are available.');
    if(params.get('mail')==='error')setError(params.get('mail_reason')||'Mailbox connection failed.');
    if(params.has('mail')){params.delete('mail');params.delete('mail_reason');historyReplace(params);}
    return()=>controller.abort();
  },[workspaceId]);
  useEffect(()=>{
    if(!accountId)return;
    const controller=new AbortController();
    setLoading(true);setRows([]);setChecked(new Set());setSelectedId('');setMessage(null);
    mailApi.messages(accountId,folder,search,page,controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      setRows(result.results);setNext(result.next_cursor);
    }).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    mailApi.folders(accountId,controller.signal).then(value=>{if(!controller.signal.aborted)setFolders(value);}).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
    return()=>controller.abort();
  },[accountId,folder,search,page,version]);
  useEffect(()=>{
    if(!accountId||!selectedId){setMessage(null);setReading(false);return;}
    const controller=new AbortController();setReading(true);setMessage(null);
    mailApi.detail(accountId,selectedId,folder,controller.signal).then(detail=>{
      if(controller.signal.aborted)return;
      setMessage(detail);
      if(!detail.is_read&&detail.folder!=='drafts'){
        void mailApi.action(accountId,selectedId,'read').then(()=>{
          if(controller.signal.aborted)return;
          setRows(r=>r.map(m=>m.id===selectedId?{...m,is_read:true}:m));
          setMessage(m=>m?{...m,is_read:true}:m);
          void mailApi.folders(accountId,controller.signal).then(value=>{if(!controller.signal.aborted)setFolders(value);}).catch(()=>{});
        }).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
      }
    }).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));})
      .finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return()=>controller.abort();
  },[accountId,selectedId,folder]);
  useEffect(()=>{
    // Only refresh the first page automatically; provider page cursors may
    // shift when new messages arrive. Never interrupt composition or actions.
    if(!accountId||editor||busy||loading||reading||page)return;
    const controller=new AbortController();
    let inFlight=false;
    let lastStarted=0;
    async function sync(){
      if(document.hidden||controller.signal.aborted||inFlight||Date.now()-lastStarted<5000)return;
      inFlight=true;lastStarted=Date.now();
      try{
        const results=await Promise.allSettled([
          mailApi.messages(accountId,folder,search,'',controller.signal),
          mailApi.folders(accountId,controller.signal),
        ]);
        if(controller.signal.aborted)return;
        const [messagesResult,foldersResult]=results;
        if(messagesResult.status==='fulfilled'){
          const result=messagesResult.value;
          setRows(result.results);setNext(result.next_cursor);
          const visible=new Set(result.results.map(row=>row.id));
          setChecked(old=>new Set([...old].filter(id=>visible.has(id))));
        }else setError(errorText(messagesResult.reason));
        if(foldersResult.status==='fulfilled')setFolders(foldersResult.value);
      }finally{inFlight=false;}
    }
    const trigger=()=>{void sync();};
    const timer=setInterval(trigger,60_000);
    window.addEventListener('focus',trigger);
    window.addEventListener('online',trigger);
    document.addEventListener('visibilitychange',trigger);
    return()=>{
      clearInterval(timer);controller.abort();
      window.removeEventListener('focus',trigger);
      window.removeEventListener('online',trigger);
      document.removeEventListener('visibilitychange',trigger);
    };
  },[accountId,folder,search,page,version,Boolean(editor),busy,loading,reading]);
  useEffect(()=>{
    if(!editor&&!manager)return;
    const el=dialog.current;
    const focus=el?.querySelector<HTMLElement>('input,button,select,textarea');focus?.focus();
    function trap(e:KeyboardEvent){
      if(e.key!=='Tab'||!el)return;
      const nodes=Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]'));
      const first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }
    document.addEventListener('keydown',trap);return()=>document.removeEventListener('keydown',trap);
  },[Boolean(editor),manager]);

  function chooseFolder(value:FolderId){setUnreadOnly(false);setFolder(value);setPage('');setHistory([]);setFolderMenu(false);}
  function chooseAccount(value:string){
    if(editor&&!window.confirm('Close this compose window? Save a draft first to keep your edits.'))return;
    setUnreadOnly(false);setEditor(null);setAccountId(value);setFolders([]);setFolder('inbox');setSearch('');setQuery('');setPage('');setHistory([]);
  }
  async function connect(provider:'gmail'|'outlook'){
    setBusy(true);setError('');
    try{const result=await mailApi.connect(provider);location.assign(result.authorization_url);}
    catch(e){setError(errorText(e));setBusy(false);}
  }
  async function createLocal(){
    setBusy(true);setError('');
    try{const a=await mailApi.local();setAccounts(await mailApi.accounts());chooseAccount(a.id);setManager(false);setNotice('Local workspace mailbox created. Send to yourself or another connected local mailbox in this workspace.');}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function disconnect(a:MailAccount){
    if(!window.confirm('Disconnect '+a.email+'? Local mailbox messages will be deleted. Provider emails stay in the provider mailbox.'))return;
    setBusy(true);
    try{await mailApi.disconnect(a.id);const list=await mailApi.accounts();setAccounts(list);if(accountId===a.id)chooseAccount(list[0]?.id||'');}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function action(kind:string,ids:string[]=selectedId?[selectedId]:[]){
    if(!accountId||!ids.length)return;
    const original=accountId;setBusy(true);setError('');
    try{for(const id of ids)await mailApi.action(original,id,kind);if(currentAccount.current===original){setNotice(ids.length===1?'Message updated.':String(ids.length)+' messages updated.');refresh();}}
    catch(e){if(currentAccount.current===original){setError(errorText(e));setVersion(v=>v+1);}}
    finally{setBusy(false);}
  }
  async function filesFromMessage(m:MailMessage):Promise<UploadFile[]>{
    const files:UploadFile[]=[];
    for(const f of m.attachments||[]){
      if(f.size>5*1024*1024||files.reduce((n,a)=>n+(a.size||0),0)+f.size>10*1024*1024)
        throw new Error('One or more original attachments exceed this composer’s limits. Download them separately and attach supported files.');
      const response=await fetch(attachmentUrl(accountId,m.id,f.id),{credentials:'same-origin'});
      if(!response.ok)throw new Error('An original attachment could not be loaded. Refresh and try again.');
      const blob=await response.blob();files.push({name:f.name,content_type:f.content_type,data:await toBase64(blob),size:blob.size});
    }
    return files;
  }
  function newMessage(){
    if(editor&&!window.confirm('Replace your current compose window? Save a draft first to keep your edits.'))return;
    setEditor(fresh());setComposeError('');setComposeNotice('');
  }
  async function startReply(mode:ComposePayload['mode']){
    if(!message||!account)return;
    if(editor&&!window.confirm('Replace your current compose window?'))return;
    setBusy(true);setError('');
    try{
      const m=message;const e=fresh();e.mode=mode;e.reply_id=m.id;
      if(m.folder==='drafts'){
        Object.assign(e,{to:m.to.join(', '),cc:m.cc.join(', '),bcc:m.bcc.join(', '),subject:m.subject,body:m.body||'',
          draft_id:m.id,reply_id:'',mode:'new',attachments:await filesFromMessage(m)});
      }else{
        const own=account.email.toLowerCase();
        const recipients=m.sender.toLowerCase()===own?m.to:(m.reply_to?.length?m.reply_to:[m.sender]);
        e.to=mode==='forward'?'':Array.from(new Set(recipients.filter(v=>v.toLowerCase()!==own))).join(', ');
        if(mode==='reply_all')e.cc=Array.from(new Set([...m.to,...m.cc].filter(v=>v.toLowerCase()!==own&&!recipients.includes(v)))).join(', ');
        const prefix=mode==='forward'?'Fw: ':'Re: ';
        e.subject=/^(re|fw|fwd):/i.test(m.subject)&&mode!=='forward'?m.subject:prefix+m.subject;
        e.body='\n\n---------- '+(mode==='forward'?'Forwarded message':'Original message')+' ----------\nFrom: '+(m.sender_name||m.sender)+' <'+m.sender+'>\nDate: '+date(m.date,true)+'\nSubject: '+m.subject+'\nTo: '+m.to.join(', ')+'\n\n'+(m.body||'');
        if(mode==='forward')e.attachments=await filesFromMessage(m);
      }
      setEditor(e);setComposeError('');setComposeNotice('');
    }catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function addFiles(list:FileList|null){
    if(!list||!editor)return;
    setEditingBusy(true);setComposeError('');
    try{
      const all=[...editor.attachments];
      if(all.length+list.length>20)throw new Error('Maximum 20 attachments.');
      for(const file of Array.from(list)){
        if(file.size>5*1024*1024)throw new Error(file.name+' exceeds the 5 MB per-file limit.');
        if(all.reduce((n,f)=>n+(f.size||0),0)+file.size>10*1024*1024)throw new Error('Attachments exceed 10 MB combined.');
        all.push({name:file.name,content_type:file.type||'application/octet-stream',size:file.size,data:await toBase64(file)});
      }
      setEditor(e=>e?{...e,attachments:all}:e);
    }catch(e){setComposeError(errorText(e));}finally{setEditingBusy(false);if(fileInput.current)fileInput.current.value='';}
  }
  function payload(e:Editor):ComposePayload{
    return {to:split(e.to),cc:split(e.cc),bcc:split(e.bcc),subject:e.subject,body:e.body,attachments:e.attachments,
      draft_id:e.draft_id,reply_id:e.reply_id,mode:e.mode};
  }
  async function saveDraft(){
    if(!editor||!accountId||editor.uncertain)return;
    setEditingBusy(true);setComposeError('');setComposeNotice('');
    try{const result=await mailApi.draft(accountId,payload(editor));setEditor(e=>e?{...e,draft_id:result.draft_id,key:crypto.randomUUID()}:e);setComposeNotice('Draft saved to this mailbox.');setVersion(v=>v+1);}
    catch(e){setComposeError(errorText(e));}finally{setEditingBusy(false);}
  }
  async function send(e:FormEvent){
    e.preventDefault();if(!editor||!accountId||editor.uncertain)return;
    const p=payload(editor);if(!p.to.length&&!p.cc.length&&!p.bcc.length){setComposeError('Add at least one recipient.');return;}
    setEditingBusy(true);setComposeError('');setComposeNotice('');
    try{
      const result=await mailApi.send(accountId,p,editor.key);
      if(result.status==='uncertain'){
        setEditor(current=>current?{...current,uncertain:true,draft_id:result.draft_id||current.draft_id}:current);
        setComposeError(result.detail||'Send status is uncertain. Check Sent in the provider mailbox before sending another copy.');
      }else if(result.status==='sent'){
        setEditor(null);setNotice('Message sent.');setVersion(v=>v+1);
      }else{
        setEditor(current=>current?{...current,draft_id:result.draft_id||current.draft_id,key:crypto.randomUUID()}:current);
        setComposeError(result.detail||'The provider rejected this send. Review the draft before retrying.');
      }
    }catch(err){
      if(err instanceof MailApiError){
        const rejected=err.payload.status==='failed';const draft=typeof err.payload.draft_id==='string'?err.payload.draft_id:'';
        setEditor(current=>current?{...current,draft_id:draft||current.draft_id,key:rejected?crypto.randomUUID():current.key}:current);
      }else{
        // A lost response may hide a successful send. Freeze the editor; never generate a new send key automatically.
        setEditor(current=>current?{...current,uncertain:true}:current);
      }
      setComposeError(errorText(err));
    }finally{setEditingBusy(false);}
  }
  async function discard(){
    if(!editor||!window.confirm('Discard this draft and close the compose window?'))return;
    setEditingBusy(true);
    try{if(editor.draft_id&&!editor.uncertain)await mailApi.discard(accountId,editor.draft_id);setEditor(null);setVersion(v=>v+1);}
    catch(e){setComposeError(errorText(e));}finally{setEditingBusy(false);}
  }
  function closeEditor(){
    if(editingBusy)return;
    if(editor&&!editor.uncertain&&!window.confirm('Close compose? Unsaved edits will be lost. Use Save draft to keep them.'))return;
    setEditor(null);
  }
  const selected=message;const canAct=Boolean(selected&&!busy&&selected.folder!=='drafts');
  const visibleRows=unreadOnly?rows.filter(row=>!row.is_read):rows;
  const actionIds=checked.size?Array.from(checked):selectedId?[selectedId]:[];
  const canToolbarAct=Boolean(account&&!busy&&!loading&&!reading&&folder!=='drafts'&&actionIds.length);
  const readAction=checked.size?'read':selected?.is_read?'unread':'read';

  return <section className="email-shell">
    <div className="email-heading"><div className="email-title"><Mail size={21}/><h1>Mail</h1><span className="email-home-label">Home</span></div>
      <form className="email-search" onSubmit={e=>{e.preventDefault();setSearch(query.trim());setPage('');setHistory([]);}}>
        <Search size={18}/><input aria-label="Search mailbox" placeholder={'Search '+folderLabel.toLowerCase()} maxLength={200} value={query} onChange={e=>setQuery(e.target.value)} disabled={!account}/>
        {query&&<button type="button" aria-label="Clear search" onClick={()=>{setQuery('');setSearch('');setPage('');setHistory([]);}}><X size={16}/></button>}
        <button type="submit" disabled={!account}>Search</button>
      </form><Button label="Manage mailboxes" icon={Settings2} onClick={()=>setManager(true)} disabled={initializing||Boolean(editor)}/></div>
    <div className="email-command-bar" role="toolbar" aria-label="Mail actions">
      <button className="mail-primary" onClick={newMessage} disabled={!account||busy||initializing}><Plus size={17}/>New Email</button>
      <span className="email-command-divider"/>
      <button disabled={!canToolbarAct} onClick={()=>void action(folder==='trash'?'restore':'trash',actionIds)}>{folder==='trash'?<Inbox size={17}/>:<Trash2 size={17}/>}<span>{folder==='trash'?'Restore':'Delete'}</span></button>
      <button disabled={!canToolbarAct} onClick={()=>void action('archive',actionIds)}><Archive size={17}/><span>Archive</span></button>
      <button disabled={!canToolbarAct} onClick={()=>void action('junk',actionIds)}><ShieldAlert size={17}/><span>Junk</span></button>
      <span className="email-command-divider"/>
      <button disabled={!canAct||checked.size>0} onClick={()=>void startReply('reply_all')} aria-label="Reply all from toolbar"><ReplyAll size={17}/><span>Reply all</span></button>
      <button disabled={!canToolbarAct} onClick={()=>void action(readAction,actionIds)}><MailOpen size={17}/><span>{readAction==='unread'?'Mark unread':'Mark read'}</span></button>
      <button className="email-command-refresh" disabled={!account||busy||loading} onClick={refresh} aria-label="Refresh mailbox"><RefreshCw size={17}/></button>
    </div>
    {error&&<div className="email-alert error" role="alert">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}
    {notice&&<div className="email-alert" role="status"><Check size={16}/>{notice}<button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={16}/></button></div>}
    {initializing?<div className="email-empty"><div className="spin"/><h2>Opening your mailboxes…</h2></div>:!account?
      <div className="email-empty"><span className="email-empty-symbol"><Mail size={38}/></span><h2>Your mail, all in one place</h2>
        <p>Connect your Gmail or Outlook account to read, organize and send email from TeamWorkspace.</p>
        <div className="email-connect-buttons"><button className="mail-primary" onClick={()=>setManager(true)}><Plus size={17}/> Add mailbox</button></div>
        {config?.local_enabled&&<p className="email-local-note">For local development, add a workspace mailbox. It delivers to connected local mailboxes in this company.</p>}
      </div>:
      <div className={'email-layout'+(selectedId?' has-reading':'')}>
        <aside className={'email-folders'+(folderMenu?' is-open':'')}>
          <div className="email-folder-section-title"><ChevronDown size={13}/>Favourites</div>
          <nav className="email-favourites" aria-label="Favourite folders">{FOLDERS.filter(f=>['inbox','sent','drafts'].includes(f.id)).map(f=><button key={f.id} aria-label={'Favourite '+f.label} className={folder===f.id?'active':''} onClick={()=>chooseFolder(f.id)}><f.icon size={17}/><span>{f.label}</span></button>)}</nav>
          <div className="email-folder-section-title email-mailbox-title"><ChevronDown size={13}/>Your mailboxes</div>
          <label className="email-account-label" htmlFor="mailbox-select">MAILBOX</label>
          <select id="mailbox-select" value={accountId} onChange={e=>chooseAccount(e.target.value)} disabled={busy||editingBusy}>
            {accounts.map(a=><option key={a.id} value={a.id}>{a.email+' · '+a.provider}</option>)}
          </select>
          <nav aria-label="Mail folders">{FOLDERS.map(f=>{const count=folders.find(r=>r.id===f.id);return <button key={f.id} className={folder===f.id?'active':''} onClick={()=>chooseFolder(f.id)}>
            <f.icon size={18}/><span>{f.label}</span>{Boolean(count?.unread)&&<strong>{count?.unread}</strong>}
          </button>;})}</nav>
          <div className="email-mailbox-footer"><span className={'email-provider-dot '+account.provider}/><strong>{account.provider==='local'?'Local workspace mail':account.provider==='gmail'?'Gmail connected':'Outlook connected'}</strong>
            <p>{account.provider==='local'?'Delivery stays inside this company workspace.':'The first page refreshes every minute and when you return to this tab. Use Refresh to check now.'}</p></div>
        </aside>
        <section className="email-list" aria-label="Email messages">
          <div className="email-list-heading"><button className="email-mobile-folders" aria-label="Choose mail folder" onClick={()=>setFolderMenu(v=>!v)}><Folder size={18}/><ChevronDown size={14}/></button>
            <div><h2>{folderLabel}</h2><span>{search?'Results for “'+search+'”':account.email}</span></div>
          </div>
          <div className="email-list-tools">
            <label><input type="checkbox" aria-label="Select all messages on this page" checked={visibleRows.length>0&&visibleRows.every(m=>checked.has(m.id))}
              onChange={e=>setChecked(e.target.checked?new Set(visibleRows.map(m=>m.id)):new Set())}/></label>
            <div className="email-list-tabs" aria-label="Message filter">
              <button aria-pressed={!unreadOnly} onClick={()=>{setUnreadOnly(false);setChecked(new Set());}}>All mail</button>
              <button aria-pressed={unreadOnly} title="Show unread messages on this page" onClick={()=>{setUnreadOnly(true);setChecked(new Set());}}>Unread</button>
            </div>
            {checked.size>0&&<span className="email-selection-count">{checked.size} selected</span>}
          </div>
          <div className="email-message-scroll">
            {loading?<div className="email-list-empty"><div className="spin"/><p>Loading messages…</p></div>:visibleRows.length===0?
              <div className="email-list-empty"><Inbox size={32}/><h3>{search?'No matching emails':unreadOnly?'No unread messages':'You’re all caught up'}</h3><p>{search?'Try another search or folder.':unreadOnly?'There are no unread messages on this page.':folder==='drafts'?'Saved drafts will appear here.':'Messages in this folder will appear here.'}</p></div>:
              visibleRows.map(m=><div key={m.id} className={'email-row'+(!m.is_read?' unread':'')+(selectedId===m.id?' selected':'')}>
                <input type="checkbox" aria-label={'Select '+(m.subject||'untitled message')} checked={checked.has(m.id)} onChange={e=>setChecked(old=>{const nextSet=new Set(old);e.target.checked?nextSet.add(m.id):nextSet.delete(m.id);return nextSet;})}/>
                <span className="email-row-avatar" aria-hidden="true">{avatar(m.sender_name||m.sender)}</span>
                <button className="email-row-main" onClick={()=>setSelectedId(m.id)}>
                  <span className="email-row-top"><strong>{folder==='sent'||folder==='drafts'?'To: '+(m.to.join(', ')||'(No recipients)'):m.sender_name||m.sender}</strong><time>{date(m.date)}</time></span>
                  <span className="email-row-subject">{m.subject||'(No subject)'}{m.has_attachments&&<Paperclip size={13}/>}</span>
                  <span className="email-row-preview">{m.preview||'No preview'}</span>
                </button>
                {folder!=='drafts'&&<button className={'email-row-star'+(m.is_starred?' starred':'')} aria-label={m.is_starred?'Remove star':'Star message'} disabled={busy} onClick={()=>void action(m.is_starred?'unstar':'star',[m.id])}><Star size={15} fill={m.is_starred?'currentColor':'none'}/></button>}
              </div>)}
          </div>
          <div className="email-pagination"><span>{visibleRows.length} on this page</span><div>
            <Button label="Previous page" icon={ArrowLeft} disabled={!history.length||loading} onClick={()=>{setPage(history[history.length-1]);setHistory(h=>h.slice(0,-1));}}/>
            <Button label="Next page" icon={ArrowRight} disabled={!next||loading} onClick={()=>{setHistory(h=>[...h,page]);setPage(next);}}/></div></div>
        </section>
        <section className="email-reading" aria-label="Reading pane">
          {selectedId&&<div className="email-reading-tools">
            <button className="email-mobile-back" onClick={()=>setSelectedId('')}><ArrowLeft size={18}/>Back</button>
            <span className="email-reading-label">{selected?.folder==='drafts'?'DRAFT':'MESSAGE'}</span>
            {selected?.folder==='drafts'?<button className="mail-secondary" disabled={busy} onClick={()=>void startReply('new')}><FileText size={16}/>Edit draft</button>:
              <Button label={selected?.is_starred?'Remove star':'Star'} icon={Star} disabled={!canAct} onClick={()=>void action(selected?.is_starred?'unstar':'star')}/>}
          </div>}
          {reading?<div className="email-empty"><div className="spin"/><p>Opening message…</p></div>:!selected?
            <div className="email-empty email-reading-empty"><span className="email-reading-illustration"><MailOpen size={44}/></span><h2>Select a message to read</h2><p>Your next conversation starts here.</p></div>:
            <div className="email-reading-content"><h2>{selected.subject||'(No subject)'}</h2>
              <div className="email-sender"><span className="email-avatar">{avatar(selected.sender_name||selected.sender)}</span><div><strong>{selected.sender_name||selected.sender}</strong><small>{selected.sender}</small></div><time>{date(selected.date,true)}</time></div>
              <div className="email-recipient-line"><b>To:</b> {selected.to.join(', ')||'Undisclosed recipients'}</div>
              {selected.cc.length>0&&<div className="email-recipient-line"><b>Cc:</b> {selected.cc.join(', ')}</div>}
              {selected.bcc.length>0&&<div className="email-recipient-line"><b>Bcc:</b> {selected.bcc.join(', ')}</div>}
              {Boolean(selected.attachments?.length)&&<div className="email-attachments">{selected.attachments?.map(f=>
                <a key={f.id} href={attachmentUrl(accountId,selected.id,f.id)} download={f.name}><Paperclip size={17}/><span><strong>{f.name}</strong><small>{bytes(f.size)}</small></span><Download size={16}/></a>)}</div>}
              <div className="email-body">{selected.body||'(This message has no text content.)'}</div>
              {selected.folder!=='drafts'&&<div className="email-reply-actions"><button className="mail-secondary" disabled={busy} onClick={()=>void startReply('reply')}><Reply size={17}/>Reply</button>
                <button className="mail-secondary" disabled={busy} onClick={()=>void startReply('reply_all')}><ReplyAll size={17}/>Reply all</button>
                <button className="mail-secondary" disabled={busy} onClick={()=>void startReply('forward')}><Forward size={17}/>Forward</button></div>}
            </div>}
        </section>
      </div>}
    {manager&&<div className="email-dialog-shade"><div className="email-account-dialog" role="dialog" aria-modal="true" aria-labelledby="mail-accounts-title" ref={dialog}>
      <header><div><span className="email-eyebrow">MAIL SETTINGS</span><h2 id="mail-accounts-title">Your mailboxes</h2></div><Button label="Close mailbox settings" icon={X} disabled={busy} onClick={()=>setManager(false)}/></header>
      <p>Mailbox connections belong to your account in this workspace. Other employees have their own connections.</p>
      {error&&<div className="email-compose-alert" role="alert">{error}</div>}
      {accounts.map(a=><div className="email-connected-account" key={a.id}><Mail size={20}/><div><strong>{a.email}</strong><small>{a.provider==='local'?'Local workspace mailbox':a.provider}{a.needs_reconnect?' · Reconnect required':''}</small></div><button disabled={busy} onClick={()=>void disconnect(a)}>Disconnect</button></div>)}
      <div className="email-provider-options">
        <button disabled={busy||!config?.gmail_configured||!user.email_verified} onClick={()=>void connect('gmail')}><span className="email-provider-logo google">G</span><span><strong>Connect Gmail</strong><small>{!config?.gmail_configured?'Provider setup required':!user.email_verified?'Verify your TeamWorkspace email first':'Sign in securely with Google'}</small></span><Plus size={18}/></button>
        <button disabled={busy||!config?.outlook_configured||!user.email_verified} onClick={()=>void connect('outlook')}><span className="email-provider-logo microsoft">O</span><span><strong>Connect Outlook</strong><small>{!config?.outlook_configured?'Provider setup required':!user.email_verified?'Verify your TeamWorkspace email first':'Microsoft 365 or Outlook.com'}</small></span><Plus size={18}/></button>
        {config?.local_enabled&&<button disabled={busy||accounts.some(a=>a.provider==='local')} onClick={()=>void createLocal()}><span className="email-provider-logo local"><Mail size={23}/></span><span><strong>Add local workspace mailbox</strong><small>{user.email} · delivers inside this company</small></span><Plus size={18}/></button>}
      </div><p className="email-account-footnote">Your administrator can enable Gmail and Outlook connections. Disconnecting here removes this app’s stored credentials; you can also revoke access in your Google or Microsoft account.</p>
    </div></div>}
    {editor&&<div className="email-dialog-shade"><div className="email-compose" role="dialog" aria-modal="true" aria-labelledby="mail-compose-title" ref={dialog}>
      <header><div><h2 id="mail-compose-title">{editor.mode==='new'?'New Email':editor.mode==='forward'?'Forward message':'Reply'}</h2><small>From {account?.email}</small></div><Button label="Close compose" icon={X} disabled={editingBusy} onClick={closeEditor}/></header>
      <form onSubmit={e=>void send(e)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();if(!editingBusy&&!editor.uncertain)e.currentTarget.requestSubmit();}}}>
        <fieldset disabled={editingBusy||editor.uncertain}>
          {(['to','cc','bcc'] as const).map(field=><label className="email-compose-field" key={field}><span>{field==='to'?'To':field==='cc'?'Cc':'Bcc'}</span>
            <input aria-label={field==='to'?'To recipients':field==='cc'?'Cc recipients':'Bcc recipients'} placeholder={field==='to'?'name@example.com, another@example.com':''} value={editor[field]} maxLength={15_000} onChange={e=>setEditor(v=>v?{...v,[field]:e.target.value}:v)}/></label>)}
          <label className="email-compose-field"><span>Subject</span><input aria-label="Subject" value={editor.subject} maxLength={255} onChange={e=>setEditor(v=>v?{...v,subject:e.target.value}:v)}/></label>
          <textarea className="email-compose-body" aria-label="Email message body" placeholder="Write your message…" value={editor.body} maxLength={200_000} onChange={e=>setEditor(v=>v?{...v,body:e.target.value}:v)}/>
          {editor.attachments.length>0&&<div className="email-compose-files">{editor.attachments.map((f,i)=><span key={i}><Paperclip size={14}/>{f.name} <small>{bytes(f.size||0)}</small><button type="button" aria-label={'Remove '+f.name} onClick={()=>setEditor(v=>v?{...v,attachments:v.attachments.filter((_,n)=>n!==i)}:v)}><X size={14}/></button></span>)}</div>}
        </fieldset>
        {composeError&&<div className="email-compose-alert" role="alert">{composeError}</div>}
        {composeNotice&&<div className="email-compose-saved" role="status"><Check size={14}/>{composeNotice}</div>}
        <footer><button type="submit" className="mail-primary" disabled={editingBusy||editor.uncertain}><Send size={17}/>{editingBusy?'Working…':'Send'}</button>
          <button type="button" className="mail-secondary" disabled={editingBusy||editor.uncertain} onClick={()=>void saveDraft()}>Save draft</button>
          <Button label="Attach files" icon={Paperclip} disabled={editingBusy||editor.uncertain} onClick={()=>fileInput.current?.click()}/>
          <input type="file" multiple ref={fileInput} hidden onChange={e=>void addFiles(e.target.files)}/>
          <span className="email-compose-limit">5 MB/file · 10 MB total</span>
          <Button label={editor.uncertain?'Close compose':'Discard draft'} icon={Trash2} disabled={editingBusy} onClick={()=>editor.uncertain?closeEditor():void discard()}/>
        </footer>
      </form>
    </div></div>}
  </section>;
}

function historyReplace(params:URLSearchParams){
  const query=params.toString();window.history.replaceState({},'',location.pathname+(query?'?'+query:'')+location.hash);
}

