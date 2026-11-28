import {useEffect,useState,type FormEvent} from 'react';
import {api,type CompanyUsage,type RevenueReport} from './api';
import './PlatformAdmin.css';
import {CompanyUserFilter,csvCell} from './ProviderDirectory';

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
  const [start,setStart]=useState(yearStart),[end,setEnd]=useState(today),[company,setCompany]=useState(''),[filterCurrency,setFilterCurrency]=useState('');
  const [range,setRange]=useState({start:yearStart(),end:today(),company:'',currency:''}),[data,setData]=useState<RevenueReport|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[currency,setCurrency]=useState('');
  useEffect(()=>{let active=true;setLoading(true);setError('');setData(null);api.revenueReport(range.start,range.end,range.company,range.currency).then(r=>{if(active){setData(r);setCurrency(old=>r.totals.some(t=>t.currency===old)?old:r.totals[0]?.currency||'');}}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[range]);
  function search(e:FormEvent){e.preventDefault();setRange({start,end,company,currency:filterCurrency});}
  const monthly=new Map<string,{month:string;received:string;billed:string}>();
  for(const row of data?.monthly||[])if(row.currency===currency)monthly.set(row.month,{month:row.month,received:row.received,billed:'0.00'});
  for(const row of data?.billed_monthly||[])if(row.currency===currency){const previous=monthly.get(row.month);monthly.set(row.month,{month:row.month,received:previous?.received||'0.00',billed:row.billed});}
  const months=[...monthly.values()].sort((a,b)=>a.month.localeCompare(b.month));
  const max=Math.max(1,...months.flatMap(r=>[Number(r.received),Number(r.billed)]));
  const selectedTotal=data?.totals.find(t=>t.currency===currency);
  const balances=data?.company_balances||[];
  function download(){
    if(!data)return;
    const rows=[['Revenue report'],['From',data.start,'To',data.end],['Balances as of',data.as_of],['Company',data.company_name||'All companies'],['Currency',data.currency||'All currencies'],['Company balances truncated',data.balances_truncated?'Yes (500 rows)':'No'],[],
      ['Currency','Billed (period)','Received (period)','Outstanding (current)','Overdue (current)'],...data.totals.map(t=>[t.currency,t.billed,t.received,t.outstanding,t.overdue]),[],
      ['Month','Currency','Billed'],...(data.billed_monthly||[]).map(r=>[r.month,r.currency,r.billed]),[],['Month','Currency','Received'],...data.monthly.map(r=>[r.month,r.currency,r.received]),[],
      ['Company ID','Company','Currency','Billed','Received','Outstanding','Overdue'],...balances.map(r=>[r.company_id,r.company,r.currency,r.billed,r.received,r.outstanding,r.overdue])];
    const csv=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}));
    const link=document.createElement('a');link.href=url;link.download='revenue-'+data.start+'-'+data.end+'.csv';document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="pa-revenue"><div className="pa-heading"><div><div className="pa-eyebrow">PROVIDER REPORTS</div><h1>Revenue reports</h1><p>Manual invoice and received payment totals, separated by currency.</p></div><button type="button" className="primary-button" disabled={!data||loading} onClick={download}>Download CSV report</button></div>
    <CompanyUserFilter value={company} onChange={setCompany}/>
    <form className="pa-report-filters" onSubmit={search}><label>From<input type="date" required value={start} max={end} onChange={e=>setStart(e.target.value)}/></label><label>To<input type="date" required value={end} min={start} onChange={e=>setEnd(e.target.value)}/></label><label>Currency filter<select value={filterCurrency} onChange={e=>setFilterCurrency(e.target.value)}><option value="">All currencies</option>{['INR','CAD','AUD','USD','GBP','EUR'].map(c=><option key={c}>{c}</option>)}</select></label><button className="primary-button" disabled={loading}>Apply / refresh</button></form>
    {error&&<p role="alert" className="pa-error">{error}</p>}{loading&&<p role="status">Loading report…</p>}
    {data&&<><p className="pa-info">Showing {data.company_name||'all companies'} · {data.currency||'all currencies'} · {data.start} to {data.end}. Billed by issue date; received by payment date. Outstanding and overdue are current balances as of {data.as_of}, not restricted to this date range. Void invoices excluded. No currency conversion.</p>
      <div className="pa-report-head"><h2>Financial summary</h2><select aria-label="Report currency" value={currency} onChange={e=>setCurrency(e.target.value)}>{data.totals.map(t=><option key={t.currency}>{t.currency}</option>)}</select></div>
      {selectedTotal&&<div className="pa-metric-grid">{[['Billed (period)',selectedTotal.billed],['Received (period)',selectedTotal.received],['Outstanding (current)',selectedTotal.outstanding],['Overdue (current)',selectedTotal.overdue]].map(([label,value])=><div key={label} className="pa-stat"><span>{label}</span><strong>{currency} {value}</strong></div>)}</div>}
      <div className="pa-table-card pa-table-scroll"><table><thead><tr><th>Currency</th><th>Billed (period)</th><th>Received (period)</th><th>Outstanding (current)</th><th>Overdue (current)</th></tr></thead><tbody>{data.totals.map(t=><tr key={t.currency}><td>{t.currency}</td><td>{t.billed}</td><td>{t.received}</td><td>{t.outstanding}</td><td>{t.overdue}</td></tr>)}</tbody></table>{!data.totals.length&&<p className="pa-loading">No billing records for this view.</p>}</div>
      <section className="pa-report-panel"><h2>Monthly billed vs received · {currency||'No currency'}</h2>
      {!months.length&&<p>No recorded invoices or payments for this currency and period.</p>}{months.map(r=><div key={r.month}><div className="pa-revenue-bar"><span>{r.month}</span><div aria-hidden="true"><i style={{width:(Number(r.billed)/max*100)+'%',background:'#8b96a8'}}/></div><strong>Billed: {r.billed}</strong></div><div className="pa-revenue-bar"><span>Received</span><div aria-hidden="true"><i style={{width:(Number(r.received)/max*100)+'%'}}/></div><strong>{r.received}</strong></div></div>)}</section>
      <section className="pa-report-panel"><h2>Company-wise financial report</h2><p className="pa-renewal-description">{data.balances_truncated?'Showing first 500 company/currency rows; narrow the company or currency filter for more detail.':'Includes companies with invoices, payments or outstanding balances in this view.'}</p><div className="pa-table-card pa-table-scroll"><table><thead><tr><th>Company</th><th>Currency</th><th>Billed (period)</th><th>Received (period)</th><th>Outstanding (current)</th><th>Overdue (current)</th></tr></thead><tbody>{balances.map(r=><tr key={r.company_id+r.currency}><td>{r.company}</td><td>{r.currency}</td><td>{r.billed}</td><td>{r.received}</td><td>{r.outstanding}</td><td>{r.overdue}</td></tr>)}</tbody></table>{!balances.length&&<p className="pa-loading">No matching company balances.</p>}</div></section>
    </>}</div>;
}
