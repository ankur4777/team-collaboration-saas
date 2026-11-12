import { useRef, useState, type FormEvent } from 'react';
import { Hash, MessageCircle, Search } from 'lucide-react';
import { api, type MessageSearchResult, type SearchScope } from './api';

interface Props {
  onOpenChat: (chatId:string)=>void;
  onOpenChannel: (teamId:string,channelId:string)=>void;
}

function destinationName(item:MessageSearchResult) {
  if(item.source==='channel') return `${item.team_name || 'Team'} / #${item.source_name}`;
  return item.chat_kind==='group'?item.source_name:'Direct conversation';
}

export default function MessageSearchPanel({onOpenChat,onOpenChannel}:Props) {
  const [phrase,setPhrase]=useState('');
  const [scope,setScope]=useState<SearchScope>('all');
  const [results,setResults]=useState<MessageSearchResult[]>([]);
  const [searched,setSearched]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const callRef=useRef(0);

  async function search(e:FormEvent) {
    e.preventDefault();
    const text=phrase.trim();
    if(text.length<2||text.length>100)return;
    const call=++callRef.current;
    setBusy(true);
    setError('');
    setSearched(false);
    try {
      const response=await api.searchMessages(text,scope);
      if(call!==callRef.current)return;
      setResults(response.results);
      setSearched(true);
    }catch(e) {
      if(call===callRef.current)setError(e instanceof Error?e.message:'Search could not be completed');
    }finally {
      if(call===callRef.current)setBusy(false);
    }
  }

  function openResult(item:MessageSearchResult){
    if(item.source==='chat') onOpenChat(item.source_id);
    else if(item.team_id) onOpenChannel(item.team_id,item.source_id);
  }

  return <div className="message-search-page">
    <div className="message-search-intro">
      <div className="eyebrow">WORKSPACE / SEARCH</div>
      <h1>Find a message</h1>
      <p>Search messages in your accessible conversations and team channels. Results are limited to your current company.</p>
    </div>
    <form className="message-search-form" onSubmit={search}>
      <label className="message-search-field">
        <Search size={19}/>
        <span className="sr-only">Search message text</span>
        <input type="search" placeholder="Search message text" aria-label="Search message text"
          value={phrase} maxLength={100}
          onChange={e=>{setPhrase(e.target.value);setSearched(false);setError('');}}/>
      </label>
      <label className="message-search-filter">
        <span className="sr-only">Search location</span>
        <select value={scope} aria-label="Search location" onChange={e=>{setScope(e.target.value as SearchScope);setSearched(false);}}>
          <option value="all">All messages</option>
          <option value="chats">Chats & groups</option>
          <option value="channels">Team channels</option>
        </select>
      </label>
      <button className="primary-button" type="submit" disabled={busy||phrase.trim().length<2}>
        <Search size={16}/>{busy?'Searching…':'Search'}
      </button>
    </form>
    {error&&<p className="message-search-error" role="alert">{error}</p>}
    <div className="message-search-results" aria-live="polite">
      {searched&&<p className="message-search-summary">{results.length} {results.length===1?'result':'results'}{results.length>=50?' (showing latest 50)':''}</p>}
      {searched&&results.length===0&&<div className="message-search-empty">
        <Search size={28}/>
        <h2>No matching messages</h2><p>Try a different keyword or search location.</p>
      </div>}
      {!searched&&!busy&&!error&&<div className="message-search-empty">
        <MessageCircle size={28}/>
        <h2>Search across your workspace</h2>
        <p>Enter at least two characters to find matching messages.</p>
      </div>}
      {results.map(result=><button className="message-search-result" type="button"
        key={`${result.source}:${result.id}`} onClick={()=>openResult(result)}>
        <span className="message-search-result-icon">{result.source==='chat'?<MessageCircle size={18}/>:<Hash size={18}/>}</span>
        <span className="message-search-result-content">
          <span className="message-search-result-title">{destinationName(result)}</span>
          <span className="message-search-result-body">{result.excerpt}</span>
          <span className="message-search-result-meta">{result.sender_name} · {new Date(result.created_at).toLocaleString()}</span>
        </span>
      </button>)}
      {searched&&results.length>0&&<p className="message-search-note">Selecting a result opens its conversation. Older messages may require loading more conversation history.</p>}
    </div>
  </div>;
}
