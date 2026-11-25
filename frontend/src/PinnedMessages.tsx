import {useEffect,useRef,useState} from 'react';
import {api,type Message} from './api';

export default function PinnedMessages({kind,id,version,onUnpin,readOnly=false}:{kind:'chat'|'channel';id:string;version:number;onUnpin:(message:Message)=>void;readOnly?:boolean}){
  const [open,setOpen]=useState(false);
  const [rows,setRows]=useState<Message[]>([]);
  const [more,setMore]=useState(false);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!open)return;
    let active=true;
    async function load(){
      try{
        const page=await (kind==='chat'?api.chatPins(id):api.channelPins(id));
        if(active){setRows(page.items);setMore(page.has_more);setError('');}
      }catch(e){if(active){setRows([]);setError(e instanceof Error?e.message:'Could not load pinned messages');}}
      finally{if(active)setLoading(false);}
    }
    setLoading(true);void load();
    const timer=window.setInterval(()=>{if(!document.hidden)void load();},30000);
    return()=>{active=false;window.clearInterval(timer);};
  },[open,id,kind,version]);
  async function unpin(message:Message){
    if(busy||readOnly)return;
    setBusy(message.id);setError('');
    try{
      const updated=await (kind==='chat'?api.pinChatMessage(id,message.id,false):api.pinChannelMessage(id,message.id,false));
      if(alive.current){setRows(old=>old.filter(row=>row.id!==message.id));onUnpin(updated);}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not unpin message');}
    finally{if(alive.current)setBusy('');}
  }
  return <div className="pinned-messages">
    <button type="button" className="outline-button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'Hide pinned messages':'Pinned messages'}</button>
    {open&&<div className="pinned-message-list" aria-label="Pinned messages">
      {error&&<p role="alert">{error}</p>}
      {loading&&rows.length===0&&<p>Loading pins…</p>}
      {!loading&&!error&&rows.length===0&&<p>No pinned messages yet.</p>}
      {rows.map(row=><div className="pinned-message-row" key={row.id}><div><strong>{row.sender.full_name}</strong><small>{new Date(row.created_at).toLocaleString()}</small><p>{row.body}</p></div><button type="button" className="outline-button" disabled={Boolean(busy)||readOnly} onClick={()=>void unpin(row)}>{busy===row.id?'Working…':'Unpin'}</button></div>)}
      {more&&<p className="muted">Showing the latest 100 pins. Earlier pins are available in message history.</p>}
    </div>}
  </div>;
}
