import {useEffect,useRef,useState} from 'react';
import {Phone,Video} from 'lucide-react';
import {meetingsApi,type ChatThread,type MeetingRecord} from './api';
import CallRoom from './CallRoom';

export default function ChatCallControls({chat,userId,onActivity}:{chat:ChatThread;userId:string;onActivity?:()=>void}){
  const [room,setRoom]=useState<{meeting:MeetingRecord;video:boolean}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),lock=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function start(video:boolean){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      const now=new Date(),name=chat.kind==='group'?chat.title:chat.participants.find(p=>p.user.id!==userId)?.user.full_name||'Chat';
      const meeting=await meetingsApi.create({title:`${video?'Video':'Voice'} call · ${name}`.slice(0,160),agenda:'',starts_at:now.toISOString(),ends_at:new Date(now.getTime()+3600000).toISOString(),time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',attendee_ids:chat.participants.filter(p=>p.user.id!==userId).map(p=>p.user.id),channel_id:null,invite_channel:false});
      if(alive.current){setRoom({meeting,video});onActivity?.();}
    }catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'Could not start the call.');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  return <div className="chat-call-controls"><button type="button" className="conversation-icon-button" aria-label="Start voice call" title="Voice call" disabled={busy} onClick={()=>void start(false)}><Phone size={18}/></button><button type="button" className="conversation-icon-button" aria-label="Start video call" title="Video call" disabled={busy} onClick={()=>void start(true)}><Video size={18}/></button>{error&&<p className="chat-call-error" role="alert">{error}<button type="button" aria-label="Dismiss call error" onClick={()=>setError('')}>×</button></p>}{room&&<CallRoom meeting={room.meeting} userId={userId} initialVideo={room.video} onLeave={()=>{setRoom(null);onActivity?.();}}/>}</div>;
}
