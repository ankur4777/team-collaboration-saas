import {useCallback,useEffect,useRef,useState} from 'react';
import {api,type PlatformCompany} from './api';
type Pending={id:string;email:string;created_at:string;expires_at:string};
const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';
export default function CompanyAccessPanel({company,onChanged}:{company:PlatformCompany;onChanged:()=>void}){
  const [record,setRecord]=useState(company),[items,setItems]=useState<Pending[]>([]),[total,setTotal]=useState(0),[email,setEmail]=useState(company.pending_owner_email||company.contact_email||''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0);
  const reload=useCallback(async()=>{
    const run=++generation.current;setLoading(true);setError('');
    try{const [details,pending]=await Promise.all([api.platformCompany(company.id),api.companyAdminInvitations(company.id)]);if(run===generation.current){setRecord(details.company);setItems(pending.items);setTotal(pending.total);}}
    catch(e){if(run===generation.current)setError(errorText(e));}finally{if(run===generation.current)setLoading(false);}
  },[company.id]);
  useEffect(()=>{void reload();return()=>{generation.current++;};},[reload]);
  async function send(){
    if(busy||loading||!email.trim())return;
    if(items.length&&!window.confirm('Replace pending administrator setup invitations? Previous links will expire.'))return;
    setBusy(true);setError('');setNotice('');
    try{const r=await api.invitePlatformOwner(company.id,email.trim());setNotice(r.invitation_sent?'Invitation submitted to mail service.':'Invitation saved; delivery failed. Check SMTP and resend.');await reload();onChanged();}catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function revoke(row:Pending){
    if(busy||!window.confirm('Revoke the administrator invitation for '+row.email+'? The link will stop working.'))return;
    setBusy(true);setError('');setNotice('');
    try{await api.revokeCompanyAdminInvitation(company.id,row.id);setNotice('Invitation revoked.');await reload();onChanged();}catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  return <section className="pa-access-panel"><div className="pa-report-head"><h3>Administrator access</h3><button type="button" className="outline-button" disabled={busy||loading} onClick={()=>void reload()}>Refresh</button></div>
    {error&&<p role="alert" className="pa-error">{error}</p>}{notice&&<p role="status" className="pa-info">{notice}</p>}{loading&&<p role="status" className="pa-renewal-description">Loading administrator access…</p>}
    <p className="pa-renewal-description">{record.active_admin_count??record.owner_emails.length} active administrators. Manage existing company members and additional administrator invitations in Users.</p>
    {record.owner_emails.map(address=><div key={address} className="pa-access-row"><strong>{address}</strong><span className="pa-status">Admin membership</span></div>)}
    <h3>Pending invitations</h3>
    {!loading&&!items.length&&!error&&<p className="pa-renewal-description">No pending administrator invitations.</p>}
    {items.map(row=><div className="pa-access-row" key={row.id}><div><strong>{row.email}</strong><small>Expires {new Date(row.expires_at).toLocaleString()}</small></div><button type="button" className="outline-button" disabled={busy||loading} onClick={()=>void revoke(row)}>Revoke</button></div>)}
    {total>items.length&&<p className="pa-renewal-description">Showing {items.length} of {total} pending invitations.</p>}
    {(record.active_admin_count??record.owner_emails.length)===0&&<form onSubmit={e=>{e.preventDefault();void send();}}><label>Company administrator email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label><button type="submit" className="primary-button" disabled={busy||loading||!email.trim()}>Send / resend administrator invitation</button></form>}
  </section>;
}
