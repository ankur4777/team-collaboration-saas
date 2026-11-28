import {useEffect,useRef,useState} from 'react';
import {Mic,Square,Trash2} from 'lucide-react';

export default function VoiceNoteRecorder({disabled=false,onReady,onRecordingChange}:{disabled?:boolean;onReady:(file:File)=>void;onRecordingChange?:(active:boolean)=>void}){
  const [recording,setRecording]=useState(false),[starting,setStarting]=useState(false),[seconds,setSeconds]=useState(0),[error,setError]=useState('');
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),cancelled=useRef(false),alive=useRef(true),startingRef=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancelled.current=true;if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(track=>track.stop());};},[]);
  useEffect(()=>{if(!recording)return;const timer=setInterval(()=>setSeconds(value=>value+1),1000);return()=>clearInterval(timer);},[recording]);
  useEffect(()=>{if(seconds>=120&&recording)recorder.current?.stop();},[seconds,recording]);
  async function start(){
    if(startingRef.current||disabled)return;startingRef.current=true;setStarting(true);setError('');cancelled.current=false;
    try{
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error('Voice recording needs microphone access in a supported browser on HTTPS or localhost.');
      const microphone=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!alive.current||cancelled.current){microphone.getTracks().forEach(track=>track.stop());return;}
      stream.current=microphone;
      const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(kind=>MediaRecorder.isTypeSupported(kind));
      if(!mime)throw new Error('This browser cannot record a supported voice-note format.');
      const current=new MediaRecorder(microphone,{mimeType:mime,audioBitsPerSecond:64000}),chunks:BlobPart[]=[];
      recorder.current=current;
      current.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      current.onerror=()=>{cancelled.current=true;if(current.state==='recording')current.stop();microphone.getTracks().forEach(track=>track.stop());if(alive.current){setRecording(false);onRecordingChange?.(false);setError('Recording failed. Please try again.');}};
      current.onstop=()=>{
        microphone.getTracks().forEach(track=>track.stop());stream.current=null;recorder.current=null;
        if(alive.current){setRecording(false);onRecordingChange?.(false);}
        if(!alive.current||cancelled.current)return;
        const type=mime.split(';')[0],extension=type==='audio/mp4'?'m4a':type==='audio/ogg'?'ogg':'webm';
        const blob=new Blob(chunks,{type});
        if(!blob.size||blob.size>5*1024*1024){setError('The voice note must be nonempty and under 5 MB.');return;}
        onReady(new File([blob],`Voice note ${new Date().toISOString().replace(/[:.]/g,'-')}.${extension}`,{type}));
      };
      current.start();setSeconds(0);setRecording(true);onRecordingChange?.(true);
    }catch(reason){stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;if(alive.current)setError(reason instanceof Error?reason.message:'Microphone access was denied.');}
    finally{startingRef.current=false;if(alive.current)setStarting(false);}
  }
  return <div className="chat-voice-recorder">
    {recording?<div className="chat-recording-controls" role="group" aria-label="Recording voice note"><button type="button" className="icon-button" aria-label="Cancel voice recording" onClick={()=>{cancelled.current=true;recorder.current?.stop();}}><Trash2 size={18}/></button><span role="timer">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</span><button type="button" className="icon-button" aria-label="Stop and preview voice note" onClick={()=>recorder.current?.stop()}><Square size={18}/></button></div>:<button type="button" className="icon-button chat-mic-button" aria-label="Record voice note" title="Record voice note" disabled={disabled||starting} onClick={()=>void start()}><Mic size={20}/></button>}
    {error&&<p className="chat-voice-error" role="alert">{error}</p>}
  </div>;
}
