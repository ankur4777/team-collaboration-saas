import {useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ChatComposer,ChatFileMessage} from './ChatFileMessage';
import ChatPanel from './ChatPanel';
import {api,csrf,type ChatThread,type PrivateAttachment,type Person} from './api';

vi.mock('./conversationSocket',()=>({connectConversationSocket:(_path:string,callbacks:{onAttempt:()=>void})=>{callbacks.onAttempt();return()=>{};},mergeFreshHistory:(items:unknown[])=>items}));
const me:Person={id:'me',full_name:'Sender',email:'sender@example.com',email_verified:true};
const peer={...me,id:'peer',full_name:'Peer',email:'peer@example.com'};
const file:PrivateAttachment={id:'file',name:'Photo.png',size:1000,content_type:'image/png',created_at:'2026-11-28T08:00:00Z',uploaded_by:me};
const createUrl=vi.fn(()=> 'blob:attachment-preview'),revokeUrl=vi.fn();
const upload=new File(['png'],'Photo.png',{type:'image/png'});
if(!HTMLDialogElement.prototype.showModal)HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
if(!HTMLDialogElement.prototype.close)HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
beforeEach(()=>{createUrl.mockClear();revokeUrl.mockClear();vi.stubGlobal('URL',class extends URL{static createObjectURL=createUrl;static revokeObjectURL=revokeUrl;});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

function Composer({sendFile=vi.fn().mockResolvedValue(undefined),sendText=vi.fn().mockResolvedValue(undefined),busy=false}:{sendFile?:(file:File)=>Promise<void>;sendText?:()=>Promise<void>;busy?:boolean}){
  const [draft,setDraft]=useState('');
  return <ChatComposer draft={draft} onDraft={setDraft} onBlur={vi.fn()} people={[]} busy={busy} onSendText={sendText} onSendFile={sendFile}/>;
}

describe('WhatsApp style attachment composer',()=>{
  it('previews before sending and removes a selection without uploading',async()=>{
    const sendFile=vi.fn().mockResolvedValue(undefined),user=userEvent.setup();render(<Composer sendFile={sendFile}/>);
    expect(screen.getByRole('button',{name:'Attach a file'})).toBeTruthy();
    await user.upload(screen.getByLabelText('Choose attachment'),upload);
    expect(screen.getByRole('img',{name:'Preview Photo.png'}).getAttribute('src')).toBe('blob:attachment-preview');
    expect(sendFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Remove attachment'}));
    expect(screen.queryByRole('group',{name:'Attachment preview'})).toBeNull();
    expect(sendFile).not.toHaveBeenCalled();expect(revokeUrl).toHaveBeenCalledWith('blob:attachment-preview');
  });

  it('sends a document without requiring text and clears the preview after success',async()=>{
    const sendFile=vi.fn().mockResolvedValue(undefined),sendText=vi.fn().mockResolvedValue(undefined),user=userEvent.setup();
    render(<Composer sendFile={sendFile} sendText={sendText}/>);
    const document=new File(['%PDF'],'Guide.pdf',{type:'application/pdf'});
    await user.upload(screen.getByLabelText('Choose attachment'),document);
    expect(screen.getByText('PDF document')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Send message'}));
    expect(sendFile).toHaveBeenCalledWith(document);expect(sendText).not.toHaveBeenCalled();
    await waitFor(()=>expect(screen.queryByRole('group',{name:'Attachment preview'})).toBeNull());
  });

  it('keeps the file and caption after a failed send and permits retry',async()=>{
    const sendFile=vi.fn().mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValue(undefined),user=userEvent.setup();
    render(<Composer sendFile={sendFile}/>);
    await user.upload(screen.getByLabelText('Choose attachment'),upload);
    await user.type(screen.getByRole('textbox',{name:'Write a message'}),'Project image');
    await user.click(screen.getByRole('button',{name:'Send message'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Connection failed');
    expect(screen.getByRole('group',{name:'Attachment preview'})).toBeTruthy();
    expect(screen.getByRole('textbox',{name:'Write a message'})).toHaveProperty('value','Project image');
    await user.click(screen.getByRole('button',{name:'Send message'}));
    await waitFor(()=>expect(sendFile).toHaveBeenCalledTimes(2));
  });

  it('blocks oversized and unsupported files before sending',async()=>{
    const sendFile=vi.fn().mockResolvedValue(undefined),user=userEvent.setup({applyAccept:false});render(<Composer sendFile={sendFile}/>);
    await user.upload(screen.getByLabelText('Choose attachment'),new File([new Uint8Array(5*1024*1024+1)],'big.png',{type:'image/png'}));
    expect((await screen.findByRole('alert')).textContent).toContain('5 MB');
    await user.upload(screen.getByLabelText('Choose attachment'),new File(['svg'],'bad.svg',{type:'image/svg+xml'}));
    expect(screen.getByRole('alert').textContent).toContain('PNG');
    expect(sendFile).not.toHaveBeenCalled();expect(createUrl).not.toHaveBeenCalled();
  });

  it('prevents duplicate submission while a file send is in progress',async()=>{
    let finish!:()=>void;
    const sendFile=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),user=userEvent.setup();render(<Composer sendFile={sendFile}/>);
    await user.upload(screen.getByLabelText('Choose attachment'),upload);
    await user.click(screen.getByRole('button',{name:'Send message'}));
    await user.click(screen.getByRole('button',{name:'Send message'}));expect(sendFile).toHaveBeenCalledOnce();
    finish();await waitFor(()=>expect(screen.queryByRole('group',{name:'Attachment preview'})).toBeNull());
  });
});

describe('Inline file bubbles',()=>{
  it('opens a full photo preview and downloads through the private attachment API',async()=>{
    vi.spyOn(api,'downloadPrivateAttachment').mockResolvedValue();const user=userEvent.setup();render(<ChatFileMessage file={file}/>);
    expect(screen.getByRole('img',{name:file.name}).getAttribute('src')).toBe('/api/attachments/file/download/?preview=1');
    await user.click(screen.getByRole('button',{name:'Preview Photo.png'}));
    const viewer=within(screen.getByRole('dialog',{name:file.name}));expect(viewer.getByRole('img',{name:file.name})).toBeTruthy();
    await user.click(viewer.getByRole('button',{name:'Download'}));expect(api.downloadPrivateAttachment).toHaveBeenCalledWith(file);
    await user.click(viewer.getByRole('button',{name:'Close dialog'}));expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a download option when an image preview cannot load',()=>{
    render(<ChatFileMessage file={file}/>);fireEvent.error(screen.getByRole('img',{name:file.name}));
    expect(screen.getByRole('button',{name:'Download Photo.png'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Preview Photo.png'})).toBeNull();
  });
});

it('sends a caption and inserts the returned file message into its selected chat',async()=>{
  HTMLElement.prototype.scrollIntoView=vi.fn();
  const now=file.created_at;
  const chat:ChatThread={id:'chat',kind:'direct',title:'',created_at:now,updated_at:now,created_by:me,unread_count:0,participants:[me,peer].map(user=>({user,joined_at:now,last_read_at:null}))};
  vi.spyOn(api,'chats').mockResolvedValue([chat]);
  vi.spyOn(api,'chatDirectory').mockResolvedValue({departments:[],teams:[],members:[],can_manage:false,can_create_groups:false,can_assign_tasks:false});
  vi.spyOn(api,'chatMessagePage').mockResolvedValue({items:[],has_more:false,next_cursor:null});
  vi.spyOn(api,'markChatRead').mockResolvedValue({last_read_at:now});
  const message={id:'sent',body:'Look at this photo',sender:me,created_at:now,edited_at:null,deleted_at:null,reactions:[],attachment:file};
  vi.spyOn(api,'uploadChatAttachment').mockResolvedValue({...file,message});
  const user=userEvent.setup();render(<ChatPanel workspaceId="org" currentUser={me} members={[]}/>);
  await user.click(await screen.findByRole('button',{name:/Peer/}));
  await user.upload(screen.getByLabelText('Choose attachment'),upload);
  await user.type(screen.getByRole('textbox',{name:'Write a message'}),'Look at this photo');
  await user.click(screen.getByRole('button',{name:'Send message'}));
  await waitFor(()=>expect(api.uploadChatAttachment).toHaveBeenCalledWith('chat',upload,'Look at this photo',undefined));
  expect(await screen.findByRole('button',{name:'Preview Photo.png'})).toBeTruthy();
  expect(screen.getByText('Look at this photo')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'Write a message'})).toHaveProperty('value','');
  expect(screen.queryByRole('region',{name:'Shared attachments'})).toBeNull();
});

it('includes caption and reply metadata in the authenticated multipart upload',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({csrf_token:'token'})}).mockResolvedValueOnce({ok:true,json:async()=>file});
  vi.stubGlobal('fetch',fetchMock);await csrf();await api.uploadChatAttachment('chat',upload,'Caption','reply-id');
  const [url,options]=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
  expect(url).toBe('/api/chats/chat/attachments/');expect(options.credentials).toBe('same-origin');expect(options.headers).toEqual({'X-CSRFToken':'token'});
  const body=options.body as FormData;expect(body.get('file')).toBe(upload);expect(body.get('caption')).toBe('Caption');expect(body.get('reply_to_id')).toBe('reply-id');
});
