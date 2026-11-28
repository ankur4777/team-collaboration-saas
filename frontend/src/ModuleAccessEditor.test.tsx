import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState} from 'react';
import ModuleAccessEditor,{effectiveModuleKeys,modulePolicyChanged,moduleChangeMessage} from './ModuleAccessEditor';
afterEach(cleanup);
function Harness(){
  const [value,setValue]=useState({modules:['teams'],enforce_modules:true});
  return <ModuleAccessEditor value={value} onChange={v=>setValue({modules:v.modules,enforce_modules:Boolean(v.enforce_modules)})}/>;
}
describe('Company module access',()=>{
  it('updates permitted counts and preserves selection when enforcement is off',async()=>{
    render(<Harness/>);
    const user=userEvent.setup();
    expect(screen.getByText('1 / 7')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Clear all modules'}));
    expect(screen.getByText('0 / 7')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Select all modules'}));
    expect(screen.getByText('7 / 7')).toBeTruthy();
    await user.click(screen.getByRole('checkbox',{name:/Teams & Channels/}));
    expect(screen.getByText('6 / 7')).toBeTruthy();
    await user.click(screen.getByRole('checkbox',{name:/Enforce module access/}));
    expect(screen.getByText('7 / 7')).toBeTruthy();
    expect((screen.getByRole('button',{name:'Clear all modules'}) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox',{name:/Enforce module access/}));
    expect(screen.getByText('6 / 7')).toBeTruthy();
  });
  it('detects actual policy changes without depending on selection order',()=>{
    const before={modules:['teams','chats'],enforce_modules:true};
    expect(modulePolicyChanged(before,{...before,modules:['chats','teams']})).toBe(false);
    expect(modulePolicyChanged(before,{...before,modules:['teams']})).toBe(true);
    expect(moduleChangeMessage(before,{...before,modules:['teams']})).toContain('Remove access: Chats & Groups');
    expect(effectiveModuleKeys({...before,enforce_modules:false})).toHaveLength(7);
    expect(moduleChangeMessage(before,{...before,enforce_modules:false})).toContain('Enforcement is off');
  });
});
