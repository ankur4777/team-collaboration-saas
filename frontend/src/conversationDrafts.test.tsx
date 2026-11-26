import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {DraftProvider,useConversationDraft} from './conversationDrafts';
afterEach(cleanup);
function Composer({id,kind='channel',user='user',org='org'}:{id:string;kind?:'chat'|'channel';user?:string;org?:string}){
  const {draft,setDraft}=useConversationDraft(user,org,kind,id);
  return <input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/>;
}
describe('Scoped drafts',()=>{
  it('isolates channels, chat, accounts and organizations, including remounts',async()=>{
    const user=userEvent.setup();
    const view=render(<DraftProvider><Composer id="general"/></DraftProvider>);
    const box=()=>screen.getByRole('textbox',{name:'Draft'}) as HTMLInputElement;
    await user.type(box(),'General draft');
    view.rerender(<DraftProvider><Composer id="sales"/></DraftProvider>);
    expect(box().value).toBe('');
    await user.type(box(),'Sales draft');
    view.rerender(<DraftProvider><Composer key="chat" id="general" kind="chat"/></DraftProvider>);
    expect(box().value).toBe('');
    await user.type(box(),'Chat draft');
    view.rerender(<DraftProvider><Composer key="channel" id="general"/></DraftProvider>);
    expect(box().value).toBe('General draft');
    view.rerender(<DraftProvider><Composer id="sales"/></DraftProvider>);
    expect(box().value).toBe('Sales draft');
    view.rerender(<DraftProvider><Composer id="general" user="another"/></DraftProvider>);
    expect(box().value).toBe('');
    view.rerender(<DraftProvider><Composer id="general" org="another"/></DraftProvider>);
    expect(box().value).toBe('');
    view.rerender(<DraftProvider><Composer id="general" kind="chat"/></DraftProvider>);
    expect(box().value).toBe('Chat draft');
    await user.clear(box());
    view.rerender(<DraftProvider><Composer id="general"/></DraftProvider>);
    expect(box().value).toBe('General draft');
  });
});
