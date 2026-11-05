import { useEffect, useState, type FormEvent } from 'react';
import { Bell, CheckCircle2, KeyRound, LockKeyhole, MailCheck, ShieldCheck, Laptop, RefreshCw } from 'lucide-react';
import { api, type AccountDeviceSession, type NotificationPreferences, type Person } from './api';

const initialPrefs:NotificationPreferences={direct_chats:true,group_chats:true,team_channels:true};
const options: Array<{key:keyof NotificationPreferences;title:string;description:string}>=[
  {key:'direct_chats',title:'Direct messages',description:'Show unread direct conversations in the notification bell.'},
  {key:'group_chats',title:'Group chats',description:'Show unread group conversations in the notification bell.'},
  {key:'team_channels',title:'Team channels',description:'Show unread team channels in the notification bell.'},
];

interface Props{
  workspaceId:string|null;
  workspaceName:string;
  user:Person;
  onPreferencesSaved:()=>void;
}
function errorText(err:unknown) {return err instanceof Error?err.message:'Something went wrong';}
function deviceName(agent:string){
  const browser = /Edg\//.test(agent)?'Edge':/Firefox\//.test(agent)?'Firefox':/Chrome\//.test(agent)?'Chrome':/Safari\//.test(agent)?'Safari':'Browser';
  const platform = /Windows/.test(agent)?'Windows':/Macintosh/.test(agent)?'macOS':/Android/.test(agent)?'Android':/iPhone|iPad/.test(agent)?'iOS':'Unknown device';
  return `${browser} · ${platform}`;
}
function dateTime(value:string){return new Date(value).toLocaleString();}

