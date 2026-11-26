import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel from './ChatPanel';
import {DraftProvider} from './conversationDrafts';
import {api,type ChatThread,type Person,type Member} from './api';

vi.mock('./api',async importOriginal=>{
  const actual=await importOriginal<typeof import('./api')>();
  return {...actual,api:{...actual.api,chats:vi.fn(),chatMessagePage:vi.fn(),chatAttachments:vi.fn(),chatPins:vi.fn(),messageContext:vi.fn()}};
});
vi.mock('./conversationSocket',()=>({connectConversationSocket:(_path:string,callbacks:{onAttempt:()=>void})=>{callbacks.onAttempt();return ()=>{};},mergeFreshHistory:(items:unknown[])=>items}));
const now='2026-01-01T12:00:00Z';
const person=(id:string,name:string):Person=>({id,full_name:name,email:id+'@example.test',email_verified:true});
const me=person('me','Owner');
const thread=(id:string,name:string):ChatThread=>({id,kind:'direct',title:'',created_at:now,updated_at:now,created_by:me,unread_count:0,participants:[me,person(id,name)].map(user=>({user,joined_at:now,last_read_at:null}))});
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),thread('two','Second colleague')]);
  vi.mocked(api.chatMessagePage).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  vi.mocked(api.chatAttachments).mockResolvedValue([]);
  vi.mocked(api.chatPins).mockResolvedValue({items:[],has_more:false});
  vi.mocked(api.messageContext).mockResolvedValue({items:[{id:'message',body:'Search result message',sender:me,created_at:now,edited_at:null,deleted_at:null}]});
});
afterEach(cleanup);

describe('Chat conversation panel identity',()=>{
  it('keeps one pins panel, attachment panel and composer across chat switches and search navigation',async()=>{
    const user=userEvent.setup();
    const props={workspaceId:'org',currentUser:me,members:[]};
    const view=render(<ChatPanel {...props}/>);
    await screen.findByRole('heading',{name:'First colleague'});
    const check=()=>{
      expect(screen.getAllByRole('button',{name:/^Pinned messages$/})).toHaveLength(1);
      expect(screen.getAllByRole('region',{name:'Shared attachments'})).toHaveLength(1);
      expect(screen.getAllByRole('button',{name:'Send message'})).toHaveLength(1);
    };
    check();
    await user.click(screen.getByRole('button',{name:/^Pinned messages$/}));
    await screen.findByText('No pinned messages yet.');
    await user.click(screen.getByRole('button',{name:/Second colleague/}));
    await screen.findByRole('heading',{name:'Second colleague'});
    check();
    await user.click(screen.getByRole('button',{name:/First colleague/}));
    await screen.findByRole('heading',{name:'First colleague'});
    check();
    view.rerender(<ChatPanel {...props} requestedChat={{id:'two',nonce:1,messageId:'message'}}/>);
    await screen.findByText('Search result message');
    await waitFor(()=>expect(screen.getByRole('heading',{name:'Second colleague'})).toBeTruthy());
    check();
    await user.click(screen.getByRole('button',{name:'Return to latest messages'}));
    check();
  });
});

describe('Group member selection',()=>{
  it('selects teammates by clicking their rows and keeps create disabled until two are selected',async()=>{
    const user=userEvent.setup();
    const members:Member[]=[person('one','First colleague'),person('two','Second colleague')].map(p=>({id:p.id,user:p,role:'member',joined_at:now}));
    render(<ChatPanel workspaceId="org" currentUser={me} members={members}/>);
    await user.click(screen.getByRole('button',{name:'Create group chat'}));
    const dialog=screen.getByRole('dialog');
    const groupName=dialog.querySelector<HTMLInputElement>('input[placeholder="e.g. Design discussion"]');
    expect(groupName).toBeTruthy();
    await user.type(groupName!,'Project group');
    const first=screen.getByRole('checkbox',{name:'First colleague (one@example.test)'}) as HTMLInputElement;
    const second=screen.getByRole('checkbox',{name:'Second colleague (two@example.test)'}) as HTMLInputElement;
    const create=Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent?.trim()==='Create');
    expect(create).toBeTruthy();
    expect(create!.disabled).toBe(true);
    await user.click(first.closest('label')!);
    expect(first.checked).toBe(true);
    expect(first.closest('label')?.classList.contains('selected')).toBe(true);
    expect(create!.disabled).toBe(true);
    await user.click(second.closest('label')!);
    expect(second.checked).toBe(true);
    expect(create!.disabled).toBe(false);
    await user.click(first);
    expect(first.checked).toBe(false);
    expect(create!.disabled).toBe(true);
  });
});

describe('Conversation draft isolation',()=>{
  it('keeps direct and group drafts separate and restores them after switching',async()=>{
    const user=userEvent.setup();
    vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),{...thread('two','Second colleague'),kind:'group',title:'Project group'}]);
    render(<DraftProvider><ChatPanel workspaceId="org" currentUser={me} members={[]}/></DraftProvider>);
    await screen.findByRole('heading',{name:'First colleague'});
    const composer=()=>screen.getByRole('textbox',{name:'Write a message'}) as HTMLInputElement;
    await user.type(composer(),'Direct draft');
    await user.click(screen.getByRole('button',{name:/Project group/}));
    await screen.findByRole('heading',{name:'Project group'});
    expect(composer().value).toBe('');
    await user.type(composer(),'Group draft');
    await user.click(screen.getByRole('button',{name:/First colleague/}));
    await screen.findByRole('heading',{name:'First colleague'});
    expect(composer().value).toBe('Direct draft');
    await user.click(screen.getByRole('button',{name:/Project group/}));
    expect(composer().value).toBe('Group draft');
  });
});
