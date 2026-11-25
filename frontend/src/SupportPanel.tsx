import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,type SupportPage,type SupportDetail,type TicketStatus} from './api';
import './PlatformAdmin.css';

const statuses:TicketStatus[]=['open','in_progress','resolved','closed'];
const label=(v:string)=>v.replace(/_/g,' ');
const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';

export default function SupportPanel({provider}:{provider:boolean}){
  const [filter,setFilter]=useState(''),[page,setPage]=useState(1),[version,setVersion]=useState(0),[list,setList]=useState<SupportPage|null>(null);
  const [selected,setSelected]=useState(''),[detail,setDetail]=useState<SupportDetail|null>(null),[status,setStatus]=useState<TicketStatus>('open'),[reply,setReply]=useState('');
  const [subject,setSubject]=useState(''),[priority,setPriority]=useState('normal'),[body,setBody]=useState(''),[creating,setCreating]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const lock=useRef(false);
  useEffect(()=>{let active=true;api.supportTickets(provider,filter,page).then(r=>{if(active)setList(r);}).catch(e=>{if(active){setList(null);setError(errorText(e));}});return()=>{active=false;};},[provider,filter,page,version]);
  useEffect(()=>{let active=true;setDetail(null);setReply('');if(selected)api.supportDetail(provider,selected).then(r=>{if(active){setDetail(r);setStatus(r.status);}}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[selected,provider,version]);
  async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();setVersion(v=>v+1);}catch(e){setError(errorText(e));}finally{lock.current=false;setBusy(false);}}
  function create(e:FormEvent){e.preventDefault();void run(async()=>{const row=await api.createSupportTicket({subject:subject.trim(),priority,body:body.trim()});setSubject('');setBody('');setCreating(false);setFilter('');setPage(1);setSelected(row.id);});}
  function update(e:FormEvent){e.preventDefault();if(!detail)return;const data:{body?:string;status?:TicketStatus}={};if(reply.trim())data.body=reply.trim();if(provider&&status!==detail.status)data.status=status;if(!data.body&&!data.status)return;void run(async()=>{const row=await api.updateSupportTicket(provider,detail.id,data);setDetail(row);setReply('');});}
  return <section className="pa-support"><div className="pa-report-head"><h2>{provider?'Support ticket management':'Contact support'}</h2><button type="button" className="outline-button" disabled={busy} onClick={()=>setVersion(v=>v+1)}>Refresh</button></div>
    <p className="pa-renewal-description">{provider?'Review customer requests, reply and manage resolution status.':'Share your issue with TeamWorkspace Support. Do not include passwords or payment card details. Company administrators may review company tickets.'}</p>
    {error&&<p className="pa-error" role="alert">{error}</p>}
    {!provider&&<><button type="button" className="primary-button" disabled={busy} onClick={()=>setCreating(v=>!v)}>{creating?'Cancel new ticket':'Create support ticket'}</button>{creating&&<form onSubmit={create}><label>Subject<input maxLength={160} required value={subject} onChange={e=>setSubject(e.target.value)}/></label><label>Priority<select value={priority} onChange={e=>setPriority(e.target.value)}><option value="normal">Normal</option><option value="high">High</option></select></label><label>Describe your issue<textarea required maxLength={4000} value={body} onChange={e=>setBody(e.target.value)}/></label><button className="primary-button" disabled={busy}>Submit ticket</button></form>}</>}
    <label className="pa-ticket-filter">Ticket status<select value={filter} disabled={busy} onChange={e=>{setFilter(e.target.value);setPage(1);setSelected('');}}><option value="">All statuses</option>{statuses.map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>
    {!list&&!error&&<p>Loading tickets…</p>}{list?.items.length===0&&<p>No tickets found.</p>}
    <div className="pa-ticket-list">{list?.items.map(row=><button type="button" disabled={busy} key={row.id} className={'pa-ticket '+(selected===row.id?'selected':'')} onClick={()=>setSelected(row.id)}><strong>{row.subject}</strong><small>{provider?row.company+' · ':''}{label(row.status)} · {row.priority} · {new Date(row.updated_at).toLocaleString()}</small></button>)}</div>
    {list&&list.total>list.page_size&&<div className="pa-pagination"><span>Page {page}</span><button type="button" className="outline-button" disabled={busy||page<=1} onClick={()=>{setSelected('');setPage(p=>p-1);}}>Previous</button><button type="button" className="outline-button" disabled={busy||page*list.page_size>=list.total} onClick={()=>{setSelected('');setPage(p=>p+1);}}>Next</button></div>}
    {detail&&<article className="pa-ticket-detail"><div className="pa-report-head"><h3>{detail.subject}</h3><button type="button" className="outline-button" disabled={busy} onClick={()=>setSelected('')}>Close</button></div><p className="pa-renewal-description">{detail.company} · {label(detail.status)} · {detail.requester}</p>
      <div className="pa-replies">{detail.replies.map(r=><div key={r.id} className={'pa-reply '+(r.from_provider?'provider':'')}><strong>{r.author}</strong><small>{new Date(r.created_at).toLocaleString()}</small><p>{r.body}</p></div>)}</div>
      {(provider||detail.status!=='closed')&&<form onSubmit={update}>{provider&&<label>Status<select value={status} onChange={e=>setStatus(e.target.value as TicketStatus)}>{statuses.map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>}<label>Reply<textarea maxLength={4000} value={reply} onChange={e=>setReply(e.target.value)}/></label><button className="primary-button" disabled={busy||(!reply.trim()&&(!provider||status===detail.status))}>{provider?'Save response / status':'Send reply'}</button></form>}
    </article>}</section>;
}
