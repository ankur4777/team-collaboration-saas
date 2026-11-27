import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {CheckSquare,Plus,RefreshCw,Pencil,Trash2} from 'lucide-react';
import {api,type DirectoryMember,type EmployeeTask,type TaskInput,type TaskStatus} from './api';
import WorkspaceDialog from './WorkspaceDialog';
import './OrganizationWork.css';

const statuses=[['todo','To do'],['in_progress','In progress'],['done','Done']] as const;
function TaskForm({task,people,busy,onSubmit,onCancel}:{task:EmployeeTask|null;people:DirectoryMember[];busy:boolean;onSubmit:(data:TaskInput)=>void;onCancel:()=>void}) {
  const [title,setTitle]=useState(task?.title||''),[description,setDescription]=useState(task?.description||''),[assignee,setAssignee]=useState(task?.assignee.id||''),[priority,setPriority]=useState<EmployeeTask['priority']>(task?.priority||'normal'),[due,setDue]=useState(task?.due_date||'');
  const choices=people.some(p=>p.user.id===task?.assignee.id)||!task?people:[...people,{id:'previous',user:task.assignee,role:'member',job_title:'',position_rank:100,is_senior:false}];
  return <form className="org-work-form" onSubmit={(e:FormEvent)=>{e.preventDefault();onSubmit({title:title.trim(),description:description.trim(),assignee_id:assignee,priority,due_date:due||null});}}>
    <label>Task title<input autoFocus required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea rows={4} maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <label>Assign to employee<select required value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">Select employee</option>{choices.map(person=><option key={person.id} value={person.user.id}>{person.user.full_name}{person.job_title?` — ${person.job_title}`:''}</option>)}</select></label>
    <div className="org-work-form-columns"><label>Due date<input type="date" value={due} onChange={e=>setDue(e.target.value)}/></label><label>Priority<select value={priority} onChange={e=>setPriority(e.target.value as EmployeeTask['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div>
    <div className="org-work-actions"><button className="outline-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy||!title.trim()||!assignee}>{busy?'Saving…':task?'Save task':'Assign task'}</button></div>
  </form>;
}

export default function TasksPanel({workspaceId}:{workspaceId:string|null}) {
  const [tasks,setTasks]=useState<EmployeeTask[]>([]),[people,setPeople]=useState<DirectoryMember[]>([]),[canAssign,setCanAssign]=useState(false);
  const [status,setStatus]=useState(''),[scope,setScope]=useState('all'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[formError,setFormError]=useState('');
  const [editing,setEditing]=useState<EmployeeTask|null|undefined>(undefined),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  const load=useCallback(async()=>{
    const run=++generation.current;
    if(!workspaceId){setTasks([]);setLoading(false);return;}
    setLoading(true);
    try{const data=await api.employeeTasks(status,scope);if(run!==generation.current)return;setTasks(data.results);setCanAssign(data.can_assign);setError('');}
    catch(e){if(run===generation.current)setError(e instanceof Error?e.message:'Could not load tasks');}
    finally{if(run===generation.current)setLoading(false);}
  },[workspaceId,status,scope]);
  useEffect(()=>{void load();const refresh=()=>{if(!document.hidden)void load();};const timer=window.setInterval(refresh,15000);window.addEventListener('focus',refresh);return()=>{generation.current++;window.clearInterval(timer);window.removeEventListener('focus',refresh);};},[load]);
  async function openForm(task:EmployeeTask|null){setFormError('');try{const directory=await api.chatDirectory();setPeople(directory.members);setEditing(task);}catch(e){setError(e instanceof Error?e.message:'Could not load employees');}}
  async function save(data:TaskInput){if(busy)return;setBusy(true);setFormError('');try{if(editing)await api.updateEmployeeTask(editing.id,data);else await api.createEmployeeTask(data);setEditing(undefined);void load();}catch(e){setFormError(e instanceof Error?e.message:'Could not save task');}finally{setBusy(false);}}
  async function changeStatus(task:EmployeeTask,value:TaskStatus){if(busy)return;setBusy(true);setError('');try{await api.updateEmployeeTask(task.id,{status:value});await load();}catch(e){setError(e instanceof Error?e.message:'Could not update task');}finally{setBusy(false);}}
  async function remove(task:EmployeeTask){if(busy||!window.confirm(`Delete task "${task.title}"? This cannot be undone.`))return;setBusy(true);setError('');try{await api.deleteEmployeeTask(task.id);await load();}catch(e){setError(e instanceof Error?e.message:'Could not delete task');}finally{setBusy(false);}}
  return <section className="org-tasks-page" aria-label="Employee tasks">
    <div className="org-tasks-heading"><div><div className="eyebrow">PROJECT WORK / EMPLOYEE TASKS</div><h1>Tasks</h1><p>Keep assignments, owners, priorities, and progress in one place.</p></div>{canAssign&&<button className="primary-button" type="button" onClick={()=>void openForm(null)}><Plus size={16}/>Assign task</button>}</div>
    <div className="org-tasks-toolbar"><label>Status<select aria-label="Filter task status" value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option>{statuses.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>Show<select aria-label="Filter task assignments" value={scope} onChange={e=>setScope(e.target.value)}><option value="all">All visible tasks</option><option value="mine">Assigned to me</option></select></label><button className="outline-button" type="button" onClick={()=>void load()}><RefreshCw size={15}/>Refresh</button></div>
    {error&&<p className="org-work-error" role="alert">{error}</p>}
    <p className="org-work-hint" role="status">{loading?'Loading tasks…':`${tasks.length} task${tasks.length===1?'':'s'}`}</p>
    {!loading&&tasks.length===0&&<div className="org-tasks-empty"><CheckSquare size={36}/><h2>No tasks to show</h2><p>{canAssign?'Assign the first task to an employee.':'Tasks assigned to you will appear here.'}</p></div>}
    <div className="org-task-grid">{tasks.map(task=><article className="org-task-card" key={task.id}><div className="org-task-card-top"><span className={`org-task-priority ${task.priority}`}>{task.priority} priority</span><span className={`org-task-status ${task.status}`}>{statuses.find(([value])=>value===task.status)?.[1]}</span></div><h2>{task.title}</h2>{task.description&&<p className="org-task-description">{task.description}</p>}<dl><div><dt>Assigned to</dt><dd>{task.assignee.full_name}</dd></div><div><dt>Assigned by</dt><dd>{task.assigned_by.full_name}</dd></div><div><dt>Due date</dt><dd>{task.due_date?new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'}).format(new Date(task.due_date+'T12:00:00')):'No due date'}</dd></div></dl>
      <div className="org-task-card-actions">{task.can_update_status&&<label>Status<select aria-label={`Status for ${task.title}`} value={task.status} disabled={busy} onChange={e=>void changeStatus(task,e.target.value as TaskStatus)}>{statuses.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>}{task.can_manage&&<><button className="outline-button" type="button" disabled={busy} aria-label={`Edit ${task.title}`} onClick={()=>void openForm(task)}><Pencil size={14}/>Edit</button><button className="outline-button" type="button" disabled={busy} aria-label={`Delete ${task.title}`} onClick={()=>void remove(task)}><Trash2 size={14}/></button></>}</div>
    </article>)}</div>
    {editing!==undefined&&<WorkspaceDialog title={editing?'Edit employee task':'Assign task to employee'} busy={busy} onClose={()=>setEditing(undefined)}>{formError&&<p className="org-work-error" role="alert">{formError}</p>}<TaskForm task={editing} people={people} busy={busy} onCancel={()=>setEditing(undefined)} onSubmit={data=>void save(data)}/></WorkspaceDialog>}
  </section>;
}
