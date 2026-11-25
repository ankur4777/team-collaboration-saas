import {useEffect,useRef,useState} from 'react';
import {api,type Message} from './api';

export default function MessageContext({kind,id,messageId,onClose}:{kind:'chat'|'channel';id:string;messageId:string;onClose:()=>void}){
  const [rows,setRows]=useState<Message[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const focus=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let active=true;setRows([]);setError('');setLoading(true);
    api.messageContext(kind,id,messageId).then(data=>{if(active)setRows(data.items);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Message unavailable');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[kind,id,messageId]);
  useEffect(()=>{if(rows.length){focus.current?.scrollIntoView?.({block:'center'});focus.current?.focus();}},[rows]);
  return <section className="search-message-context" aria-label="Searched message context"><div className="context-header"><strong>Search result · conversation context</strong><button className="outline-button" type="button" onClick={onClose}>Return to latest messages</button></div>
    {loading&&<p>Loading message…</p>}{error&&<p role="alert">{error}</p>}
    <div className="context-history">{rows.map(row=><div key={row.id} ref={row.id===messageId?focus:undefined} tabIndex={row.id===messageId?-1:undefined} className={'context-message'+(row.id===messageId?' target':'')}><strong>{row.sender.full_name}</strong><small>{new Date(row.created_at).toLocaleString()}</small><p>{row.deleted_at?'Message deleted':row.body}</p></div>)}</div>
  </section>;
}
