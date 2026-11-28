import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Download,FileText,Image as ImageIcon,Maximize2,Paperclip,Send,Smile,X} from 'lucide-react';
import {api,type Person,type PrivateAttachment} from './api';
import MentionInput from './MentionInput';
import WorkspaceDialog from './WorkspaceDialog';
import VoiceNoteRecorder from './VoiceNoteRecorder';
import './ChatFileMessage.css';

function sizeLabel(bytes:number){return bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/(1024*1024)).toFixed(1)} MB`;}
const imageTypes=['image/png','image/jpeg','image/webp'];

export function ChatFileMessage({file}:{file:PrivateAttachment}){
  const [expanded,setExpanded]=useState(false),[error,setError]=useState(''),[downloading,setDownloading]=useState(false),[failedImage,setFailedImage]=useState(false);
  const image=imageTypes.includes(file.content_type),source=api.privateAttachmentPreviewUrl(file);
  async function download(){if(downloading)return;setDownloading(true);setError('');try{await api.downloadPrivateAttachment(file);}catch(reason){setError(reason instanceof Error?reason.message:'File could not be downloaded.');}finally{setDownloading(false);}}
  return <div className={`chat-file-message${image?' is-image':''}`}>
    {file.content_type.startsWith('audio/')&&<audio controls preload="none" src={source} aria-label={`Play ${file.name}`}/>}
    {image&&!failedImage&&<button type="button" className="chat-file-image" aria-label={`Preview ${file.name}`} onClick={()=>setExpanded(true)}><img loading="lazy" src={source} alt={file.name} onError={()=>setFailedImage(true)}/><span><Maximize2 size={18}/></span></button>}
    {file.content_type.startsWith('audio/')&&<audio controls preload="none" src={source} aria-label={`Play ${file.name}`}/>}
    <div className="chat-file-document"><span className="chat-file-type">{image?<ImageIcon size={21}/>:<FileText size={23}/>}</span><div><strong title={file.name}>{file.name}</strong><small>{sizeLabel(file.size)} · {file.name.split('.').pop()?.toUpperCase()}</small></div><button type="button" className="icon-button" disabled={downloading} aria-label={`Download ${file.name}`} title="Download" onClick={()=>void download()}><Download size={18}/></button></div>
    {failedImage&&<small className="chat-file-error">Image preview unavailable. You can still download the file.</small>}
    {error&&<p className="chat-file-error" role="alert">{error}</p>}
    {expanded&&<WorkspaceDialog title={file.name} onClose={()=>setExpanded(false)}><div className="chat-file-large-preview"><img src={source} alt={file.name}/><button type="button" className="outline-button" disabled={downloading} onClick={()=>void download()}><Download size={16}/>Download</button>{error&&<p role="alert">{error}</p>}</div></WorkspaceDialog>}
  </div>;
}

export function ChatComposer({draft,onDraft,onBlur,people,busy,onSendText,onSendFile}:{draft:string;onDraft:(value:string)=>void;onBlur:()=>void;people:Person[];busy:boolean;onSendText:(event:FormEvent)=>Promise<void>;onSendFile:(file:File)=>Promise<void>}){
  const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState(''),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),sending=useRef(false),live=useRef(true),form=useRef<HTMLFormElement>(null),textarea=useRef<HTMLTextAreaElement>(null),emojiRoot=useRef<HTMLDivElement>(null);
  const [emojiOpen,setEmojiOpen]=useState(false),[recording,setRecording]=useState(false);
  useEffect(()=>{if(!emojiOpen)return;function outside(event:PointerEvent){if(!emojiRoot.current?.contains(event.target as Node))setEmojiOpen(false);}function escape(event:KeyboardEvent){if(event.key==='Escape'){setEmojiOpen(false);textarea.current?.focus();}}document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[emojiOpen]);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{if(!file||!imageTypes.includes(file.type)){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  async function submit(event:FormEvent){
    event.preventDefault();if(busy||sending.current||recording)return;
    if(!file){await onSendText(event);return;}
    sending.current=true;setError('');
    try{await onSendFile(file);if(live.current)setFile(null);}
    catch(reason){if(live.current)setError(reason instanceof Error?reason.message:'File could not be sent. Try again.');}
    finally{sending.current=false;}
  }
  return <form ref={form} className="private-chat-compose chat-file-compose" onSubmit={event=>void submit(event)}>
    {file&&<div className="chat-pending-file" role="group" aria-label="Attachment preview">
      <div className="chat-pending-heading"><strong>Ready to send</strong><button type="button" className="icon-button" disabled={busy} aria-label="Remove attachment" onClick={()=>{setFile(null);setError('');}}><X size={18}/></button></div>
      {preview?<img src={preview} alt={`Preview ${file.name}`}/>:file.type.startsWith('audio/')?<AudioDraft file={file}/>:<div className="chat-pending-document"><FileText size={32}/><span>{file.name.split('.').pop()?.toUpperCase()} document</span></div>}
      <div className="chat-pending-name"><strong>{file.name}</strong><small>{sizeLabel(file.size)}</small></div>
    </div>}
    {error&&<p className="chat-file-error" role="alert">{error}</p>}
    <fieldset className="chat-compose-fields" disabled={busy}>
      <input ref={input} className="chat-file-picker" aria-label="Choose attachment" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.webm,.ogg,.m4a,.mp3" onChange={event=>{
        const chosen=event.target.files?.[0];event.target.value='';if(!chosen)return;
        if(!/\.(png|jpe?g|webp|pdf|txt|webm|ogg|m4a|mp3)$/i.test(chosen.name)){setError('Choose a PNG, JPEG, WebP, PDF, TXT, or supported audio file.');return;}
        if(!chosen.size||chosen.size>5*1024*1024){setError('Choose a nonempty file up to 5 MB.');return;}
        setFile(chosen);setError('');
      }}/>
      <button type="button" className="chat-paperclip icon-button" aria-label="Attach a file" title="Attach a file" disabled={recording} onClick={()=>input.current?.click()}><Paperclip size={21}/></button>
      <div ref={emojiRoot} className="chat-compose-emoji"><button type="button" className="icon-button" aria-label="Choose emoji" aria-expanded={emojiOpen} onClick={()=>setEmojiOpen(value=>!value)}><Smile size={21}/></button>{emojiOpen&&<div className="chat-compose-emoji-picker" role="group" aria-label="Emoji picker">{['😀','😃','😊','🙂','😂','😍','🥰','😎','🤔','😢','😭','😮','👍','👎','👏','🙏','🤝','👌','❤️','💙','💚','🎉','🎊','✨','✅','💯','🔥','💡','👀','🙌','👋','🚀'].map(emoji=><button type="button" key={emoji} aria-label={`Insert ${emoji}`} onClick={()=>{const start=textarea.current?.selectionStart??draft.length,end=textarea.current?.selectionEnd??draft.length;if(draft.length-(end-start)+emoji.length>4000)return;onDraft(draft.slice(0,start)+emoji+draft.slice(end));setEmojiOpen(false);window.setTimeout(()=>{textarea.current?.focus();textarea.current?.setSelectionRange(start+emoji.length,start+emoji.length);},0);}}>{emoji}</button>)}</div>}</div>
      <MentionInput multiline textareaRef={textarea} onEnterSend={()=>form.current?.requestSubmit()} disabled={recording||busy} ariaLabel="Write a message" value={draft} placeholder={file?'Add a caption…':'Write a message…'} people={people} onChange={onDraft} onBlur={onBlur}/>
      {!file&&<VoiceNoteRecorder disabled={busy||Boolean(draft.trim())} onRecordingChange={setRecording} onReady={note=>{setFile(note);setError('');}}/>}
      <button className="send-button" aria-label="Send message" title={file?'Send attachment':'Send message'} disabled={busy||recording||(!file&&!draft.trim())}><Send size={18}/></button>
    </fieldset>
    {busy&&file&&<small className="chat-file-sending" role="status">Sending attachment…</small>}
  </form>;
}

function AudioDraft({file}:{file:File}){
  const [source,setSource]=useState('');
  useEffect(()=>{const url=URL.createObjectURL(file);setSource(url);return()=>URL.revokeObjectURL(url);},[file]);
  return <audio controls src={source} aria-label="Preview voice note"/>;
}
