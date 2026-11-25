import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api,type Message,type MessageSearchResult} from './api';
import MessageContext from './MessageContext';
import MessageSearchPanel from './MessageSearchPanel';
import PrivateChannelMembers from './PrivateChannelMembers';

vi.mock('./api',()=>({api:{messageContext:vi.fn(),searchMessages:vi.fn(),privateChannelMembers:vi.fn(),addPrivateChannelMember:vi.fn(),removePrivateChannelMember:vi.fn()}}));
const sender={id:'u1',email:'owner@example.test',full_name:'Owner',email_verified:true};
const message:Message={id:'m1',body:'Exact keyword',created_at:'2026-01-01T12:00:00Z',edited_at:null,deleted_at:null,sender};
beforeEach(()=>{vi.resetAllMocks();vi.mocked(api.messageContext).mockResolvedValue({items:[message]});vi.mocked(api.privateChannelMembers).mockResolvedValue([sender]);});
afterEach(cleanup);

describe('Message search navigation',()=>{
  it('passes the exact message identifier to its destination',async()=>{
    const result:MessageSearchResult={id:'m1',source:'channel',source_id:'c1',source_name:'General',chat_kind:null,team_id:'t1',team_name:'Team',sender_name:'Owner',created_at:message.created_at,excerpt:message.body};
    vi.mocked(api.searchMessages).mockResolvedValue({results:[result],limit:50});
    const onOpenChannel=vi.fn();const user=userEvent.setup();
    render(<MessageSearchPanel onOpenChat={vi.fn()} onOpenChannel={onOpenChannel}/>);
    await user.type(screen.getByRole('searchbox',{name:'Search message text'}),'keyword');
    await user.click(screen.getByRole('button',{name:'Search'}));
    await user.click(await screen.findByRole('button',{name:/Exact keyword/}));
    expect(onOpenChannel).toHaveBeenCalledWith('t1','c1','m1');
  });
  it('highlights the selected message and closes the context',async()=>{
    const user=userEvent.setup(),onClose=vi.fn();
    render(<MessageContext kind="chat" id="c1" messageId="m1" onClose={onClose}/>);
    const text=await screen.findByText('Exact keyword');
    expect(text.closest('.context-message')?.classList.contains('target')).toBe(true);
    expect(api.messageContext).toHaveBeenCalledWith('chat','c1','m1');
    await user.click(screen.getByRole('button',{name:'Return to latest messages'}));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('removes old content when a message becomes unavailable',async()=>{
    const onClose=vi.fn();
    const view=render(<MessageContext kind="chat" id="c1" messageId="m1" onClose={onClose}/>);
    await screen.findByText('Exact keyword');
    vi.mocked(api.messageContext).mockRejectedValueOnce(new Error('Message unavailable'));
    view.rerender(<MessageContext kind="chat" id="c1" messageId="m1" version={1} onClose={onClose}/>);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Message unavailable');
    expect(screen.queryByText('Exact keyword')).toBeNull();
  });
});
describe('Private channel controls',()=>{
  it('does not expose member management controls to a non-manager',async()=>{
    render(<PrivateChannelMembers id="private" currentUserId="u2" canManage={false} onClose={vi.fn()}/>);
    await screen.findByText('Owner');
    expect(screen.queryByRole('button',{name:'Add member'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Remove'})).toBeNull();
  });
  it('invites an existing team member and refreshes membership',async()=>{
    const user=userEvent.setup();
    vi.mocked(api.addPrivateChannelMember).mockResolvedValue({id:'u2'});
    render(<PrivateChannelMembers id="private" currentUserId="u1" canManage onClose={vi.fn()}/>);
    await screen.findByText('Owner');
    await user.type(screen.getByRole('textbox',{name:'Invite existing team member'}),'staff@example.test');
    await user.click(screen.getByRole('button',{name:'Add member'}));
    await waitFor(()=>expect(api.addPrivateChannelMember).toHaveBeenCalledWith('private','staff@example.test'));
    await waitFor(()=>expect(api.privateChannelMembers).toHaveBeenCalledTimes(2));
  });
});
