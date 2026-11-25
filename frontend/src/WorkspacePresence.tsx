import {useEffect,useState} from 'react';
import {api,type Presence,type PresenceMap} from './api';

export function useWorkspacePresence(workspaceId:string|null){
  const [snapshot,setSnapshot]=useState<{workspaceId:string;rows:PresenceMap}|null>(null);
  useEffect(()=>{
    if(!workspaceId)return;
    let active=true,inFlight=false;
    const refresh=async()=>{
      if(!active||inFlight||document.hidden)return;
      inFlight=true;
      try{
        const data=await api.workspacePresence(workspaceId);
        if(active&&data.workspace_id===workspaceId){
          setSnapshot({workspaceId,rows:Object.fromEntries(data.members.map(row=>[row.user_id,row]))});
        }
      }catch{if(active)setSnapshot(null);}
      finally{inFlight=false;}
    };
    const trigger=()=>{void refresh();};
    const offline=()=>{if(active)setSnapshot(null);};
    trigger();
    const timer=window.setInterval(trigger,30000);
    document.addEventListener('visibilitychange',trigger);
    window.addEventListener('focus',trigger);
    window.addEventListener('online',trigger);
    window.addEventListener('offline',offline);
    return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',trigger);window.removeEventListener('focus',trigger);window.removeEventListener('online',trigger);window.removeEventListener('offline',offline);};
  },[workspaceId]);
  return snapshot?.workspaceId===workspaceId?snapshot.rows:{};
}

export function presenceLabel(row?:Presence){
  if(!row)return 'Status unavailable';
  if(row.online)return 'Online';
  if(!row.last_seen_at)return 'Offline';
  return 'Offline · Last seen '+new Date(row.last_seen_at).toLocaleString();
}

export function PresenceStatus({row}:{row?:Presence}){
  return <span className="presence-status"><span aria-hidden="true" className={'presence-dot'+(row?.online?' online':'')}/>{presenceLabel(row)}</span>;
}
