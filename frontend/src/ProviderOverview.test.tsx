import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProviderOverview from './ProviderOverview';
import {api,type PlatformOverview} from './api';

const snapshot:PlatformOverview={as_of:'2026-11-28T10:00:00Z',today:'2026-11-28',renewal_window_days:30,stats:{companies:2,active:1,trial:1,expired:0,scheduled:0,suspended:0,cancelled:0,unassigned:0,expiring:1,memberships:4,online_memberships:1,pending_tickets:2},recent_companies:[],upcoming_renewals:[{id:'one',name:'Example company',ends_on:'2026-12-01',days_remaining:3}]};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('Provider overview',()=>{
  it('renders server counts, renewal alerts and separate currency balances',async()=>{
    vi.spyOn(api,'platformOverview').mockResolvedValue(snapshot);
    const report=vi.spyOn(api,'revenueReport').mockResolvedValue({start:'2026-11-01',end:'2026-11-28',as_of:'2026-11-28',totals:[{currency:'CAD',billed:'100.00',received:'80.00',outstanding:'20.00',overdue:'0.00'},{currency:'INR',billed:'300.00',received:'200.00',outstanding:'100.00',overdue:'0.00'}],monthly:[],customers:[],customers_limit:500});
    const nav=vi.fn(),onNew=vi.fn();
    render(<ProviderOverview onNavigate={nav} onNew={onNew} onManage={vi.fn()} onRenewals={vi.fn()}/>);
    const user=userEvent.setup();
    await screen.findByText('Example company');
    expect(within(screen.getByRole('button',{name:/Total companies/})).getByText('2')).toBeTruthy();
    await screen.findByText('CAD 80.00');
    expect(report).toHaveBeenCalledWith('2026-11-01','2026-11-28');
    await user.selectOptions(screen.getByLabelText('Currency'),'INR');
    expect(screen.getByText('INR 200.00')).toBeTruthy();
    expect(screen.queryByText('CAD 80.00')).toBeNull();
    await user.click(screen.getByRole('button',{name:/Total companies/}));
    expect(nav).toHaveBeenCalledWith('companies');
    await user.click(screen.getByRole('button',{name:'New company'}));
    expect(onNew).toHaveBeenCalled();
  });
  it('shows a load error instead of invented zero counts',async()=>{
    vi.spyOn(api,'platformOverview').mockRejectedValue(new Error('Unavailable'));
    render(<ProviderOverview onNavigate={vi.fn()} onNew={vi.fn()} onManage={vi.fn()} onRenewals={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toBe('Unavailable');
    expect(within(screen.getByRole('button',{name:/Total companies/})).getByText('—')).toBeTruthy();
  });
});
