import {useEffect,useState} from 'react';
import {Building2,Users,ShieldCheck,CalendarClock,Headset,RefreshCw,Plus,ArrowUpRight,Wallet,AlertCircle} from 'lucide-react';
import {api,type PlatformOverview,type PlatformCompany,type RevenueReport} from './api';

type Destination='companies'|'users'|'subscriptions'|'support'|'revenue';
interface Props {onNavigate:(section:Destination)=>void;onNew:()=>void;onManage:(row:PlatformCompany)=>void;onRenewals:()=>void}
const number=(n:number|undefined)=>n===undefined?'—':n.toLocaleString();
const title=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const errorText=(e:unknown)=>e instanceof Error?e.message:'Could not load data';

export default function ProviderOverview({onNavigate,onNew,onManage,onRenewals}:Props){
  const [data,setData]=useState<PlatformOverview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[version,setVersion]=useState(0);
  const [revenue,setRevenue]=useState<RevenueReport|null>(null),[revenueError,setRevenueError]=useState('');
  const [currency,setCurrency]=useState('');
  useEffect(()=>{
    let active=true;setLoading(true);setError('');setRevenueError('');setRevenue(null);setData(null);
    api.platformOverview().then(row=>{
      if(!active)return;
      setData(row);setLoading(false);
      return api.revenueReport(row.today.slice(0,7)+'-01',row.today).then(report=>{
        if(active){setRevenue(report);setCurrency(old=>report.totals.some(t=>t.currency===old)?old:report.totals[0]?.currency||'');}
      }).catch(e=>{if(active)setRevenueError(errorText(e));});
    }).catch(e=>{if(active){setError(errorText(e));setLoading(false);}});
    return()=>{active=false;};
  },[version]);
  const s=data?.stats;
  const metrics=[
    {label:'Total companies',value:s?.companies,icon:Building2,target:'companies',detail:'Registered workspaces'},
    {label:'Active subscriptions',value:s?.active,icon:ShieldCheck,target:'subscriptions',detail:'Active, within license dates'},
    {label:'Employee memberships',value:s?.memberships,icon:Users,target:'users',detail:s?number(s.online_memberships)+' online in last 90 seconds':'Recent presence'},
    {label:'Renewals due',value:s?.expiring,icon:CalendarClock,target:'subscriptions',detail:'Due within next 30 days'},
    {label:'Expired subscriptions',value:s?.expired,icon:AlertCircle,target:'subscriptions',detail:'License term ended'},
    {label:'Pending support tickets',value:s?.pending_tickets,icon:Headset,target:'support',detail:'Open or in progress'},
  ] as const;
  const statuses=s?[['Active',s.active,'#23865a'],['Trial',s.trial,'#bc8122'],['Expired',s.expired,'#d83042'],['Scheduled',s.scheduled,'#5d74a5'],['Suspended',s.suspended,'#a94452'],['Cancelled',s.cancelled,'#707986'],['Unassigned',s.unassigned,'#a9b2bd']] as const:[];
  const amount=revenue?.totals.find(t=>t.currency===currency);
  return <div className="pa-overview">
    <div className="pa-heading"><div><h1>Super Admin Overview</h1><p>Monitor company accounts, subscriptions, billing and support from one place.</p></div><div className="pa-heading-actions"><button type="button" className="outline-button" disabled={loading} onClick={()=>setVersion(v=>v+1)}><RefreshCw size={15}/> Refresh</button><button type="button" className="primary-button" onClick={onNew}><Plus size={16}/> New company</button></div></div>
    <div className="pa-overview-meta" role="status">{loading?'Loading dashboard…':data?'Updated '+new Date(data.as_of).toLocaleString():'Dashboard unavailable'}</div>
    {error&&<p className="pa-error" role="alert">{error}</p>}
    <div className="pa-overview-metrics">{metrics.map(m=><button key={m.label} type="button" className="pa-stat pa-stat-link pa-overview-stat" onClick={()=>onNavigate(m.target)}><div className="pa-overview-stat-top"><span className="pa-overview-icon"><m.icon size={19}/></span><ArrowUpRight size={15}/></div><span>{m.label}</span><strong>{number(m.value)}</strong><small>{m.detail}</small></button>)}</div>
    <div className="pa-overview-grid">
      <section className="pa-table-card pa-overview-panel"><div className="pa-overview-panel-head"><div><h2>Subscription breakdown</h2><p>All company workspaces by effective license status</p></div><button className="outline-button" onClick={()=>onNavigate('subscriptions')}>View subscriptions</button></div>
        {s&&s.companies>0?<><div className="pa-overview-segments" role="img" aria-label={statuses.map(([name,count])=>name+': '+count).join(', ')}>{statuses.filter(([,count])=>count>0).map(([name,count,color])=><span key={name} style={{flexGrow:count,background:color}}/>)}</div><div className="pa-overview-legend">{statuses.map(([name,count,color])=><div key={name}><i style={{background:color}}/><span>{name}</span><strong>{number(count)}</strong></div>)}</div></>:<p className="pa-overview-empty">{s?'No companies registered yet.':loading?'Loading subscriptions…':'Subscription data unavailable.'}</p>}
      </section>
      <section className="pa-table-card pa-overview-panel"><div className="pa-overview-panel-head"><div><h2><Wallet size={18}/> Billing summary</h2><p>Recorded payments this month · current unpaid balances</p></div><button className="outline-button" onClick={()=>onNavigate('revenue')}>Revenue reports</button></div>
        {revenueError?<p role="alert" className="pa-error">{revenueError}</p>:revenue?<>{amount?<><label className="pa-overview-currency">Currency<select value={currency} onChange={e=>setCurrency(e.target.value)}>{revenue.totals.map(t=><option key={t.currency}>{t.currency}</option>)}</select></label><div className="pa-overview-money">{[['Received this month',amount.received],['Billed this month',amount.billed],['Outstanding',amount.outstanding],['Overdue',amount.overdue]].map(([label,value])=><div key={label}><span>{label}</span><strong>{currency} {value}</strong></div>)}</div></>:<p className="pa-overview-empty">No recorded invoices or payments for this view.</p>}</>:<p className="pa-overview-empty">{error?'Billing data unavailable.':'Loading billing summary…'}</p>}
      </section>
      <section className="pa-table-card pa-overview-panel pa-overview-renewals"><div className="pa-overview-panel-head"><div><h2>Upcoming renewals</h2><p>Active and trial subscriptions ending within 30 days</p></div><button className="outline-button" onClick={onRenewals}>Manage subscriptions</button></div>
      {data?.upcoming_renewals.length?<div className="pa-overview-renewal-list">{data.upcoming_renewals.map(row=><div key={row.id}><div><strong>{row.name}</strong><small>Ends {row.ends_on}</small></div><span className="pa-status trial">{row.days_remaining===0?'Ends today':row.days_remaining+' days left'}</span></div>)}</div>:<p className="pa-overview-empty">{data?'No upcoming renewals.':loading?'Loading renewals…':'Renewal data unavailable.'}</p>}
      {s&&s.expiring>5&&<small>Showing 5 of {s.expiring} upcoming renewals.</small>}
      </section>
      <section className="pa-table-card pa-overview-panel pa-overview-actions"><div className="pa-overview-panel-head"><div><h2>Quick actions</h2><p>Manage your SaaS platform</p></div></div>
      {([{label:'Create a company',icon:Plus,action:onNew},{label:'Manage company users',icon:Users,action:()=>onNavigate('users')},{label:'Manage subscriptions',icon:CalendarClock,action:onRenewals},{label:'Review support tickets',icon:Headset,action:()=>onNavigate('support')}]).map(item=><button key={item.label} className="pa-overview-action" onClick={item.action}><item.icon size={17}/><span>{item.label}</span><ArrowUpRight size={15}/></button>)}</section>
    </div>
    <section className="pa-table-card"><div className="pa-table-head"><h2>Recent companies</h2><button className="outline-button" onClick={()=>onNavigate('companies')}>View all companies</button></div><div className="pa-table-scroll"><table><thead><tr><th>Company</th><th>Plan</th><th>Status</th><th>Employees</th><th>Expiry</th><th>Action</th></tr></thead><tbody>{data?.recent_companies.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.plan||'Unassigned'}</td><td><span className={'pa-status '+row.effective_status}>{title(row.effective_status)}</span></td><td>{row.employee_count}</td><td>{row.ends_on||'No expiry'}</td><td><button className="pa-edit-link" onClick={()=>onManage(row)}>Manage</button></td></tr>)}</tbody></table>{!data?.recent_companies.length&&<p className="pa-loading">{data?'No companies yet.':loading?'Loading companies…':'Company data unavailable.'}</p>}</div></section>
  </div>;
}
