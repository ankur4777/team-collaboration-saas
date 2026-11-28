import {useEffect,useState,type FormEvent} from 'react';
import {api,type CompanyUsage,type RevenueReport} from './api';
import './PlatformAdmin.css';

const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';
const today=()=>new Date().toISOString().slice(0,10);
const yearStart=()=>today().slice(0,4)+'-01-01';

export function CompanyUsagePanel({companyId}:{companyId:string}){
  const [usage,setUsage]=useState<CompanyUsage|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0),[days,setDays]=useState(30),[trend,setTrend]=useState<'messages'|'meetings'|'files'>('messages');
  useEffect(()=>{let active=true;setError('');setUsage(null);api.companyUsage(companyId,days).then(r=>{if(active)setUsage(r);}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[companyId,version,days]);
  const groups=usage?[
    {title:'Employees & presence',metrics:[['Employees',usage.members],['Active accounts',usage.active_accounts??'—'],['Inactive accounts',usage.inactive_accounts??'—'],['Seen in last '+usage.window_days+' days',usage.recent_members],['Online (90 seconds)',usage.online_members]]},
    {title:'Collaboration',metrics:[['Teams',usage.teams],['Channels',usage.channels],['Conversations',usage.conversations],['Channel messages',usage.channel_messages],['Chat messages',usage.chat_messages],['Messages in selected period',usage.recent_messages],['Meetings',usage.meetings],['Meetings created in selected period',usage.recent_meetings]]},
    {title:'Files & storage',metrics:[['Shared files',usage.shared_files],['Attachments',usage.attachments],['Files added in selected period',usage.recent_files??'—'],['Logical storage (MiB)',(usage.storage_bytes/1048576).toFixed(2)]]},
  ]:[];
  const daily=usage?.daily||[];
  const counts=daily.map(r=>trend==='messages'?r.channel_messages+r.chat_messages:trend==='meetings'?r.meetings:r.shared_files+r.attachments);
  const max=Math.max(1,...counts);
  function download(){
    if(!usage)return;
    const csv=[['Company ID',usage.company_id],['Snapshot',usage.as_of],['Window days',String(usage.window_days)],['Timezone',usage.timezone||''],['Window start',usage.window_start||''],['Metric','Value'],...groups.flatMap(g=>g.metrics.map(([label,value])=>[String(label),String(value)])),[],['Date','Channel messages','Chat messages','Meetings created','Shared files added','Attachments added'],...daily.map(r=>[r.date,r.channel_messages,r.chat_messages,r.meetings,r.shared_files,r.attachments].map(String))].map(row=>row.map(v=>'"'+v.replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}));
    const link=document.createElement('a');link.href=url;link.download='company-usage-'+usage.window_days+'-days.csv';document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="pa-report-panel"><div className="pa-report-head"><h3>Company usage analytics</h3><div className="pa-heading-actions"><button type="button" className="outline-button" onClick={()=>setVersion(v=>v+1)}>Refresh</button><button type="button" className="outline-button" disabled={!usage} onClick={download}>Download CSV</button></div></div>
  <div className="pa-report-filters"><label>Activity period<select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label></div>
  <p className="pa-renewal-description">Retained record totals and recent presence heartbeats. The period affects recent activity only, not lifetime retained totals or current storage. Private conversation and file contents are never included.</p>
  {error&&<p role="alert" className="pa-error">{error}</p>}{!error&&!usage&&<p role="status">Loading usage…</p>}
  {groups.map(group=><section key={group.title}><h3>{group.title}</h3><div className="pa-metric-grid">{group.metrics.map(([label,value])=><div className="pa-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section>)}
  {usage&&<><section className="pa-report-panel"><div className="pa-report-head"><h3>Daily activity</h3><select aria-label="Activity metric" value={trend} onChange={e=>setTrend(e.target.value as typeof trend)}><option value="messages">Messages</option><option value="meetings">Meetings created</option><option value="files">Files added</option></select></div><p className="pa-renewal-description">Daily totals in {usage.timezone||'server timezone'}; first and last dates may be partial. Deleted records are not counted.</p>
  {!daily.length?<p>No daily data available.</p>:<div style={{maxHeight:340,overflowY:'auto'}}>{daily.map((r,i)=><div key={r.date} className="pa-revenue-bar" style={{gridTemplateColumns:'88px 1fr minmax(35px,auto)'}}><span>{r.date}</span><div aria-hidden="true"><i style={{width:(counts[i]/max*100)+'%'}}/></div><strong>{counts[i]}</strong></div>)}</div>}</section>
  <small>Snapshot: {new Date(usage.as_of).toLocaleString()}</small></>}</section>;
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
