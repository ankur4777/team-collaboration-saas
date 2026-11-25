import {useState} from 'react';
import {ShieldCheck,RefreshCw,LogOut} from 'lucide-react';
import {api,type Session} from './api';
import './PlatformAdmin.css';
import SupportPanel from './SupportPanel';

export default function SubscriptionBlocked({session,onSession}:{session:Session;onSession:(s:Session|null)=>void}){
  const org=session.organizations.find(row=>row.id===session.active_organization_id);
  const sub=org?.subscription;
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function run(fn:()=>Promise<Session|null>){if(busy)return;setBusy(true);setError('');try{onSession(await fn());}catch(e){setError(e instanceof Error?e.message:'Request failed');}finally{setBusy(false);}}
  return <main className="pa-login"><section className="pa-login-card"><div className="pa-mark"><ShieldCheck/></div><div className="pa-eyebrow">TEAMWORKSPACE / SUBSCRIPTION</div><h1>Workspace access paused</h1><p>{org?.name} subscription is {sub?.status||'inactive'}. Contact your company administrator to restore access. Your existing workspace data has not been deleted.</p>
  {sub?.ends_on&&<p>Subscription end date: {sub.ends_on}</p>}
  {sub?.status==='scheduled'&&sub.starts_on&&<p>Subscription starts: {sub.starts_on}</p>}
  {error&&<p role="alert" className="pa-error">{error}</p>}
  <button className="primary-button" disabled={busy} onClick={()=>void run(()=>api.me())}><RefreshCw size={16}/> Check subscription again</button>
  {session.organizations.length>1&&<label>Switch workspace<select disabled={busy} value={session.active_organization_id||''} onChange={e=>void run(()=>api.activate(e.target.value))}>{session.organizations.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
  <button className="outline-button" disabled={busy} onClick={()=>void run(async()=>{await api.logout();return null;})}><LogOut size={16}/> Sign out</button>{org&&<SupportPanel key={org.id} provider={false}/>}</section></main>;
}
