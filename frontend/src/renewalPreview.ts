import type {PlatformCompany} from './api';
type RenewalCompany=Pick<PlatformCompany,'server_now'|'subscription_timezone'|'starts_on'|'ends_on'|'status'>;
function addDays(iso:string,days:number){
  const d=new Date(iso+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  return Number.isFinite(d.getTime())&&d.getUTCFullYear()<=9999?d.toISOString().slice(0,10):null;
}
export function renewalPreview(company:RenewalCompany,days:number,reactivate:boolean){
  if(!Number.isInteger(days)||days<1||days>3650||!company.server_now||!company.subscription_timezone)return null;
  let today:string;
  try{
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:company.subscription_timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(company.server_now));
    const part=(type:string)=>parts.find(p=>p.type===type)?.value;
    today=part('year')+'-'+part('month')+'-'+part('day');
  }catch{return null;}
  const existing=company.ends_on&&company.ends_on>=today;
  const start=existing?(company.starts_on||today):(company.starts_on&&company.starts_on>today?company.starts_on:today);
  const end=addDays(existing?company.ends_on!:start,existing?days:days-1);
  if(!end||end<start)return null;
  const blocked=company.status==='suspended'||company.status==='cancelled';
  const status=blocked&&!reactivate?company.status:start>today?'scheduled':'active';
  return {start,end,status};
}
