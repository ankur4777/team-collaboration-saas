import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageActions from './MessageActions';
afterEach(cleanup);
describe('Compact message actions',()=>{
  it('shows actions only when opened, invokes the selected action, and closes',async()=>{
    const user=userEvent.setup(),reply=vi.fn(),remove=vi.fn();
    render(<MessageActions onReply={reply} onDelete={remove}/>);
    expect(screen.queryByRole('button',{name:'Reply'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Message options'}));
    await user.click(screen.getByRole('button',{name:'Reply'}));
    expect(reply).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'Delete'})).toBeNull();
  });
  it('hides unavailable actions and supports escape',async()=>{
    const user=userEvent.setup();
    render(<MessageActions pinned onPin={vi.fn()} onForward={vi.fn()}/>);
    const button=screen.getByRole('button',{name:'Message options'});
    await user.click(button);
    expect(screen.getByRole('button',{name:'Unpin'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Edit'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Delete'})).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button',{name:'Unpin'})).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
