export type MailProvider = 'local'|'gmail'|'outlook';
export type FolderId = 'inbox'|'sent'|'drafts'|'archive'|'junk'|'trash'|'starred';
export interface MailAccount {id:string;provider:MailProvider;email:string;display_name:string;needs_reconnect:boolean}
export interface MailConfig {local_enabled:boolean;gmail_configured:boolean;outlook_configured:boolean;max_attachment_bytes:number;max_total_attachment_bytes:number}
export interface MailFolder {id:FolderId;name:string;total:number;unread:number}
export interface MailFile {id:string;name:string;size:number;content_type:string}
export interface UploadFile {name:string;content_type:string;data:string;size?:number}
export interface MailMessage {
  id:string;subject:string;sender:string;sender_name:string;to:string[];cc:string[];bcc:string[];
  preview:string;date:string;is_read:boolean;is_starred:boolean;folder:FolderId;has_attachments:boolean;
  body?:string;attachments?:MailFile[];reply_to:string[];internet_id:string;thread_id:string;
}
export interface ComposePayload {
  to:string[];cc:string[];bcc:string[];subject:string;body:string;attachments:UploadFile[];
  draft_id:string;reply_id:string;mode:'new'|'reply'|'reply_all'|'forward';
}
export interface MailPage {results:MailMessage[];next_cursor:string}
export interface SendResult {status:'sent'|'uncertain'|'failed';detail?:string;draft_id?:string;message_id?:string}
export class MailApiError extends Error {
  constructor(public status:number,public payload:Record<string,unknown>,message:string){super(message);}
}
async function call<T>(path:string,method='GET',body?:unknown,headers:Record<string,string>={},signal?:AbortSignal):Promise<T>{
  let token='';
  if(method!=='GET'){
    const init=await fetch('/api/auth/csrf/',{credentials:'same-origin'});
    if(!init.ok)throw new Error('Could not initialize request security. Sign in again.');
    token=(await init.json() as {csrf_token:string}).csrf_token;
  }
  const response=await fetch('/api/mail/'+path,{method,credentials:'same-origin',signal,
    headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{'X-CSRFToken':token}:{}),...headers},
    body:body===undefined?undefined:JSON.stringify(body)});
  const result=response.status===204?{}:await response.json().catch(()=>({detail:'The server returned an unreadable response.'}));
  if(!response.ok){
    const message=typeof result.detail==='string'?result.detail:Object.entries(result).map(([k,v])=>k+': '+JSON.stringify(v)).join(' ');
    throw new MailApiError(response.status,result,message||'Mailbox request failed.');
  }
  return result as T;
}
const base=(account:string)=>'accounts/'+encodeURIComponent(account)+'/';
export const attachmentUrl=(account:string,message:string,file:string)=>'/api/mail/'+base(account)+'messages/'+encodeURIComponent(message)+'/attachments/'+encodeURIComponent(file)+'/';
export const mailApi={
  config:(signal?:AbortSignal)=>call<MailConfig>('config/','GET',undefined,{},signal),
  accounts:(signal?:AbortSignal)=>call<MailAccount[]>('accounts/','GET',undefined,{},signal),
  local:()=>call<MailAccount>('accounts/','POST',{provider:'local'}),
  disconnect:(account:string)=>call<void>(base(account),'DELETE'),
  connect:(provider:'gmail'|'outlook')=>call<{authorization_url:string}>('oauth/'+provider+'/start/','POST',{}),
  folders:(account:string,signal?:AbortSignal)=>call<MailFolder[]>(base(account)+'folders/','GET',undefined,{},signal),
  messages:(account:string,folder:FolderId,q='',cursor='',signal?:AbortSignal)=>{
    const params=new URLSearchParams({folder,q,cursor});
    return call<MailPage>(base(account)+'messages/?'+params.toString(),'GET',undefined,{},signal);
  },
  detail:(account:string,message:string,folder:FolderId,signal?:AbortSignal)=>call<MailMessage>(base(account)+'messages/'+encodeURIComponent(message)+'/?folder='+folder,'GET',undefined,{},signal),
  action:(account:string,message:string,action:string)=>call(base(account)+'messages/'+encodeURIComponent(message)+'/actions/','POST',{action}),
  draft:(account:string,payload:ComposePayload)=>call<{draft_id:string}>(base(account)+'drafts/','POST',payload),
  discard:(account:string,message:string)=>call<void>(base(account)+'drafts/'+encodeURIComponent(message)+'/','DELETE'),
  send:(account:string,payload:ComposePayload,key:string)=>call<SendResult>(base(account)+'send/','POST',payload,{'Idempotency-Key':key}),
};
