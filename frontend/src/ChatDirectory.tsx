import {useState,type FormEvent} from 'react';
import {Building2,ChevronRight,MessageCircle,RefreshCw,Settings2,Users} from 'lucide-react';
import {api,type ChatDirectoryData,type DirectoryMember} from './api';
import WorkspaceDialog from './WorkspaceDialog';
import './OrganizationWork.css';

function EmployeePosition({member,busy,onSave}:{member:DirectoryMember;busy:boolean;onSave:(values:{job_title:string;position_rank:number;is_senior:boolean})=>void}) {
  const [title,setTitle]=useState(member.job_title),[rank,setRank]=useState(member.position_rank),[senior,setSenior]=useState(member.is_senior);
  return <form className="org-work-form" onSubmit={e=>{e.preventDefault();onSave({job_title:title,position_rank:rank,is_senior:senior});}}>
    <label>Position title<input value={title} maxLength={100} placeholder="e.g. Project Manager" onChange={e=>setTitle(e.target.value)}/></label>
    <label>Position order (1 is highest)<input type="number" min={1} max={10000} required value={rank} onChange={e=>setRank(Number(e.target.value))}/></label>
    <label>Employee role<select value={senior?'senior':'employee'} onChange={e=>setSenior(e.target.value==='senior')}><option value="employee">Employee</option><option value="senior">Senior</option></select></label>
    <p className="org-work-hint">Seniors can create project groups and assign tasks. This does not grant workspace admin access.</p>
    <button className="primary-button" disabled={busy}>Save employee position</button>
  </form>;
}

