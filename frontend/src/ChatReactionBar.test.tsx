import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatReactionBar from './ChatReactionBar';
import {api,type ChatMessage,type Person} from './api';
vi.mock('./api',()=>({api:{toggleChatReaction:vi.fn()}}));
afterEach(cleanup);
const me:Person={id:'me',full_name:'Owner',email:'me@example.test',email_verified:true};
const other:Person={id:'other',full_name:'Colleague',email:'other@example.test',email_verified:true};
const message:ChatMessage={id:'m',body:'Update',created_at:'2026-01-01T12:00:00Z',edited_at:null,deleted_at:null,sender:me,reactions:[{emoji:'👍',count:1,user_ids:['other']}]};
describe('Compact reactions',()=>{
  it('shows only used emojis and reveals reactor names',async()=>{
    const user=userEvent.setup();
    render(<ChatReactionBar chatId="chat" message={message} currentUserId="me" participants={[me,other]} onUpdated={vi.fn()}/>);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await user.click(screen.getByRole('button',{name:/👍 1 reactions: Colleague/}));
    expect(screen.getByText('Colleague')).toBeTruthy();
    expect(screen.queryByRole('group',{name:'Choose an emoji'})).toBeNull();
  });
  it('collapses the picker after selecting an emoji and preserves other users reactions',async()=>{
    const user=userEvent.setup();
    vi.mocked(api.toggleChatReaction).mockResolvedValue({...message,reactions:[...message.reactions,{emoji:'✅',count:1,user_ids:['me']}]});
    render(<ChatReactionBar chatId="chat" message={message} currentUserId="me" participants={[me,other]} onUpdated={vi.fn()}/>);
    await user.click(screen.getByRole('button',{name:'Choose reaction'}));
    await user.click(screen.getByRole('button',{name:'React with Completed'}));
    expect(await screen.findByRole('button',{name:/✅ 1 reactions: You/})).toBeTruthy();
    expect(screen.queryByRole('group',{name:'Choose an emoji'})).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
