import {useEffect,useState,type FormEvent} from 'react';
import {api,type CompanyUsage,type RevenueReport} from './api';
import './PlatformAdmin.css';

const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';
const today=()=>new Date().toISOString().slice(0,10);
const yearStart=()=>today().slice(0,4)+'-01-01';

export function CompanyUsagePanel({companyId}:{companyId:string}){
  const [usage,setUsage]=useState<CompanyUsage|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0);
  useEffect(()=>{let active=true;setError('');setUsage(null);api.companyUsage(companyId).then(r=>{if(active)setUsage(r);}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[companyId,version]);
  const metrics=usage?[
    ['Employees',usage.members],['Seen in last 30 days',usage.recent_members],['Online (90s)',usage.online_members],
    ['Teams',usage.teams],['Channels',usage.channels],['Conversations',usage.conversations],
    ['Channel messages',usage.channel_messages],['Chat messages',usage.chat_messages],['Messages in last 30 days',usage.recent_messages],
    ['Meetings',usage.meetings],['Meetings created in last 30 days',usage.recent_meetings],
    ['Shared files',usage.shared_files],['Attachments',usage.attachments],['Logical storage (MiB)',(usage.storage_bytes/1048576).toFixed(2)],
  ]:[];
  return <section className="pa-report-panel"><div className="pa-report-head"><h3>Company usage analytics</h3><button type="button" className="outline-button" onClick={()=>setVersion(v=>v+1)}>Refresh</button></div>
  <p className="pa-renewal-description">Aggregate retained records and recent presence heartbeats. No private conversation or file contents.</p>
  {error&&<p role="alert" className="pa-error">{error}</p>}{!error&&!usage&&<p>Loading usage…</p>}
  <div className="pa-metric-grid">{metrics.map(([label,value])=><div className="pa-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
  {usage&&<small>Snapshot: {new Date(usage.as_of).toLocaleString()}</small>}</section>;
}

export function RevenuePanel(){
  const [start,setStart]=useState(yearStart),[end,setEnd]=useState(today),[range,setRange]=useState({start:yearStart(),end:today()}),[data,setData]=useState<RevenueReport|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[currency,setCurrency]=useState('');
  useEffect(()=>{let active=true;setLoading(true);setError('');setData(null);api.revenueReport(range.start,range.end).then(r=>{if(active){setData(r);setCurrency(old=>r.totals.some(t=>t.currency===old)?old:r.totals[0]?.currency||'');}}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[range]);
  function search(e:FormEvent){e.preventDefault();setRange({start,end});}
  const monthly=data?.monthly.filter(r=>r.currency===currency)||[];
  const max=Math.max(1,...monthly.map(r=>Number(r.received)));
  return <div className="pa-revenue"><div className="pa-heading"><div><div className="pa-eyebrow">PROVIDER REPORTS</div><h1>Revenue reports</h1><p>Manual invoice and received payment totals, separated by currency.</p></div></div>
    <form className="pa-report-filters" onSubmit={search}><label>From (UTC)<input type="date" required value={start} max={end} onChange={e=>setStart(e.target.value)}/></label><label>To (UTC)<input type="date" required value={end} min={start} onChange={e=>setEnd(e.target.value)}/></label><button className="primary-button" disabled={loading}>Apply / refresh</button></form>
    {error&&<p role="alert" className="pa-error">{error}</p>}{loading&&<p>Loading report…</p>}
    {data&&<><p className="pa-info">Billed by issue date; received by payment date. Outstanding and overdue are current balances as of {data.as_of}, not restricted to this date range. Void invoices excluded. No currency conversion.</p>
      <div className="pa-table-card pa-table-scroll"><table><thead><tr><th>Currency</th><th>Billed (period)</th><th>Received (period)</th><th>Outstanding (current)</th><th>Overdue (current)</th></tr></thead><tbody>{data.totals.map(t=><tr key={t.currency}><td>{t.currency}</td><td>{t.billed}</td><td>{t.received}</td><td>{t.outstanding}</td><td>{t.overdue}</td></tr>)}</tbody></table>{!data.totals.length&&<p className="pa-loading">No billing records for this view.</p>}</div>
      <section className="pa-report-panel"><div className="pa-report-head"><h2>Monthly received payments</h2><select aria-label="Report currency" value={currency} onChange={e=>setCurrency(e.target.value)}>{data.totals.map(t=><option key={t.currency}>{t.currency}</option>)}</select></div>
      {!monthly.length&&<p>No recorded payments for this currency and period.</p>}{monthly.map(r=><div key={r.month} className="pa-revenue-bar"><span>{r.month}</span><div><i style={{width:(Number(r.received)/max*100)+'%'}}/></div><strong>{r.received}</strong></div>)}</section>
      <section className="pa-report-panel"><h2>Received by company</h2><p className="pa-renewal-description">Up to {data.customers_limit} company/currency rows.</p><div className="pa-table-card pa-table-scroll"><table><thead><tr><th>Company</th><th>Currency</th><th>Received</th></tr></thead><tbody>{data.customers.map(r=><tr key={r.company_id+r.currency}><td>{r.company}</td><td>{r.currency}</td><td>{r.received}</td></tr>)}</tbody></table></div></section>
    </>}</div>;
}
