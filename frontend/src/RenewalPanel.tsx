import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,type PlatformCompany,type RenewalPage,type RenewalInput} from './api';
import {renewalPreview} from './renewalPreview';

const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';

export default function RenewalPanel({company,busy,onRenewed}:{company:PlatformCompany;busy:boolean;onRenewed:(message:string)=>void}){
  const [days,setDays]=useState('30'),[custom,setCustom]=useState('30'),[note,setNote]=useState(''),[reactivate,setReactivate]=useState(false);
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[historyError,setHistoryError]=useState(''),[history,setHistory]=useState<RenewalPage|null>(null),[page,setPage]=useState(1);
  const lock=useRef(false),pending=useRef<RenewalInput|null>(null);
  const restricted=company.status==='suspended'||company.status==='cancelled';
  const count=Number(days==='custom'?custom:days);
  const preview=renewalPreview(company,count,restricted&&reactivate);
  useEffect(()=>{let active=true;setHistoryError('');setHistory(null);api.platformRenewals(company.id,page).then(r=>{if(active)setHistory(r);}).catch(e=>{if(active)setHistoryError(errorText(e));});return()=>{active=false;};},[company.id,page]);
  async function renew(e:FormEvent){
    e.preventDefault();if(lock.current||busy)return;
    const count=Number(days==='custom'?custom:days);
    if(!Number.isInteger(count)||count<1||count>3650){setError('Enter 1–3650 whole days.');return;}
    const restore=restricted&&reactivate;
    if(!window.confirm('Record this renewal and update the company validity?'+(preview?' Estimated valid through '+preview.end+'.':'')+' No payment will be collected.'))return;
    lock.current=true;setSaving(true);setError('');
    try{
      const old=pending.current;
      const cleanNote=note.trim();
      const input=old&&old.days===count&&old.reactivate===restore&&old.note===cleanNote?old:{request_id:crypto.randomUUID(),days:count,reactivate:restore,note:cleanNote};
      pending.current=input;
      const r=await api.renewPlatformCompany(company.id,input);
      onRenewed('Renewal recorded. Valid through '+r.company.ends_on+' ('+r.company.effective_status+').');
    }catch(e){setError(errorText(e));}finally{lock.current=false;setSaving(false);}
  }
  return <section className="pa-renewal"><h3>Subscription renewal</h3><p className="pa-renewal-description">Current expiry: {company.ends_on||'No end date'}. Renewals add days to the existing unexpired term, or start a fresh dated term if expired or undated. Unsaved changes above are not included.</p>
  <div className="pa-metric-grid"><div className="pa-stat"><span>Current plan</span><strong>{company.plan||'Unassigned'}</strong></div><div className="pa-stat"><span>Subscription status</span><strong>{company.effective_status}</strong></div><div className="pa-stat"><span>Employees / seats</span><strong>{company.employee_count} / {company.seat_limit??'Unlimited'}</strong></div></div>
  <form onSubmit={renew}><label>Renewal period<select value={days} disabled={saving} onChange={e=>setDays(e.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option><option value="custom">Custom days</option></select></label>
  {days==='custom'&&<label>Number of days<input type="number" min={1} max={3650} required value={custom} disabled={saving} onChange={e=>setCustom(e.target.value)}/></label>}
  <label>Renewal note (optional)<textarea maxLength={500} value={note} disabled={saving} onChange={e=>setNote(e.target.value)} placeholder="Contract or renewal reference"/></label>
  {restricted?<label className="pa-check"><input type="checkbox" checked={reactivate} disabled={saving} onChange={e=>setReactivate(e.target.checked)}/> Also reactivate this {company.status} company</label>:<p className="pa-renewal-description">Renewal sets the subscription status to Active.</p>}
  {preview&&<div className="pa-info" aria-live="polite"><strong>Estimated renewal</strong><p>Valid from {preview.start} through {preview.end} · {preview.status}</p><small>Based on the loaded company record and server date. Final validity is calculated by the server when saved. No payment is collected.</small></div>}
  {restricted&&!reactivate&&<p className="pa-info">Renewing without reactivation keeps this company blocked.</p>}
  {error&&<p className="pa-error" role="alert">{error}</p>}<button type="submit" className="primary-button" disabled={saving||busy}>{saving?'Recording renewal…':'Renew subscription'}</button></form>
  <h3>Renewal history</h3>{historyError&&<p role="alert" className="pa-error">{historyError}</p>}{!history&&!historyError&&<p role="status">Loading renewal history…</p>}{history?.items.length===0&&<p>No renewal records yet.</p>}
  {history?.items.map(row=><div key={row.id} className="pa-audit"><strong>{row.days} days · {row.previous_end||'No expiry'} → {row.new_end}</strong><small>{row.previous_status} → {row.new_status} · {row.actor}</small><small>{new Date(row.created_at).toLocaleString()}</small>{row.note&&<p className="pa-renewal-description">{row.note}</p>}</div>)}
  {history&&history.total>history.page_size&&<div className="pa-pagination"><span>Page {page}</span><button className="outline-button" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><button className="outline-button" disabled={page*history.page_size>=history.total} onClick={()=>setPage(p=>p+1)}>Next</button></div>}</section>;
}
