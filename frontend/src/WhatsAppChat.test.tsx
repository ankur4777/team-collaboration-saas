import {useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ChatComposer} from './ChatFileMessage';
import VoiceNoteRecorder from './VoiceNoteRecorder';
import ChatDetails from './ChatDetails';
import ChatCallControls from './ChatCallControls';
import ForwardMessageDialog from './ForwardMessageDialog';
import {api,meetingsApi,type ChatThread,type Person,type MeetingRecord} from './api';

vi.mock('./CallRoom',()=>({default:({initialVideo,onLeave}:{initialVideo:boolean;onLeave:()=>void})=><div role="region" aria-label="Call room" data-video={String(initialVideo)}><button onClick={onLeave}>Leave call</button></div>}));
const me:Person={id:'me',full_name:'Sender',email:'sender@test.invalid',email_verified:true};
const peer:Person={...me,id:'peer',full_name:'Peer',email:'peer@test.invalid'};
const now='2026-11-28T08:00:00Z';
const chat:ChatThread={id:'chat',kind:'direct',title:'',created_at:now,updated_at:now,created_by:me,unread_count:0,participants:[me,peer].map(user=>({user,joined_at:now,last_read_at:null}))};
const attachment={id:'file',name:'Guide.pdf',size:1024,content_type:'application/pdf',created_at:now,uploaded_by:me};
const message={id:'message',body:'Project handover',sender:me,created_at:now,edited_at:null,deleted_at:null,reactions:[],attachment};
beforeEach(()=>{vi.spyOn(URL,'createObjectURL').mockImplementation(()=> 'blob:voice');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
if(!URL.createObjectURL)URL.createObjectURL=()=> 'blob:voice';
if(!URL.revokeObjectURL)URL.revokeObjectURL=()=>{};
if(!HTMLDialogElement.prototype.showModal)HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
if(!HTMLDialogElement.prototype.close)HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};

function Composer({send}:{send:()=>Promise<void>}){
  const [draft,setDraft]=useState('');
  return <ChatComposer draft={draft} onDraft={setDraft} onBlur={vi.fn()} people={[peer]} busy={false} onSendText={send} onSendFile={vi.fn()}/>;
}

describe('WhatsApp message composer',()=>{
  it('uses Shift+Enter for a new line and Enter for send',async()=>{
    const send=vi.fn().mockResolvedValue(undefined),user=userEvent.setup();render(<Composer send={send}/>);
    const field=screen.getByRole('textbox',{name:'Write a message'});expect(field.tagName).toBe('TEXTAREA');
    await user.type(field,'First line');await user.keyboard('{Shift>}{Enter}{/Shift}');await user.type(field,'Second line');
    expect(field).toHaveProperty('value','First line\nSecond line');expect(send).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');expect(send).toHaveBeenCalledOnce();
  });

  it('inserts emoji at the cursor and preserves mention selection',async()=>{
    const send=vi.fn().mockResolvedValue(undefined),user=userEvent.setup();render(<Composer send={send}/>);
    const field=screen.getByRole('textbox',{name:'Write a message'}) as HTMLTextAreaElement;
    await user.type(field,'Hello');field.setSelectionRange(0,0);
    await user.click(screen.getByRole('button',{name:'Choose emoji'}));await user.click(screen.getByRole('button',{name:'Insert 👍'}));
    expect(field.value).toBe('👍Hello');
    await user.clear(field);await user.type(field,'@Pe');
    expect(screen.getByRole('listbox',{name:'Mention a teammate'})).toBeTruthy();
    await user.keyboard('{Enter}');expect(field.value).toBe('@Peer ');expect(send).not.toHaveBeenCalled();
  });
});

class Recorder {
  static isTypeSupported=()=>true;
  state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
  start(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['voice'],{type:'audio/webm'})});this.onstop?.();}
}

