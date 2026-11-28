import {type CompanyLicense} from './api';

export const moduleOptions=[
  ['teams','Teams & Channels','Team channels, messages and channel notifications.'],
  ['chats','Chats & Groups','Direct chats, groups, departments and tasks.'],
  ['search','Search Messages','Search accessible messages.'],
  ['email','Email Inbox','Connected email accounts and inbox.'],
  ['meetings','Meetings','Meeting schedules and live meeting calls.'],
  ['calendar','Calendar','Calendar and shared meeting scheduling.'],
  ['files','Shared Files','Workspace file access and sharing.'],
];
type Policy=Pick<CompanyLicense,'modules'|'enforce_modules'>;
const keys=moduleOptions.map(([key])=>key);
export function effectiveModuleKeys(value:Policy){
  return value.enforce_modules?keys.filter(key=>value.modules.includes(key)):[...keys];
}
export function modulePolicyChanged(before:Policy,after:Policy){
  return Boolean(before.enforce_modules)!==Boolean(after.enforce_modules)||
    keys.some(key=>before.modules.includes(key)!==after.modules.includes(key));
}
export function moduleChangeMessage(before:Policy,after:Policy){
  const old=effectiveModuleKeys(before),next=effectiveModuleKeys(after);
  const removed=moduleOptions.filter(([key])=>old.includes(key)&&!next.includes(key)).map(([,label])=>label);
  const added=moduleOptions.filter(([key])=>!old.includes(key)&&next.includes(key)).map(([,label])=>label);
  if(!removed.length&&!added.length&&Boolean(before.enforce_modules)===Boolean(after.enforce_modules))return '';
  const lines=['Apply module permissions to this company?'];
  if(removed.length)lines.push('Remove access: '+removed.join(', ')+'. Existing data is retained.');
  if(added.length)lines.push('Grant access: '+added.join(', ')+'.');
  if(!after.enforce_modules)lines.push('Enforcement is off: all modules are permitted by the module policy.');
  if(after.enforce_modules&&!next.length)lines.push('No optional modules will be available.');
  return lines.join('\n');
}
export default function ModuleAccessEditor({value,onChange,disabled=false}:{value:Policy;onChange:(value:Policy)=>void;disabled?:boolean}){
  const enforced=Boolean(value.enforce_modules),effective=effectiveModuleKeys(value);
  const toggle=(key:string,checked:boolean)=>onChange({...value,modules:keys.filter(k=>k===key?checked:value.modules.includes(k))});
  return <section aria-label="Module permissions">
    <div className="pa-metric-grid">
      <div className="pa-stat"><span>Permitted modules</span><strong>{effective.length} / {keys.length}</strong></div>
      <div className="pa-stat"><span>Restricted modules</span><strong>{keys.length-effective.length}</strong></div>
      <div className="pa-stat"><span>Enforcement</span><strong>{enforced?'On':'Off'}</strong></div>
    </div>
    <label className="pa-check"><input type="checkbox" checked={enforced} disabled={disabled} onChange={e=>onChange({...value,enforce_modules:e.target.checked})}/> Enforce module access for this company</label>
    <p className="pa-info">{enforced?'Only selected modules are permitted.':'All modules are permitted while enforcement is off. Saved selections are retained until enforcement is enabled.'} Subscription status and member permissions still apply. Meetings and Calendar share scheduling; live meeting calls require Meetings.</p>
    <div className="pa-heading-actions">
      <button type="button" className="outline-button" disabled={disabled||!enforced} onClick={()=>onChange({...value,modules:[...keys]})}>Select all modules</button>
      <button type="button" className="outline-button" disabled={disabled||!enforced} onClick={()=>onChange({...value,modules:[]})}>Clear all modules</button>
    </div>
    <fieldset disabled={disabled||!enforced}><legend>Configured modules</legend>
      {moduleOptions.map(([key,label,description])=><label key={key} className="pa-check" style={{alignItems:'flex-start',padding:'8px 2px'}}><input type="checkbox" checked={value.modules.includes(key)} onChange={e=>toggle(key,e.target.checked)}/><span><strong>{label}</strong><small style={{display:'block',marginTop:4,lineHeight:1.4}}>{description}</small></span></label>)}
    </fieldset>
    {enforced&&effective.length===0&&<p className="pa-info" role="status">All optional modules will be restricted. Account and workspace settings remain subject to existing permissions.</p>}
  </section>;
}
