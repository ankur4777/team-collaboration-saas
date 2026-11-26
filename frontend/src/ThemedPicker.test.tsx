import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {Hash,LockKeyhole} from 'lucide-react';
import ThemedPicker,{type PickerOption} from './ThemedPicker';
afterEach(cleanup);
const options:PickerOption<'standard'|'private'>[]=[{value:'standard',label:'Standard — all team members',icon:Hash},{value:'private',label:'Private — invited team members only',icon:LockKeyhole}];
describe('Channel visibility picker',()=>{
  it('selects private visibility without submitting the channel form',async()=>{
    const user=userEvent.setup(),onChange=vi.fn(),submit=vi.fn(e=>e.preventDefault());
    render(<form onSubmit={submit}><ThemedPicker label="Visibility" value="standard" options={options} onChange={onChange} fullWidth/></form>);
    await user.click(screen.getByRole('button',{name:'Visibility: Standard — all team members'}));
    expect(screen.getByRole('button',{name:'Standard — all team members'}).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button',{name:'Private — invited team members only'}));
    expect(onChange).toHaveBeenCalledWith('private');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
