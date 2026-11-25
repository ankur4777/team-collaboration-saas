import {useEffect,useState} from 'react';
import {CalendarDays,Clock,AlertCircle} from 'lucide-react';
import type {SubscriptionAccess,SubscriptionTiming} from './api';

export function countdownLabel(seconds:number){
  const total=Math.max(0,Math.floor(seconds));
  if(total===0)return '0 minutes remaining';
  if(total<60)return 'Less than 1 minute remaining';
  const days=Math.floor(total/86400),hours=Math.floor(total%86400/3600),minutes=Math.floor(total%3600/60);
  return days>0?`${days}d ${hours}h remaining`:`${hours}h ${minutes}m remaining`;
}

export function initialSeconds(timing:SubscriptionTiming){
  if(!timing.expires_at||!timing.server_now)return null;
  const delta=(Date.parse(timing.expires_at)-Date.parse(timing.server_now))/1000;
  return Number.isFinite(delta)?Math.max(0,Math.ceil(delta)):null;
}

function useRemaining(timing:SubscriptionTiming){
  const {expires_at,server_now}=timing;
  const [value,setValue]=useState<number|null>(()=>initialSeconds(timing));
  useEffect(()=>{
    const initial=initialSeconds({expires_at,server_now});
    const received=performance.now();
    const tick=()=>setValue(initial===null?null:Math.max(0,Math.ceil(initial-(performance.now()-received)/1000)));
    tick();
    const timer=window.setInterval(tick,1000);
    return()=>window.clearInterval(timer);
  },[expires_at,server_now]);
  return value;
}

export function SubscriptionSummary({subscription:sub,compact=false,onDetails}:{subscription:SubscriptionAccess;compact?:boolean;onDetails?:()=>void}){
  const remaining=useRemaining(sub);
  const timed=sub.status==='active'||sub.status==='trial';
  const warning=timed&&remaining!==null&&remaining<=7*86400;
  const urgent=warning&&remaining!==null&&remaining<=86400;
  const label=sub.status==='unassigned'?'No assigned plan':sub.status==='expired'?'Subscription expired':timed?(remaining===null?(sub.ends_on?'Checking expiry…':'No expiry date'):countdownLabel(remaining)):sub.status;
  const status=sub.status.charAt(0).toUpperCase()+sub.status.slice(1);
  return <section className={'subscription-summary'+(compact?' compact':'')+(urgent?' urgent':warning?' warning':'')} aria-label="Company subscription">
    <div className="subscription-heading"><CalendarDays size={compact?15:20}/><div><strong>{compact?'Subscription':'Company subscription'}</strong><small>{sub.plan||'No plan assigned'} · {status}</small></div></div>
    <div className="subscription-countdown"><Clock size={15}/><strong>{label}</strong></div>
    {!compact&&<dl className="subscription-details"><div><dt>Start date</dt><dd>{sub.starts_on||'Not set'}</dd></div><div><dt>Valid through</dt><dd>{sub.ends_on||'Not set'}{sub.ends_on&&sub.subscription_timezone?' ('+sub.subscription_timezone+')':''}</dd></div><div><dt>Seats used</dt><dd>{sub.seats_used??'—'} / {sub.seat_limit??'Unlimited'}</dd></div><div><dt>Enabled modules</dt><dd>{sub.modules?.length??'—'}</dd></div></dl>}
    {warning&&<p className="subscription-warning"><AlertCircle size={14}/><span>{remaining===0?'Checking subscription status.':urgent?'Subscription expires within 24 hours. Contact your administrator.':'Subscription expires within 7 days. Arrange renewal with your administrator.'}</span></p>}
    {compact&&onDetails&&<button type="button" className="subscription-link" onClick={onDetails}>View subscription details</button>}
  </section>;
}
