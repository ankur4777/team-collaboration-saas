import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,waitFor,cleanup,within,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailPanel from './EmailPanel';
import {mailApi,type MailMessage} from './mailApi';

vi.mock('./mailApi',async()=>{
  const original=await vi.importActual<typeof import('./mailApi')>('./mailApi');
  return {...original,mailApi:{accounts:vi.fn(),config:vi.fn(),folders:vi.fn(),messages:vi.fn(),detail:vi.fn(),
    action:vi.fn(),draft:vi.fn(),send:vi.fn(),discard:vi.fn(),local:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}};
});
const account={id:'account-1',provider:'local' as const,email:'alice@example.test',display_name:'Alice',needs_reconnect:false};
const message:MailMessage={id:'message-1',subject:'Project review',sender:'bob@example.test',sender_name:'Bob',
  to:['alice@example.test'],cc:[],bcc:[],preview:'Please review this project.',body:'Please review this project.',
  date:'2026-11-16T09:00:00Z',is_read:false,is_starred:false,folder:'inbox',has_attachments:false,attachments:[],
  reply_to:['bob@example.test'],internet_id:'<message1@example.test>',thread_id:'thread-1'};
beforeEach(()=>{
  vi.mocked(mailApi.accounts).mockResolvedValue([account]);
  vi.mocked(mailApi.config).mockResolvedValue({local_enabled:true,gmail_configured:false,outlook_configured:false,max_attachment_bytes:5242880,max_total_attachment_bytes:10485760});
  vi.mocked(mailApi.folders).mockResolvedValue([{id:'inbox',name:'Inbox',total:1,unread:1}]);
  vi.mocked(mailApi.messages).mockResolvedValue({results:[message],next_cursor:''});
  vi.mocked(mailApi.detail).mockResolvedValue(message);
  vi.mocked(mailApi.action).mockResolvedValue({});
  vi.mocked(mailApi.draft).mockResolvedValue({draft_id:'draft-1'});
  vi.mocked(mailApi.send).mockResolvedValue({status:'sent'});
  vi.mocked(mailApi.discard).mockResolvedValue(undefined);
  vi.spyOn(window,'confirm').mockReturnValue(true);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const mount=()=>render(<EmailPanel workspaceId="org-1" user={{email:'alice@example.test',email_verified:true}}/>);

describe('Email inbox interactions',()=>{
  it('loads mail, reads a message and marks it read',async()=>{
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:/Bob.*Project review/}));
    expect(await screen.findByRole('heading',{name:'Project review'})).toBeTruthy();
    expect(screen.getByText('Please review this project.',{selector:'.email-body'})).toBeTruthy();
    await waitFor(()=>expect(mailApi.action).toHaveBeenCalledWith('account-1','message-1','read'));
  });
  it('composes, saves a draft and sends with one idempotency key',async()=>{
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:'New Email'}));
    const compose=screen.getByRole('dialog',{name:'New Email'});
    await user.type(within(compose).getByRole('textbox',{name:'To recipients'}),'bob@example.test');
    await user.type(within(compose).getByRole('textbox',{name:'Subject'}),'Hello Bob');
    await user.type(within(compose).getByRole('textbox',{name:'Email message body'}),'Hello from the composer.');
    await user.click(within(compose).getByRole('button',{name:'Save draft'}));
    expect(await screen.findByText('Draft saved to this mailbox.')).toBeTruthy();
    await user.click(within(compose).getByRole('button',{name:'Send'}));
    await waitFor(()=>expect(mailApi.send).toHaveBeenCalledTimes(1));
    const [,payload,key]=vi.mocked(mailApi.send).mock.calls[0];
    expect(payload.to).toEqual(['bob@example.test']);expect(payload.draft_id).toBe('draft-1');expect(key).toBeTruthy();
    expect(await screen.findByText('Message sent.')).toBeTruthy();
  });
  it('prefills a reply without exposing Bcc',async()=>{
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:/Bob.*Project review/}));
    await screen.findByRole('heading',{name:'Project review'});
    await user.click(screen.getByRole('button',{name:'Reply'}));
    const compose=screen.getByRole('dialog',{name:'Reply'});
    expect((within(compose).getByRole('textbox',{name:'To recipients'}) as HTMLInputElement).value).toBe('bob@example.test');
    expect((within(compose).getByRole('textbox',{name:'Subject'}) as HTMLInputElement).value).toBe('Re: Project review');
    expect((within(compose).getByRole('textbox',{name:'Bcc recipients'}) as HTMLInputElement).value).toBe('');
  });
  it('freezes an uncertain send instead of allowing a duplicate',async()=>{
    vi.mocked(mailApi.send).mockResolvedValue({status:'uncertain',detail:'Check Sent before sending again.'});
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:'New Email'}));
    await user.type(screen.getByRole('textbox',{name:'To recipients'}),'bob@example.test');
    await user.click(screen.getByRole('button',{name:'Send'}));
    expect(await screen.findByText('Check Sent before sending again.')).toBeTruthy();
    expect((screen.getByRole('button',{name:'Send'}) as HTMLButtonElement).disabled).toBe(true);
    expect(mailApi.send).toHaveBeenCalledTimes(1);
  });
  it('submits a folder search to the backend',async()=>{
    const user=userEvent.setup();mount();await screen.findByRole('heading',{name:'Inbox'});
    await user.type(screen.getByRole('textbox',{name:'Search mailbox'}),'invoice');
    await user.click(screen.getByRole('button',{name:'Search'}));
    await waitFor(()=>expect(mailApi.messages).toHaveBeenLastCalledWith('account-1','inbox','invoice','',expect.any(AbortSignal)));
  });
  it('shows a real connection empty state instead of sample mailbox messages',async()=>{
    vi.mocked(mailApi.accounts).mockResolvedValue([]);
    const user=userEvent.setup();mount();
    expect(await screen.findByText('Your mail, all in one place')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Add mailbox'}));
    const modal=screen.getByRole('dialog',{name:'Your mailboxes'});
    const gmail=within(modal).getByRole('button',{name:/Connect Gmail/});
    expect((gmail as HTMLButtonElement).disabled).toBe(true);
    expect(within(modal).getByRole('button',{name:/Add local workspace mailbox/})).toBeTruthy();
  });
  it('clears old account message state when switching mailboxes',async()=>{
    vi.mocked(mailApi.accounts).mockResolvedValue([account,{...account,id:'account-2',email:'other@example.test'}]);
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:/Bob.*Project review/}));
    await screen.findByRole('heading',{name:'Project review'});
    vi.mocked(mailApi.messages).mockResolvedValue({results:[],next_cursor:''});
    await user.selectOptions(screen.getByLabelText('MAILBOX'),'account-2');
    await waitFor(()=>expect(screen.queryByRole('heading',{name:'Project review'})).toBeNull());
    expect(await screen.findByText('Select a message to read')).toBeTruthy();
  });
  it('refreshes on focus without overlapping requests or losing an open message',async()=>{
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('button',{name:/Bob.*Project review/}));
    await screen.findByRole('heading',{name:'Project review'});
    await waitFor(()=>expect(mailApi.action).toHaveBeenCalled());
    const before=vi.mocked(mailApi.messages).mock.calls.length;
    const newMessage={...message,id:'message-2',subject:'New arrival'};
    let resolve!: (value:{results:MailMessage[];next_cursor:string})=>void;
    vi.mocked(mailApi.messages).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    act(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
    await waitFor(()=>expect(mailApi.messages).toHaveBeenCalledTimes(before+1));
    await act(async()=>{resolve({results:[newMessage,message],next_cursor:''});});
    expect(await screen.findByRole('button',{name:/Bob.*New arrival/})).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Project review'})).toBeTruthy();
  });

  it('filters unread messages on the current page without fetching a different mailbox',async()=>{
    vi.mocked(mailApi.messages).mockResolvedValue({results:[message,{...message,id:'message-2',subject:'Already read',is_read:true}],next_cursor:''});
    const user=userEvent.setup();mount();
    await screen.findByRole('button',{name:/Bob.*Already read/});
    await user.click(screen.getByRole('button',{name:'Unread'}));
    expect(screen.queryByRole('button',{name:/Bob.*Already read/})).toBeNull();
    expect(screen.getByRole('button',{name:/Bob.*Project review/})).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'All mail'}));
    expect(screen.getByRole('button',{name:/Bob.*Already read/})).toBeTruthy();
  });
  it('uses the command toolbar to archive checked messages only',async()=>{
    vi.mocked(mailApi.messages).mockResolvedValue({results:[message,{...message,id:'message-2',subject:'Keep this email'}],next_cursor:''});
    const user=userEvent.setup();mount();
    await user.click(await screen.findByRole('checkbox',{name:'Select Project review'}));
    await user.click(within(screen.getByRole('toolbar',{name:'Mail actions'})).getByRole('button',{name:'Archive'}));
    await waitFor(()=>expect(mailApi.action).toHaveBeenCalledWith('account-1','message-1','archive'));
    expect(mailApi.action).not.toHaveBeenCalledWith('account-1','message-2','archive');
  });

});

