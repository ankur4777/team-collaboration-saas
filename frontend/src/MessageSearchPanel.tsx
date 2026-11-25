import { useRef, useState, type FormEvent } from 'react';
import { Hash, MessageCircle, Search } from 'lucide-react';
import { api, type MessageSearchResult, type SearchScope } from './api';

interface Props {
  onOpenChat: (chatId:string,messageId:string)=>void;
  onOpenChannel: (teamId:string,channelId:string,messageId:string)=>void;
}

function destinationName(item:MessageSearchResult) {
  if(item.source==='channel') return `${item.team_name || 'Team'} / #${item.source_name}`;
  return item.chat_kind==='group'?item.source_name:'Direct conversation';
}

export default function MessageSearchPanel({onOpenChat,onOpenChannel}:Props) {
  const [phrase,setPhrase]=useState('');
  const [scope,setScope]=useState<SearchScope>('all');
  const [sender,setSender]=useState('');
  const [start,setStart]=useState('');const [end,setEnd]=useState('');
  const [cursor,setCursor]=useState<string|null>(null);
  const [results,setResults]=useState<MessageSearchResult[]>([]);
  const [searched,setSearched]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const callRef=useRef(0);

  function resetResults(){callRef.current++;setBusy(false);setSearched(false);setError('');setCursor(null);}

  async function search(e?:FormEvent,more=false) {
    e?.preventDefault();
    if(more&&(!cursor||busy))return;
    const text=phrase.trim();
    if(text.length<2||text.length>100)return;
    const call=++callRef.current;
    setBusy(true);
    setError('');
    if(!more){setSearched(false);setCursor(null);}
    try {
      const response=await api.searchMessages(text,scope,{sender:sender.trim(),start,end,cursor:more?cursor||'':''});
      if(call!==callRef.current)return;
      setResults(old=>more?[...new Map([...old,...response.results].map(item=>[item.source+':'+item.id,item])).values()]:response.results);
      setCursor(response.next_cursor||null);
      setSearched(true);
    }catch(e) {
      if(call===callRef.current)setError(e instanceof Error?e.message:'Search could not be completed');
    }finally {
      if(call===callRef.current)setBusy(false);
    }
  }

  function openResult(item:MessageSearchResult){
    if(item.source==='chat') onOpenChat(item.source_id,item.id);
    else if(item.team_id) onOpenChannel(item.team_id,item.source_id,item.id);
  }

  return <div className="message-search-page">
    <div className="message-search-intro">
      <div className="eyebrow">WORKSPACE / SEARCH</div>
      <h1>Find a message</h1>
      <p>Search messages in your accessible conversations and team channels. Results are limited to your current company.</p>
    </div>
    <form className="message-search-form" onSubmit={e=>void search(e)}>
      <label className="message-search-field">
        <Search size={19}/>
        <span className="sr-only">Search message text</span>
        <input type="search" placeholder="Search message text" aria-label="Search message text"
          value={phrase} maxLength={100}
          onChange={e=>{setPhrase(e.target.value);resetResults();}}/>
      </label>
      <label className="message-search-filter">
        <span className="sr-only">Search location</span>
        <select value={scope} aria-label="Search location" onChange={e=>{setScope(e.target.value as SearchScope);resetResults();}}>
          <option value="all">All messages</option>
          <option value="chats">Chats & groups</option>
          <option value="channels">Team channels</option>
        </select>
      </label>
      <label>Sender<input type="search" aria-label="Filter by sender" placeholder="Name or email" maxLength={100} value={sender} onChange={e=>{setSender(e.target.value);resetResults();}}/></label>
      <label>From date (UTC)<input type="date" aria-label="From date (UTC)" value={start} max={end||undefined} onChange={e=>{setStart(e.target.value);resetResults();}}/></label>
      <label>To date (UTC)<input type="date" aria-label="To date (UTC)" value={end} min={start||undefined} onChange={e=>{setEnd(e.target.value);resetResults();}}/></label>
      <button className="primary-button" type="submit" disabled={busy||phrase.trim().length<2}>
        <Search size={16}/>{busy?'Searching…':'Search'}
      </button>
    </form>
    {error&&<p className="message-search-error" role="alert">{error}</p>}
    <div className="message-search-results" aria-live="polite">
      {searched&&<p className="message-search-summary">{results.length} {results.length===1?'result':'results'}{cursor?' loaded — more available':''}</p>}
      {searched&&results.length===0&&<div className="message-search-empty">
        <Search size={28}/>
        <h2>No matching messages</h2><p>Try a different keyword or search location.</p>
      </div>}
      {!searched&&!busy&&!error&&<div className="message-search-empty">
        <MessageCircle size={28}/>
        <h2>Search across your workspace</h2>
        <p>Enter at least two characters to find matching messages.</p>
      </div>}
      {searched&&results.map(result=><button className="message-search-result" type="button"
        key={`${result.source}:${result.id}`} onClick={()=>openResult(result)}>
        <span className="message-search-result-icon">{result.source==='chat'?<MessageCircle size={18}/>:<Hash size={18}/>}</span>
        <span className="message-search-result-content">
          <span className="message-search-result-title">{destinationName(result)}</span>
          <span className="message-search-result-body">{result.excerpt}</span>
          <span className="message-search-result-meta">{result.sender_name} · {new Date(result.created_at).toLocaleString()}</span>
        </span>
      </button>)}
      {searched&&cursor&&<button type="button" className="outline-button" disabled={busy} onClick={()=>void search(undefined,true)}>{busy?'Loading…':'Load more results'}</button>}
      {searched&&results.length>0&&<p className="message-search-note">Selecting a result opens its conversation and highlights the exact message with surrounding history.</p>}
    </div>
  </div>;
}