describe('Voice notes',()=>{
  it('asks for the microphone only when clicked, stops tracks and returns a reviewable file',async()=>{
    const stop=vi.fn(),getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[{stop}]}),ready=vi.fn();
    vi.stubGlobal('MediaRecorder',Recorder);vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
    const user=userEvent.setup({document});render(<VoiceNoteRecorder onReady={ready}/>);
    expect(getUserMedia).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Record voice note'}));
    await user.click(await screen.findByRole('button',{name:'Stop and preview voice note'}));
    expect(getUserMedia).toHaveBeenCalledWith({audio:true});expect(stop).toHaveBeenCalled();
    expect(ready.mock.calls[0][0]).toBeInstanceOf(File);expect(ready.mock.calls[0][0].type).toBe('audio/webm');
  });

  it('discards cancelled recording and releases the microphone',async()=>{
    const stop=vi.fn(),ready=vi.fn();vi.stubGlobal('MediaRecorder',Recorder);vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})}});
    const user=userEvent.setup({document});render(<VoiceNoteRecorder onReady={ready}/>);
    await user.click(screen.getByRole('button',{name:'Record voice note'}));await user.click(await screen.findByRole('button',{name:'Cancel voice recording'}));
    expect(ready).not.toHaveBeenCalled();expect(stop).toHaveBeenCalled();
  });

  it('stops an active recording when leaving the chat and handles permission denial',async()=>{
    const stop=vi.fn(),ready=vi.fn(),getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[{stop}]});
    vi.stubGlobal('MediaRecorder',Recorder);vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
    const user=userEvent.setup({document}),view=render(<VoiceNoteRecorder onReady={ready}/>);
    await user.click(screen.getByRole('button',{name:'Record voice note'}));await screen.findByRole('button',{name:'Cancel voice recording'});
    view.unmount();expect(stop).toHaveBeenCalled();expect(ready).not.toHaveBeenCalled();
    getUserMedia.mockRejectedValue(new Error('Permission denied'));render(<VoiceNoteRecorder onReady={ready}/>);
    await user.click(screen.getByRole('button',{name:'Record voice note'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','Permission denied');
  });
});

describe('Chat details and search',()=>{
  it('searches the active chat and opens the selected historical message',async()=>{
    vi.spyOn(api,'searchChatMessages').mockResolvedValue({items:[message],has_more:false,next_cursor:null});
    const open=vi.fn(),user=userEvent.setup();render(<ChatDetails chat={chat} mode="search" currentUserId={me.id} onClose={vi.fn()} onOpenMessage={open}/>);
    await user.type(screen.getByRole('searchbox',{name:'Search this conversation'}),'handover');await user.click(screen.getByRole('button',{name:'Find messages'}));
    await user.click(await screen.findByRole('button',{name:/Project handover/}));
    expect(api.searchChatMessages).toHaveBeenCalledWith(chat.id,'handover',null);expect(open).toHaveBeenCalledWith(message.id);
  });

  it('browses shared files with filters and pagination',async()=>{
    const cursor={before:now,before_id:'file'};
    vi.spyOn(api,'chatMedia').mockResolvedValueOnce({items:[attachment],next_cursor:cursor}).mockResolvedValueOnce({items:[{...attachment,id:'image',name:'Photo.png',content_type:'image/png'}],next_cursor:null});
    const user=userEvent.setup();render(<ChatDetails chat={chat} mode="media" currentUserId={me.id} onClose={vi.fn()} onOpenMessage={vi.fn()}/>);
    expect(await screen.findByText('Guide.pdf')).toBeTruthy();await user.click(screen.getByRole('button',{name:'Load more'}));
    await screen.findByRole('button',{name:'Preview Photo.png'});await user.click(screen.getByRole('button',{name:'Photos'}));
    expect(screen.queryByText('Guide.pdf')).toBeNull();expect(screen.getByRole('button',{name:'Preview Photo.png'})).toBeTruthy();
    expect(api.chatMedia).toHaveBeenLastCalledWith(chat.id,cursor);
  });
});

it('forwards a file and caption to chat destinations',async()=>{
  vi.spyOn(api,'forwardDestinations').mockResolvedValue([{kind:'chat',id:'destination',label:'Project'},{kind:'channel',id:'channel',label:'General'}]);
  vi.spyOn(api,'forwardMessage').mockResolvedValue({kind:'chat',destination_id:'destination',message});
  const user=userEvent.setup();render(<ForwardMessageDialog kind="chat" sourceId={chat.id} message={message} onClose={vi.fn()} onSent={vi.fn()}/>);
  await screen.findByRole('option',{name:'Chat: Project'});expect(screen.queryByRole('option',{name:'Channel: General'})).toBeNull();
  await user.selectOptions(screen.getByRole('combobox',{name:'Forward destination'}),'chat:destination');await user.click(screen.getByRole('button',{name:'Forward'}));
  expect(api.forwardMessage).toHaveBeenCalledWith('chat',chat.id,message.id,{kind:'chat',id:'destination',label:'Project'});
});

it('starts a voice call with the camera off and invites only chat participants',async()=>{
  vi.spyOn(meetingsApi,'create').mockResolvedValue({id:'meeting'} as MeetingRecord);
  const user=userEvent.setup();render(<ChatCallControls chat={chat} userId={me.id}/>);
  await user.click(screen.getByRole('button',{name:'Start voice call'}));
  const room=await screen.findByRole('region',{name:'Call room'});expect(room.getAttribute('data-video')).toBe('false');
  expect(meetingsApi.create).toHaveBeenCalledWith(expect.objectContaining({attendee_ids:[peer.id],channel_id:null,invite_channel:false}));
  await user.click(within(room).getByRole('button',{name:'Leave call'}));expect(screen.queryByRole('region',{name:'Call room'})).toBeNull();
});
