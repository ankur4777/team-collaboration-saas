import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api,type PlatformCompany} from './api';
import CompanyAccessPanel from './CompanyAccessPanel';

const company:PlatformCompany={id:'company',name:'Example',slug:'example',created_at:'2026-11-28T10:00:00Z',employee_count:0,team_count:0,owner_emails:[],pending_owner_email:'admin@example.test',effective_status:'active',active_admin_count:0,onboarding_status:'invited',contact_email:'admin@example.test',plan:'Business',status:'active',seat_limit:5,starts_on:null,ends_on:null,modules:[],enforce_modules:true};
const pending={id:'invitation',email:'admin@example.test',created_at:'2026-11-28T10:00:00Z',expires_at:'2026-12-05T10:00:00Z'};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('Company administrator access',()=>{
  it('revokes a pending invitation after confirmation and refreshes the list',async()=>{
    vi.spyOn(api,'platformCompany').mockResolvedValue({company,audit:[]});
    const list=vi.spyOn(api,'companyAdminInvitations').mockResolvedValue({items:[pending],total:1});
    const revoke=vi.spyOn(api,'revokeCompanyAdminInvitation').mockImplementation(async()=>{list.mockResolvedValue({items:[],total:0});});
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const changed=vi.fn();
    render(<CompanyAccessPanel company={company} onChanged={changed}/>);
    const user=userEvent.setup();
    await user.click(await screen.findByRole('button',{name:'Revoke'}));
    await screen.findByText('No pending administrator invitations.');
    expect(revoke).toHaveBeenCalledWith('company','invitation');
    await waitFor(()=>expect(changed).toHaveBeenCalled());
  });
});