export default function ChatDirectory({data,loading,onReload,onStartChat,busy=false,currentUserId}:{data:ChatDirectoryData|null;loading:boolean;onReload:()=>void;onStartChat:(email:string)=>void;busy?:boolean;currentUserId:string}) {
  const [department,setDepartment]=useState<string|null>(null),[team,setTeam]=useState<string|null>(null),[editing,setEditing]=useState(false);
  const [name,setName]=useState(''),[teamId,setTeamId]=useState(''),[departmentId,setDepartmentId]=useState(''),[memberId,setMemberId]=useState('');
  const [teamName,setTeamName]=useState(''),[personId,setPersonId]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  async function save(action:()=>Promise<unknown>) {setSaving(true);setError('');try{await action();onReload();}catch(e){setError(e instanceof Error?e.message:'Could not save directory');}finally{setSaving(false);}}
  const departments=[...(data?.departments||[]),{id:'unassigned',name:'Teams'}];
  const employee=data?.members.find(row=>row.id===memberId);
  return <div className="org-directory">
    <div className="org-directory-heading">
      <p>Choose a department or team to find a colleague.</p>
      <button type="button" className="icon-button" aria-label="Refresh departments" title="Refresh departments" onClick={onReload}>
        <RefreshCw size={15}/>
      </button>
      {data?.can_manage&&<button className="icon-button" type="button" aria-label="Manage departments and positions" title="Manage departments and positions" onClick={()=>setEditing(true)}><Settings2 size={16}/></button>}
    </div>
    {loading&&!data?<p className="org-work-hint" role="status">Loading departments…</p>:!data?<p className="org-work-hint">Department directory is unavailable. Refresh to try again.</p>:<>
      {departments.filter(row=>row.id!=='unassigned'||data.teams.some(item=>!item.department_id)).map(row=>{
        const teams=data.teams.filter(item=>(item.department_id||'unassigned')===row.id),open=department===row.id;
        return <div key={row.id}><button className="org-directory-department" type="button" aria-expanded={open} onClick={()=>{setDepartment(open?null:row.id);setTeam(null);}}><Building2 size={16}/><span>{row.name}</span><small>{teams.length}</small><ChevronRight size={15} className={open?'expanded':''}/></button>
          {open&&<div className="org-directory-teams">{teams.length===0&&<p className="org-work-hint">No teams in this department yet.</p>}{teams.map(item=><div key={item.id}>
            <button className="org-directory-team" type="button" aria-expanded={team===item.id} onClick={()=>setTeam(team===item.id?null:item.id)}><Users size={15}/><span>{item.name}</span><small>{item.members.length}</small></button>
            {team===item.id&&<div className="org-directory-members">{item.members.map(member=><button className="org-directory-member" key={member.id} type="button" disabled={busy||member.user.id===currentUserId} aria-label={`Chat with ${member.user.full_name}`} onClick={()=>onStartChat(member.user.email)}>
              <span className="org-directory-avatar">{member.user.full_name.slice(0,1).toUpperCase()}</span><span><strong>{member.user.full_name}{member.user.id===currentUserId?' (You)':''}</strong><small>{member.job_title||'Position not set'}{member.is_senior?' · Senior':''}</small></span><MessageCircle size={14}/></button>)}{item.members.length===0&&<p className="org-work-hint">No employees in this team yet.</p>}</div>}
          </div>)}</div>}
        </div>;
      })}
      {data.departments.length===0&&data.teams.length===0&&<p className="org-work-hint">No departments or teams yet.{data.can_manage?' Use Manage to create the directory.':''}</p>}
    </>}
    {editing&&data&&<WorkspaceDialog title="Manage departments and employee positions" busy={saving} onClose={()=>setEditing(false)}>
      {error&&<p className="org-work-error" role="alert">{error}</p>}
      <section><h3>Create department</h3><form className="org-work-inline" onSubmit={(e:FormEvent)=>{e.preventDefault();void save(async()=>{await api.createDepartment(name);setName('');});}}><input aria-label="Department name" placeholder="Department name" required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/><button className="primary-button" disabled={saving}>Create department</button></form></section>
      <section><h3>Create team</h3><form className="org-work-form" onSubmit={e=>{e.preventDefault();void save(async()=>{const created=await api.createTeam(teamName);if(departmentId)await api.moveDirectoryTeam(created.id,departmentId);setTeamName('');});}}>
        <label>Team name<input value={teamName} required maxLength={120} onChange={e=>setTeamName(e.target.value)}/></label>
        <label>Department<select value={departmentId} onChange={e=>setDepartmentId(e.target.value)}><option value="">Unassigned</option>{data.departments.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button className="primary-button" disabled={saving}>Create team</button>
      </form></section>
      <section><h3>Organize existing teams</h3><form className="org-work-form" onSubmit={e=>{e.preventDefault();void save(()=>api.moveDirectoryTeam(teamId,departmentId||null));}}>
        <label>Team<select required value={teamId} onChange={e=>{setTeamId(e.target.value);setDepartmentId(data.teams.find(t=>t.id===e.target.value)?.department_id||'');}}><option value="">Select team</option>{data.teams.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>Move to department<select value={departmentId} onChange={e=>setDepartmentId(e.target.value)}><option value="">Unassigned</option>{data.departments.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button className="primary-button" disabled={saving||!teamId}>Save team department</button>
      </form>
      <form className="org-work-form" onSubmit={e=>{e.preventDefault();void save(()=>api.addDirectoryTeamMember(teamId,personId));}}><label>Add employee to selected team<select required value={personId} onChange={e=>setPersonId(e.target.value)}><option value="">Select employee</option>{data.members.map(row=><option value={row.user.id} key={row.id}>{row.user.full_name}</option>)}</select></label><button className="outline-button" disabled={saving||!teamId||!personId}>Add team employee</button></form></section>
      <section><h3>Employee positions and Senior role</h3><label className="org-work-label">Employee<select value={memberId} onChange={e=>setMemberId(e.target.value)}><option value="">Select employee</option>{data.members.map(row=><option key={row.id} value={row.id}>{row.user.full_name}</option>)}</select></label>
        {employee&&<EmployeePosition key={employee.id+employee.job_title+employee.position_rank+employee.is_senior} member={employee} busy={saving} onSave={values=>void save(()=>api.updateDirectoryMember(employee.id,values))}/>}</section>
    </WorkspaceDialog>}
  </div>;
}
