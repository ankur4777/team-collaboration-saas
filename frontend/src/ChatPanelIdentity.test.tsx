import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
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
  vi.spyOn(api,'chatDirectory').mockResolvedValue({departments:[],teams:[],members:[],can_manage:false,can_create_groups:true,can_assign_tasks:true});
  vi.spyOn(api,'employeeTasks').mockResolvedValue({results:[],can_assign:false,limit:200});
  vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),thread('two','Second colleague')]);
  vi.mocked(api.chatMessagePage).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  vi.mocked(api.chatAttachments).mockResolvedValue([]);
  vi.mocked(api.chatPins).mockResolvedValue({items:[],has_more:false});
  vi.mocked(api.messageContext).mockResolvedValue({items:[{id:'message',body:'Search result message',sender:me,created_at:now,edited_at:null,deleted_at:null}]});
});
afterEach(cleanup);

describe('Tasks inside Chats and Groups',()=>{
  it('opens employee tasks in the same section and restores the selected chat and draft',async()=>{
    const user=userEvent.setup();
    render(<DraftProvider><ChatPanel workspaceId="org" currentUser={me} members={[]}/></DraftProvider>);
    await user.click(await screen.findByRole('button',{name:/First colleague/}));
    await user.type(screen.getByRole('textbox',{name:'Write a message'}),'Keep this draft');
    await user.click(screen.getByRole('button',{name:'Tasks'}));
    expect(await screen.findByRole('region',{name:'Employee tasks'})).toBeTruthy();
    expect(screen.queryByRole('textbox',{name:'Write a message'})).toBeNull();
    expect(screen.getByRole('button',{name:'Tasks'}).getAttribute('aria-pressed')).toBe('true');
    expect(api.employeeTasks).toHaveBeenCalledWith('','all');
    await user.click(screen.getByRole('button',{name:'Chats & Groups'}));
    expect(screen.getByRole('heading',{name:'First colleague'})).toBeTruthy();
    expect(screen.getByRole('textbox',{name:'Write a message'})).toHaveProperty('value','Keep this draft');
  });

  it('opens a requested conversation when a notification arrives while viewing tasks',async()=>{
    const user=userEvent.setup(),props={workspaceId:'org',currentUser:me,members:[]};
    const view=render(<ChatPanel {...props}/>);
    await user.click(screen.getByRole('button',{name:'Tasks'}));
    await screen.findByRole('region',{name:'Employee tasks'});
    view.rerender(<ChatPanel {...props} requestedChat={{id:'two',nonce:1}}/>);
    expect(await screen.findByRole('heading',{name:'Second colleague'})).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Employee tasks'})).toBeNull();
  });

  it('does not mark chat messages as read while the tasks section is visible',async()=>{
    // jsdom does not implement the browser's scrolling API.
    HTMLElement.prototype.scrollIntoView=vi.fn();
    vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    let deliver!:(value:{items:import('./api').ChatMessage[];has_more:boolean;next_cursor:null})=>void;
    vi.mocked(api.chatMessagePage).mockImplementationOnce(()=>new Promise(resolve=>{deliver=resolve;}));
    const read=vi.spyOn(api,'markChatRead').mockResolvedValue({last_read_at:now}),user=userEvent.setup();
    render(<ChatPanel workspaceId="org" currentUser={me} members={[]}/>);
    await user.click(await screen.findByRole('button',{name:/First colleague/}));
    await user.click(screen.getByRole('button',{name:'Tasks'}));
    await act(async()=>deliver({items:[{id:'unread',body:'New message',sender:person('one','First colleague'),created_at:now,edited_at:null,deleted_at:null,reactions:[]}],has_more:false,next_cursor:null}));
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Chats & Groups'}));
    await waitFor(()=>expect(read).toHaveBeenCalledWith('one','unread'));
  });
});

