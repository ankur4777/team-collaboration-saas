import {useEffect,useRef,useState} from 'react';
import {api,type ForwardDestination,type ForwardResult,type Message} from './api';

export default function ForwardMessageDialog({kind,sourceId,message,onClose,onSent}:{kind:'chat'|'channel';sourceId:string;message:Message;onClose:()=>void;onSent:(result:ForwardResult)=>void}){
  const [rows,setRows]=useState<ForwardDestination[]>([]);
  const [choice,setChoice]=useState('');
  const [query,setQuery]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [sent,setSent]=useState(false);
  const inFlight=useRef(false);
  const live=useRef(true);
  useEffect(()=>{
    live.current=true;
    api.forwardDestinations().then(value=>{if(live.current)setRows(value);}).catch(e=>{if(live.current)setError(e instanceof Error?e.message:'Could not load destinations');}).finally(()=>{if(live.current)setLoading(false);});
    return()=>{live.current=false;};
  },[]);
  const target=rows.find(row=>row.kind+':'+row.id===choice);
  async function submit(){
    if(!target||inFlight.current||sent||message.deleted_at)return;
    inFlight.current=true;setBusy(true);setError('');
    try{const result=await api.forwardMessage(kind,sourceId,message.id,target);if(live.current){setSent(true);onSent(result);}}
    catch(e){if(live.current)setError(e instanceof Error?e.message:'Forwarding failed');}
    finally{inFlight.current=false;if(live.current)setBusy(false);}
  }
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="Forward message">
      <div className="modal-head"><h2>Forward message</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close" onClick={onClose}>×</button></div>
      <div className="modal-body">
        <p className="muted">{message.attachment?'The file and its caption will be copied to the selected chat or group.':'The text will be copied as a new message. Everyone in the destination can read it.'}</p>
        {message.attachment&&<p className="forward-file-name">{message.attachment.name}</p>}
        <div className="forward-text">{message.deleted_at?'Message deleted':message.body}</div>
        {error&&<p role="alert">{error}</p>}
        {sent?<p role="status">Message forwarded successfully.</p>:<>
          <label>Find destination<input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Chat, group or channel"/></label>
          <label>Send to<select aria-label="Forward destination" value={choice} onChange={e=>setChoice(e.target.value)} disabled={busy||loading}><option value="">{loading?'Loading…':'Select a conversation'}</option>{rows.filter(row=>(!message.attachment||row.kind==='chat')&&(row.label.toLowerCase().includes(query.toLowerCase())||row.kind+':'+row.id===choice)).map(row=><option key={row.kind+':'+row.id} value={row.kind+':'+row.id}>{row.kind==='channel'?'Channel: ':'Chat: '}{row.label}</option>)}</select></label>
          <div className="modal-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!target||busy||Boolean(message.deleted_at)} onClick={()=>void submit()}>{busy?'Forwarding…':'Forward'}</button></div>
        </>}
        {sent&&<button type="button" className="primary-button" onClick={onClose}>Done</button>}
      </div>
    </div>
  </div>;
}

