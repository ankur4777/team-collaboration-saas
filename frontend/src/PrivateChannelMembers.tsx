import {useEffect,useState} from 'react';
import {api,type Person} from './api';
type Member=Pick<Person,'id'|'email'|'full_name'>;
export default function PrivateChannelMembers({id,currentUserId,canManage,onClose}:{id:string;currentUserId:string;canManage:boolean;onClose:()=>void}){
  const [rows,setRows]=useState<Member[]>([]),[email,setEmail]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;const refresh=()=>api.privateChannelMembers(id).then(data=>{if(active)setRows(data);}).catch(e=>{if(active){setRows([]);setError(String(e.message||e));}});void refresh();const timer=window.setInterval(refresh,20000);return()=>{active=false;window.clearInterval(timer);};},[id]);
  async function change(removeId?:string){
    if(busy||!canManage)return;setBusy(true);setError('');
    try{if(removeId)await api.removePrivateChannelMember(id,removeId);else{await api.addPrivateChannelMember(id,email.trim());setEmail('');}setRows(await api.privateChannelMembers(id));}
    catch(e){setError(e instanceof Error?e.message:'Could not change channel membership');}finally{setBusy(false);}
  }
  return <section className="search-message-context" aria-label="Private channel members"><div className="context-header"><strong>Private channel members</strong><button type="button" className="outline-button" onClick={onClose}>Close</button></div><p>Only invited team members can read this channel. New members cannot see earlier history.</p>{error&&<p role="alert">{error}</p>}
  {rows.map(row=><div key={row.id} className="member-row"><div><strong>{row.full_name}</strong><small>{row.email}</small></div>{canManage&&row.id!==currentUserId&&<button type="button" className="outline-button" disabled={busy} onClick={()=>{if(window.confirm('Remove this person from the private channel?'))void change(row.id);}}>Remove</button>}</div>)}
  {canManage&&<form className="quick-add" onSubmit={e=>{e.preventDefault();void change();}}><label>Invite existing team member<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button className="primary-button" disabled={busy||!email.trim()}>Add member</button></form>}</section>;
}