describe('Department chat navigation and Senior project groups',()=>{
  it('opens a direct conversation only after a department employee is clicked',async()=>{
    const user=userEvent.setup(),peer=person('one','First colleague');
    const entry={id:'member-one',role:'member',job_title:'Developer',position_rank:2,is_senior:false,user:peer};
    vi.mocked(api.chatDirectory).mockResolvedValue({departments:[{id:'dept',name:'Engineering'}],teams:[{id:'team',name:'Platform',department_id:'dept',members:[entry]}],members:[entry],can_manage:false,can_create_groups:false,can_assign_tasks:false});
    vi.mocked(api.chats).mockResolvedValueOnce([]).mockResolvedValue([thread('one','First colleague')]);
    const start=vi.spyOn(api,'startDirectChat').mockResolvedValue(thread('one','First colleague'));
    render(<ChatPanel workspaceId="org" currentUser={me} members={[]}/>);
    await user.click(await screen.findByRole('button',{name:/Engineering/}));
    await user.click(screen.getByRole('button',{name:/Platform/}));
    expect(start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Chat with First colleague'}));
    await waitFor(()=>expect(start).toHaveBeenCalledWith(peer.email));
    expect(await screen.findByRole('heading',{name:'First colleague'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Create project group'})).toBeNull();
  });

  it('confirms and deletes a project group when the server permits it',async()=>{
    const group={...thread('project','Colleague'),kind:'group' as const,title:'Project Apollo',can_delete:true};
    vi.mocked(api.chats).mockResolvedValue([group]);
    const remove=vi.spyOn(api,'deleteProjectGroup').mockImplementation(async()=>{vi.mocked(api.chats).mockResolvedValue([]);});
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true),user=userEvent.setup();
    render(<ChatPanel workspaceId="org" currentUser={me} members={[]}/>);
    await user.click(await screen.findByRole('button',{name:/Project Apollo/}));
    await user.click(screen.getByRole('button',{name:'Delete group'}));
    expect(confirm).toHaveBeenCalled();
    await waitFor(()=>expect(remove).toHaveBeenCalledWith('project'));
    await waitFor(()=>expect(screen.queryByRole('heading',{name:'Project Apollo'})).toBeNull());
  });

  it('hides project group deletion for ordinary participants',async()=>{
    vi.mocked(api.chats).mockResolvedValue([{...thread('project','Colleague'),kind:'group',title:'Project Apollo',can_delete:false}]);
    render(<ChatPanel workspaceId="org" currentUser={me} members={[]}/>);
    await userEvent.setup().click(await screen.findByRole('button',{name:/Project Apollo/}));
    expect(screen.queryByRole('button',{name:'Delete group'})).toBeNull();
  });
});

describe('Chat conversation panel identity',()=>{
  it('keeps one pins panel, attachment panel and composer across chat switches and search navigation',async()=>{
    const user=userEvent.setup();
    const props={workspaceId:'org',currentUser:me,members:[]};
    const view=render(<ChatPanel {...props}/>);
    await user.click(await screen.findByRole('button',{name:/First colleague/}));
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
    vi.mocked(api.chatDirectory).mockResolvedValue({departments:[],teams:[],members:members.map(m=>({...m,job_title:'Developer',position_rank:100,is_senior:false})),can_manage:false,can_create_groups:true,can_assign_tasks:true});
    render(<ChatPanel workspaceId="org" currentUser={me} members={members}/>);
    await user.click(await screen.findByRole('button',{name:'Create project group'}));
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
    await user.click(await screen.findByRole('button',{name:/First colleague/}));
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

describe('Unread conversation badges',()=>{
  it('refreshes counts for unopened direct and group chats on notification',async()=>{
    const props={workspaceId:'org',currentUser:me,members:[]};
    const group={...thread('three','Third colleague'),kind:'group' as const,title:'Project group'};
    vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),thread('two','Second colleague'),group]);
    const view=render(<ChatPanel {...props}/>);
    await userEvent.setup().click(await screen.findByRole('button',{name:/First colleague/}));
    await screen.findByRole('heading',{name:'First colleague'});
    vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),{...thread('two','Second colleague'),unread_count:3},{...group,unread_count:102}]);
    view.rerender(<ChatPanel {...props} notificationVersion={1}/>);
    await waitFor(()=>expect(screen.getByLabelText('3 unread messages').textContent).toBe('3'));
    expect(screen.getByLabelText('102 unread messages').textContent).toBe('99+');
    expect(screen.getByRole('heading',{name:'First colleague'})).toBeTruthy();
    vi.mocked(api.chats).mockResolvedValue([thread('one','First colleague'),thread('two','Second colleague'),group]);
    view.rerender(<ChatPanel {...props} notificationVersion={2}/>);
    await waitFor(()=>expect(screen.queryByLabelText('3 unread messages')).toBeNull());
  });
});

describe('Explicit conversation selection',()=>{
  it('leaves the conversation panel empty on entry and unread refresh until a user selects a chat',async()=>{
    const user=userEvent.setup();
    const props={workspaceId:'org',currentUser:me,members:[]};
    const group={...thread('group','Colleague'),kind:'group' as const,title:'Corporate',unread_count:3};
    vi.mocked(api.chats).mockResolvedValue([group,thread('one','First colleague')]);
    const view=render(<ChatPanel {...props}/>);
    const button=await screen.findByRole('button',{name:/Corporate/});
    expect(screen.getByRole('heading',{name:'Select a conversation'})).toBeTruthy();
    expect(screen.queryByRole('textbox',{name:'Write a message'})).toBeNull();
    expect(api.chatMessagePage).not.toHaveBeenCalled();
    view.rerender(<ChatPanel {...props} notificationVersion={1}/>);
    await waitFor(()=>expect(api.chats).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading',{name:'Select a conversation'})).toBeTruthy();
    expect(screen.getByLabelText('3 unread messages')).toBeTruthy();
    await user.click(button);
    await screen.findByRole('heading',{name:'Corporate'});
    expect(screen.getByRole('textbox',{name:'Write a message'})).toBeTruthy();
  });
  it('opens a chat when explicitly requested from a notification or search result',async()=>{
    render(<ChatPanel workspaceId="org" currentUser={me} members={[]} requestedChat={{id:'two',nonce:1}}/>);
    await screen.findByRole('heading',{name:'Second colleague'});
  });
});

