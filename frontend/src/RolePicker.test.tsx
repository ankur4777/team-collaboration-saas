import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RolePicker from './RolePicker';
afterEach(cleanup);
describe('RolePicker',()=>{
  it('indicates the selected role and switches on selection',async()=>{
    const user=userEvent.setup(),onChange=vi.fn();
    render(<RolePicker label="Role for employee" value="admin" onChange={onChange}/>);
    await user.click(screen.getByRole('button',{name:'Role for employee: Admin'}));
    expect(screen.getByRole('button',{name:'Admin'}).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button',{name:'Member'}));
    expect(onChange).toHaveBeenCalledWith('member');
    expect(screen.queryByRole('group')).toBeNull();
  });
  it('does not offer admin when prohibited and closes on Escape',async()=>{
    const user=userEvent.setup();
    render(<RolePicker label="Workspace role" value="member" allowAdmin={false} onChange={vi.fn()}/>);
    const trigger=screen.getByRole('button',{name:'Workspace role: Member'});
    await user.click(trigger);
    expect(screen.queryByRole('button',{name:'Admin'})).toBeNull();
    await user.keyboard('{Escape}');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
