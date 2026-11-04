import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle, KeyRound, MailCheck } from 'lucide-react';
import { api } from './api';

type Mode = 'forgot' | 'reset' | 'verify';
interface Props { mode: Mode }
function errorText(e:unknown) { return e instanceof Error ? e.message : 'Request failed'; }

export default function AccountRecoveryScreen({mode}:Props) {
  const query=new URLSearchParams(window.location.search);
  const uid=query.get('uid') || '';
  const token=query.get('token') || '';
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  async function submit(e:FormEvent) {
    e.preventDefault();
    if(busy)return;
    setError('');setSuccess('');setBusy(true);
    try{
      if(mode==='forgot'){
        const result=await api.requestPasswordReset(email);
        setSuccess(result.detail);
      }else if(mode==='reset'){
        if(!uid||!token)throw new Error('This password reset link is incomplete.');
        if(password!==confirm)throw new Error('Passwords do not match.');
        if(password.length<10)throw new Error('Use a password of at least 10 characters.');
        const result=await api.confirmPasswordReset(uid,token,password);
        setSuccess(result.detail);
        setPassword('');setConfirm('');
      }else{
        if(!token)throw new Error('This verification link is incomplete.');
        const result=await api.verifyEmail(token);
        setSuccess(result.detail);
      }
    }catch(e){setError(errorText(e));}
    finally{setBusy(false);}
  }

  const title=mode==='forgot'?'Reset your password':mode==='reset'?'Choose a new password':'Verify your email';
  const description=mode==='forgot'
    ? 'Enter your account email and we will send a secure reset link if an account exists.'
    :mode==='reset'
    ? 'Choose a strong password to secure your TeamWorkspace account.'
    :'Confirm the email address you used for your TeamWorkspace account.';
  return <main className="recovery-layout">
    <div className="recovery-card">
      <div className="recovery-icon">{mode==='verify'?<MailCheck size={24}/>:<KeyRound size={24}/>}</div>
      <div className="eyebrow">TEAMWORKSPACE / ACCOUNT SECURITY</div>
      <h1>{title}</h1><p className="muted">{description}</p>
      {error&&<div className="recovery-error" role="alert">{error}</div>}
      {success ? <div className="recovery-done">
        <CheckCircle size={26}/>
        <p>{success}</p>
        {mode==='forgot'&&<small>Check your inbox and spam folder. In local development, email links appear in the Django API container logs.</small>}
        <a className="primary-button wide" href="/">Return to sign in <ArrowRight size={16}/></a>
      </div> : <form onSubmit={submit} className="recovery-form">
        {mode==='forgot'&&<label>Work email
          <input type="email" required autoComplete="email" maxLength={254} placeholder="you@company.com"
            value={email} onChange={e=>setEmail(e.target.value)}/>
        </label>}
        {mode==='reset'&&<>
          <label>New password
            <input type="password" autoComplete="new-password" minLength={10} required value={password}
              onChange={e=>setPassword(e.target.value)} placeholder="At least 10 characters"/>
          </label>
          <label>Confirm new password
            <input type="password" autoComplete="new-password" minLength={10} required value={confirm}
              onChange={e=>setConfirm(e.target.value)} placeholder="Re-enter new password"/>
          </label>
        </>}
        <button type="submit" className="primary-button wide" disabled={busy || (mode!=='forgot'&&!token)}>
          {busy?'Processing…':mode==='forgot'?'Send reset link':mode==='reset'?'Reset password':'Verify email'} <ArrowRight size={16}/>
        </button>
      </form>}
      {!success&&<a className="recovery-back" href="/"><ArrowLeft size={16}/> Back to sign in</a>}
    </div>
  </main>;
}
