import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel from './ChatPanel';
import {api,type ChatThread,type Person} from './api';

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