export default function SettingsPanel({workspaceId,workspaceName,user,onPreferencesSaved}:Props){
  const [prefs,setPrefs]=useState<NotificationPreferences>(initialPrefs);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [preferencesMessage,setPreferencesMessage]=useState('');
  const [preferencesError,setPreferencesError]=useState('');
  const [currentPassword,setCurrentPassword]=useState('');
  const [newPassword,setNewPassword]=useState('');
  const [repeatPassword,setRepeatPassword]=useState('');
  const [changing,setChanging]=useState(false);
  const [passwordMessage,setPasswordMessage]=useState('');
  const [passwordError,setPasswordError]=useState('');
  const [resending,setResending]=useState(false);
  const [verifyMessage,setVerifyMessage]=useState('');
  const [devices,setDevices]=useState<AccountDeviceSession[]>([]);
  const [devicesLoading,setDevicesLoading]=useState(true);
  const [deviceBusy,setDeviceBusy]=useState<string|null>(null);
  const [deviceMessage,setDeviceMessage]=useState('');
  const [deviceError,setDeviceError]=useState('');

  useEffect(()=>{
    let active=true;
    setLoading(true);setPreferencesError('');setPreferencesMessage('');setPrefs(initialPrefs);
    if(!workspaceId){setLoading(false);return()=>{active=false;};}
    void api.notificationPreferences().then(data=>{if(active)setPrefs(data);})
      .catch(e=>{if(active)setPreferencesError(errorText(e));})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[workspaceId]);

  useEffect(()=>{
    let active=true;
    void api.activeSessions().then(rows=>{if(active)setDevices(rows);})
      .catch(e=>{if(active)setDeviceError(errorText(e));})
      .finally(()=>{if(active)setDevicesLoading(false);});
    return()=>{active=false;};
  },[]);

  async function refreshDevices(){
    try{
      const rows=await api.activeSessions();
      setDevices(rows);
      setDeviceError('');
    }catch(e){setDeviceError(errorText(e));}
  }
  async function endDevice(device:AccountDeviceSession){
    if(device.current||deviceBusy||!window.confirm('Sign out this device?'))return;
    setDeviceBusy(device.id);setDeviceError('');setDeviceMessage('');
    try{
      await api.signOutDevice(device.id);
      setDeviceMessage('The selected device was signed out.');
      await refreshDevices();
    }catch(e){setDeviceError(errorText(e));}
    finally{setDeviceBusy(null);}
  }
  async function endOtherDevices(){
    if(deviceBusy||!window.confirm('Sign out all other browsers and devices?'))return;
    setDeviceBusy('others');setDeviceError('');setDeviceMessage('');
    try{
      const result=await api.signOutOtherDevices();
      setDeviceMessage(result.detail);
      await refreshDevices();
    }catch(e){setDeviceError(errorText(e));}
    finally{setDeviceBusy(null);}
  }
  async function savePreferences(e:FormEvent){
    e.preventDefault();if(saving||loading)return;
    setSaving(true);setPreferencesError('');setPreferencesMessage('');
    try{
      const result=await api.saveNotificationPreferences(prefs);
      setPrefs(result);
      setPreferencesMessage('Notification settings saved for this workspace.');
      onPreferencesSaved();
    }catch(e){setPreferencesError(errorText(e));}
    finally{setSaving(false);}
  }
  async function changePassword(e:FormEvent){
    e.preventDefault();if(changing)return;
    setPasswordError('');setPasswordMessage('');
    if(newPassword!==repeatPassword){setPasswordError('New passwords do not match.');return;}
    if(newPassword.length<10){setPasswordError('Use at least 10 characters.');return;}
    setChanging(true);
    try{
      const result=await api.changePassword(currentPassword,newPassword);
      setPasswordMessage(result.detail);
      setCurrentPassword('');setNewPassword('');setRepeatPassword('');
      void refreshDevices();
    }catch(e){setPasswordError(errorText(e));}
    finally{setChanging(false);}
  }
  async function resend(){
    setResending(true);setVerifyMessage('');
    try{const result=await api.resendVerification();setVerifyMessage(result.detail);}
    catch(e){setVerifyMessage(errorText(e));}
    finally{setResending(false);}
  }
  return <div className="settings-page">
    <div className="settings-title"><div className="eyebrow">WORKSPACE / SETTINGS</div><h1>Account & notifications</h1>
      <p>Manage your personal security and notification choices for {workspaceName}.</p></div>
    <div className="settings-layout">
      <section className="settings-card">
        <div className="settings-card-head"><Bell size={19}/><div><h2>In-app notifications</h2><p>Choose what appears in your notification bell.</p></div></div>
        <form onSubmit={savePreferences}>
          <div className="settings-options">{options.map(option=><label className="settings-option" key={option.key}>
            <span><strong>{option.title}</strong><small>{option.description}</small></span>
            <input type="checkbox" checked={prefs[option.key]} disabled={loading||saving}
              onChange={e=>{setPrefs(p=>({...p,[option.key]:e.target.checked}));setPreferencesMessage('');}}/>
          </label>)}</div>
          <p className="settings-help">Unread counts in chats and channels are still available even when bell alerts are hidden. This does not disable message delivery.</p>
          {preferencesError&&<p className="settings-error" role="alert">{preferencesError}</p>}
          {preferencesMessage&&<p className="settings-success" role="status">{preferencesMessage}</p>}
          <button type="submit" className="primary-button" disabled={loading||saving}>{saving?'Saving…':'Save notification settings'}</button>
        </form>
      </section>
      <section className="settings-card">
        <div className="settings-card-head"><ShieldCheck size={19}/><div><h2>Account security</h2><p>Security settings apply across all your company workspaces.</p></div></div>
        <div className="settings-account">
          <span><strong>{user.full_name}</strong><small>{user.email}</small></span>
          <span className={`settings-verified ${user.email_verified?'yes':''}`}><MailCheck size={15}/>{user.email_verified?'Email verified':'Email unverified'}</span>
        </div>
        {!user.email_verified&&<div className="settings-verify">
          <p>Confirm your address with the verification link sent by email.</p>
          <button type="button" disabled={resending} className="outline-button" onClick={()=>void resend()}>{resending?'Sending…':'Resend verification'}</button>
          {verifyMessage&&<small role="status">{verifyMessage}</small>}
        </div>}
        <div className="settings-password-heading"><KeyRound size={17}/><h3>Change password</h3></div>
        <form onSubmit={changePassword} className="settings-password-form">
          <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label>
          <label>New password<input type="password" autoComplete="new-password" required minLength={10} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={10} value={repeatPassword} onChange={e=>setRepeatPassword(e.target.value)}/></label>
          {passwordError&&<p className="settings-error" role="alert">{passwordError}</p>}
          {passwordMessage&&<p className="settings-success" role="status"><CheckCircle2 size={15}/>{passwordMessage}</p>}
          <button type="submit" className="primary-button" disabled={changing}>{changing?'Changing…':'Update password'}</button>
        </form>
        <div className="settings-help settings-security-note"><LockKeyhole size={15}/>Your current session stays signed in after updating your password. Other sessions must sign in again.</div>
      </section>
    </div>
    <section className="settings-card settings-devices">
      <div className="settings-card-head"><Laptop size={19}/><div><h2>Active sessions & devices</h2>
        <p>Review browsers signed in to your account, across all company workspaces.</p></div></div>
      <div className="devices-actions">
        <button type="button" className="outline-button" onClick={()=>void refreshDevices()} disabled={deviceBusy!==null}><RefreshCw size={15}/> Refresh</button>
        <button type="button" className="outline-button" onClick={()=>void endOtherDevices()} disabled={deviceBusy!==null}>
          {deviceBusy==='others'?'Signing out…':'Sign out other devices'}
        </button>
      </div>
      {deviceError&&<p className="settings-error" role="alert">{deviceError}</p>}
      {deviceMessage&&<p className="settings-success" role="status">{deviceMessage}</p>}
      <div className="devices-list">
        {devicesLoading&&<p className="settings-help">Loading signed-in devices…</p>}
        {!devicesLoading&&devices.length===0&&<p className="settings-help">No active sessions found. Refresh after signing in.</p>}
        {devices.map(device=><div className="device-row" key={device.id}>
          <div className="device-icon"><Laptop size={18}/></div>
          <div className="device-details"><strong>{deviceName(device.user_agent)}</strong>
            {device.current&&<span className="device-current">This device</span>}
            <small>Last seen: {dateTime(device.last_seen_at)} · Signed in: {dateTime(device.created_at)}</small>
            {device.ip_address&&<small>IP: {device.ip_address}</small>}
          </div>
          {!device.current&&<button type="button" className="device-revoke" disabled={deviceBusy!==null} onClick={()=>void endDevice(device)}>
            {deviceBusy===device.id?'Signing out…':'Sign out'}
          </button>}
        </div>)}
      </div>
      <p className="settings-help">Device names are estimated from browser information. Sessions are tracked from their first use after this feature is installed. Signing out other devices invalidates previous sessions, even those not listed here.</p>
    </section>
  </div>;
}
