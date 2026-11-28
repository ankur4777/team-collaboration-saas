import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,type InvoicePage,type InvoiceInput,type BillingInvoice,type PaymentInput} from './api';

const errorText=(e:unknown)=>e instanceof Error?e.message:'Request failed';
const today=()=>new Date().toISOString().slice(0,10);
const blankPayment=(date=today()):PaymentInput=>({paid_on:date,method:'bank_transfer',reference:'',note:''});
const currencyOptions=['INR','CAD','AUD','USD','GBP','EUR'];

export default function BillingPanel({companyId,onChanged}:{companyId:string;onChanged:()=>void}){
  const [page,setPage]=useState(1),[version,setVersion]=useState(0),[rows,setRows]=useState<InvoicePage|null>(null),[loading,setLoading]=useState(true);
  const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[status,setStatus]=useState(''),[filterCurrency,setFilterCurrency]=useState('');
  const [description,setDescription]=useState(''),[amount,setAmount]=useState(''),[currency,setCurrency]=useState('CAD'),[due,setDue]=useState('');
  const [selected,setSelected]=useState<BillingInvoice|null>(null),[payment,setPayment]=useState<PaymentInput>(blankPayment);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const lock=useRef(false),pending=useRef<InvoiceInput|null>(null);
  const serverDate=rows?.today||today();
  function changeFilter(fn:()=>void){setSelected(null);setPage(1);fn();}
  useEffect(()=>{let active=true;setLoading(true);api.platformInvoices(companyId,page,{q:search,status,currency:filterCurrency}).then(r=>{if(active)setRows(r);}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[companyId,page,version,search,status,filterCurrency]);
  async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await fn();setVersion(v=>v+1);onChanged();}catch(e){setError(errorText(e));}finally{lock.current=false;setBusy(false);}}
  function issue(e:FormEvent){
    e.preventDefault();
    if(!description.trim()||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0){setError('Enter a description and a positive amount with up to two decimal places.');return;}
    if(!window.confirm('Issue an invoice with this amount? Issued amounts cannot be edited.'))return;
    void run(async()=>{
      const values={description:description.trim(),currency,amount,due_on:due||null};
      const old=pending.current;
      const input=old&&old.description===values.description&&old.currency===currency&&old.amount===amount&&old.due_on===values.due_on?old:{...values,request_id:crypto.randomUUID()};
      pending.current=input;
      const row=await api.createPlatformInvoice(companyId,input);
      pending.current=null;setDescription('');setAmount('');setDue('');setPage(1);setStatus('');setFilterCurrency('');setSearch('');setQuery('');setNotice('Invoice issued: '+row.number);
    });
  }
  function settle(e:FormEvent){
    e.preventDefault();if(!selected||!payment.reference.trim())return;
    if(!window.confirm('Confirm the full invoice amount has already been received outside this application?'))return;
    void run(async()=>{await api.recordPlatformPayment(companyId,selected.id,{...payment,reference:payment.reference.trim(),note:payment.note.trim()});setSelected(null);setPage(1);setNotice('Full payment recorded.');});
  }
  function voidInvoice(row:BillingInvoice){
    if(!window.confirm('Void this unpaid invoice? The original record will remain in history.'))return;
    void run(async()=>{await api.voidPlatformInvoice(companyId,row.id);if(selected?.id===row.id)setSelected(null);setPage(1);setNotice('Invoice voided.');});
  }
  return <section className="pa-billing" aria-label="Billing and invoices"><h3>Billing &amp; invoices</h3><p className="pa-renewal-description">Manual billing only. No money is collected by this dashboard. Invoices do not automatically renew subscriptions.</p>
  {error&&<p className="pa-error" role="alert">{error}</p>}{notice&&<p className="pa-info" role="status">{notice}</p>}
  <p className="pa-renewal-description">Company-wide balances (currencies shown separately, excluding void invoices).</p>
  {rows?.totals.map(t=><div key={t.currency} className="pa-bill-total"><strong>{t.currency}</strong><span>Paid: {t.paid} · Outstanding: {t.unpaid}</span></div>)}
  <form onSubmit={issue}><label>Description<input value={description} maxLength={300} required onChange={e=>setDescription(e.target.value)} placeholder="Subscription service / renewal"/></label>
  <div className="pa-fields"><label>Currency<select value={currency} onChange={e=>setCurrency(e.target.value)}>{currencyOptions.map(c=><option key={c}>{c}</option>)}</select></label><label>Invoice amount<input type="number" min="0.01" max="9999999999.99" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>Due date (optional)<input type="date" min={serverDate} value={due} onChange={e=>setDue(e.target.value)}/></label></div>
  <button type="submit" className="primary-button" disabled={busy}>Issue invoice</button></form>
  <h3>Invoice &amp; payment history</h3>
  <div className="pa-metric-grid" aria-label="Company invoice totals">{([['','All invoices','all'],['unpaid','Unpaid','unpaid'],['paid','Paid','paid'],['overdue','Overdue','overdue'],['void','Void','void']] as const).map(([key,label,stat])=><button type="button" key={stat} className="pa-stat pa-stat-link" disabled={busy} aria-pressed={status===key} onClick={()=>changeFilter(()=>setStatus(key))}><span>{label}</span><strong>{rows?.counts?.[stat]??'—'}</strong></button>)}</div>
  <form onSubmit={e=>{e.preventDefault();changeFilter(()=>setSearch(query.trim()));}}>
    <label>Search invoices<input value={query} maxLength={300} onChange={e=>setQuery(e.target.value)} placeholder="Invoice number, description or payment reference" disabled={busy}/></label>
    <div className="pa-fields"><label>Invoice status<select value={status} disabled={busy} onChange={e=>changeFilter(()=>setStatus(e.target.value))}><option value="">All statuses</option><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="overdue">Overdue</option><option value="void">Void</option></select></label><label>Filter currency<select value={filterCurrency} disabled={busy} onChange={e=>changeFilter(()=>setFilterCurrency(e.target.value))}><option value="">All currencies</option>{currencyOptions.map(c=><option key={c}>{c}</option>)}</select></label></div>
    <div className="pa-bill-actions"><button type="submit" className="outline-button" disabled={busy}>Search</button><button type="button" className="outline-button" disabled={busy} onClick={()=>changeFilter(()=>{setQuery('');setSearch('');setStatus('');setFilterCurrency('');})}>Clear filters</button><button type="button" className="outline-button" disabled={busy||loading} onClick={()=>setVersion(v=>v+1)}>Refresh</button></div>
  </form>
  {!loading&&rows&&<p className="pa-renewal-description">{rows.total} matching invoice(s). Overdue invoices are also included in unpaid totals.</p>}{loading&&<p role="status">Loading invoices…</p>}{!loading&&rows?.items.length===0&&<p>{status||filterCurrency||search?'No matching invoices.':'No invoices yet.'}</p>}
  {!loading&&rows?.items.map(row=><article className="pa-bill-row" key={row.id}><strong>{row.description}</strong><small>{row.number}</small><div className="pa-bill-status">{row.currency} {row.amount} · {row.overdue?'OVERDUE':row.status.toUpperCase()}</div><small>Issued {row.issued_on}{row.due_on?' · Due '+row.due_on:''}</small>
  {row.payment&&<small>Paid {row.payment.paid_on} · {row.payment.method.replace(/_/g,' ')} · Ref: {row.payment.reference}{row.payment.note?' · '+row.payment.note:''}</small>}
  <div className="pa-bill-actions"><a className="outline-button" href={'/api/platform/companies/'+companyId+'/invoices/'+row.id+'/pdf/'} download>Download PDF</a>{row.status==='unpaid'&&<><button type="button" className="outline-button" disabled={busy} onClick={()=>{setSelected(row);setPayment(blankPayment(serverDate));}}>Record payment</button><button type="button" className="outline-button" disabled={busy} onClick={()=>voidInvoice(row)}>Void</button></>}</div>
  {selected?.id===row.id&&row.status==='unpaid'&&<form onSubmit={settle}><p className="pa-renewal-description">Record full payment: {row.currency} {row.amount}</p><label>Payment date<input type="date" required min={row.issued_on} max={serverDate} value={payment.paid_on} onChange={e=>setPayment(p=>({...p,paid_on:e.target.value}))}/></label>
  <label>Payment method<select value={payment.method} onChange={e=>setPayment(p=>({...p,method:e.target.value}))}>{[['bank_transfer','Bank transfer'],['card','Card (external)'],['upi','UPI'],['cash','Cash'],['other','Other']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
  <label>Transaction / receipt reference<input required maxLength={120} value={payment.reference} onChange={e=>setPayment(p=>({...p,reference:e.target.value}))}/></label><label>Payment note (optional)<input maxLength={300} value={payment.note} onChange={e=>setPayment(p=>({...p,note:e.target.value}))}/></label>
  <button type="submit" className="primary-button" disabled={busy}>Confirm received payment</button><button type="button" className="outline-button" disabled={busy} onClick={()=>setSelected(null)}>Cancel</button></form>}</article>)}
  {rows&&rows.total>rows.page_size&&<div className="pa-pagination"><span>Page {page}</span><button type="button" className="outline-button" disabled={busy||loading||page<=1} onClick={()=>{setSelected(null);setPage(p=>p-1);}}>Previous</button><button type="button" className="outline-button" disabled={busy||loading||page*rows.page_size>=rows.total} onClick={()=>{setSelected(null);setPage(p=>p+1);}}>Next</button></div>}</section>;
}
