import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatNotificationBell from './ChatNotificationBell';
import {api,meetingsApi} from './api';

vi.mock('./api',()=>({api:{chats:vi.fn(),channelNotifications:vi.fn(),notificationPreferences:vi.fn(),mentionNotifications:vi.fn(),resendVerification:vi.fn()},meetingsApi:{notifications:vi.fn(),read:vi.fn()}}));
beforeEach(()=>{
  vi.mocked(meetingsApi.notifications).mockResolvedValue({results:[]});
  vi.mocked(meetingsApi.read).mockResolvedValue({status:'read'});
  vi.stubGlobal('WebSocket',class {close(){}});
  vi.mocked(api.chats).mockResolvedValue([]);
  vi.mocked(api.channelNotifications).mockResolvedValue([]);
  vi.mocked(api.mentionNotifications).mockResolvedValue({results:[]});
  vi.mocked(api.notificationPreferences).mockResolvedValue({direct_chats:false,group_chats:false,team_channels:false});
  vi.mocked(api.resendVerification).mockResolvedValue({detail:'Verification instructions have been sent.'});
});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
const mount=(emailVerified=false)=>render(<ChatNotificationBell workspaceId="org-1" userId="user-1" emailVerified={emailVerified} onOpenChat={()=>{}} onOpenChannel={()=>{}}/>);

describe('Email verification in notifications',()=>{
  it('keeps the reminder inside the closed notification dropdown and counts it even with conversation alerts disabled',async()=>{
    const user=userEvent.setup();mount();
    expect(screen.queryByText('Please verify your email address')).toBeNull();
    await user.click(screen.getByRole('button',{name:'Notifications, 1 unread notifications'}));
    expect(screen.getByRole('region',{name:'Email verification reminder'})).toBeTruthy();
    await waitFor(()=>expect(api.notificationPreferences).toHaveBeenCalled());
    expect(screen.queryByText('No unread mentions or conversations in this workspace.')).toBeNull();
  });
  it('prevents resending while pending and displays success only in notifications',async()=>{
    let resolve!:(value:{detail:string})=>void;
    vi.mocked(api.resendVerification).mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const user=userEvent.setup();mount();
    await user.click(screen.getByRole('button',{name:/Notifications,/}));
    await user.click(screen.getByRole('button',{name:'Resend verification'}));
    expect((screen.getByRole('button',{name:'Sending…'}) as HTMLButtonElement).disabled).toBe(true);
    resolve({detail:'Verification instructions have been sent.'});
    expect(await screen.findByRole('status')).toHaveProperty('textContent','Verification instructions have been sent.');
    expect(api.resendVerification).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button',{name:'Close notifications'}));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('shows a resend error and allows retry',async()=>{
    vi.mocked(api.resendVerification).mockRejectedValueOnce(new Error('Please wait before trying again.'));
    const user=userEvent.setup();mount();
    await user.click(screen.getByRole('button',{name:/Notifications,/}));
    await user.click(screen.getByRole('button',{name:'Resend verification'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Please wait before trying again.');
    await user.click(screen.getByRole('button',{name:'Resend verification'}));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('removes the reminder and its badge count after verification',async()=>{
    const user=userEvent.setup();const view=mount();
    await user.click(screen.getByRole('button',{name:/Notifications,/}));
    view.rerender(<ChatNotificationBell workspaceId="org-1" userId="user-1" emailVerified onOpenChat={()=>{}} onOpenChannel={()=>{}}/>);
    expect(screen.getByRole('button',{name:'Notifications, 0 unread notifications'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Resend verification'})).toBeNull();
    expect(screen.getByText('No unread mentions or conversations in this workspace.')).toBeTruthy();
  });
  it('shows meeting invitations and opens the meeting from the notification center',async()=>{
    vi.mocked(meetingsApi.notifications).mockResolvedValue({results:[{id:'meeting-1',title:'Project review',starts_at:new Date().toISOString(),kind:'invited'}]});
    const onOpenMeeting=vi.fn();const user=userEvent.setup();
    render(<ChatNotificationBell workspaceId="org-1" userId="user-1" emailVerified onOpenMeeting={onOpenMeeting} onOpenChat={()=>{}} onOpenChannel={()=>{}}/>);
    await user.click(await screen.findByRole('button',{name:'Notifications, 1 unread notifications'}));
    await user.click(screen.getByRole('button',{name:/Project review/}));
    expect(onOpenMeeting).toHaveBeenCalledWith('meeting-1');
    expect(meetingsApi.read).toHaveBeenCalledWith('meeting-1');
  });

});

