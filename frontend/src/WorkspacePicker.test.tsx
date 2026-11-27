import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkspacePicker from './WorkspacePicker';
import type {Org} from './api';

afterEach(cleanup);
const organizations:Org[]=[{id:'a',name:'Shabdd',slug:'shabdd',role:'admin'},{id:'b',name:'Design team',slug:'design',role:'member'}];
describe('Workspace selector',()=>{
  it('shows workspace roles and switches only when another workspace is selected',async()=>{
    const user=userEvent.setup(),onSelect=vi.fn();
    render(<WorkspacePicker organizations={organizations} activeId="a" onSelect={onSelect}/>);
    const trigger=screen.getByRole('button',{name:'Switch organization'});
    await user.click(trigger);
    const current=screen.getByRole('button',{name:/Shabdd Admin/});
    expect(current.getAttribute('aria-pressed')).toBe('true');
    await user.click(current);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole('button',{name:/Design team Member/}));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it('dismisses on Escape and does not render a native select',async()=>{
    const user=userEvent.setup();
    const view=render(<WorkspacePicker organizations={organizations} activeId="a" onSelect={vi.fn()}/>);
    const trigger=screen.getByRole('button',{name:'Switch organization'});
    await user.click(trigger);await user.keyboard('{Escape}');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('select')).toBeNull();
  });
});
