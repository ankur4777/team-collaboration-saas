import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api,type ChatDirectoryData,type DirectoryMember,type EmployeeTask} from './api';
import ChatDirectory from './ChatDirectory';
import TasksPanel from './TasksPanel';

const senior:DirectoryMember={id:'senior-membership',role:'member',job_title:'Project Manager',position_rank:1,is_senior:true,user:{id:'senior',full_name:'Senior Employee',email:'senior@example.test'}};
const employee:DirectoryMember={id:'employee-membership',role:'member',job_title:'Developer',position_rank:10,is_senior:false,user:{id:'employee',full_name:'Junior Employee',email:'junior@example.test'}};
const directory:ChatDirectoryData={departments:[{id:'engineering',name:'Engineering'}],teams:[{id:'platform',name:'Platform',department_id:'engineering',members:[senior,employee]}],members:[senior,employee],can_manage:true,can_create_groups:true,can_assign_tasks:true};
const task:EmployeeTask={id:'task',title:'Build release',description:'Prepare the project release',assignee:{...employee.user,email_verified:true},assigned_by:{...senior.user,email_verified:true},status:'todo',priority:'high',due_date:'2026-12-20',created_at:'2026-11-27T12:00:00Z',updated_at:'2026-11-27T12:00:00Z',can_manage:true,can_update_status:true};
if(!HTMLDialogElement.prototype.showModal)HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
if(!HTMLDialogElement.prototype.close)HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
beforeEach(()=>{
  vi.spyOn(api,'chatDirectory').mockResolvedValue(directory);
  vi.spyOn(api,'employeeTasks').mockResolvedValue({results:[task],can_assign:true,limit:200});
  vi.spyOn(api,'createEmployeeTask').mockResolvedValue(task);
  vi.spyOn(api,'updateEmployeeTask').mockResolvedValue(task);
  vi.spyOn(api,'deleteEmployeeTask').mockResolvedValue();
  vi.spyOn(api,'updateDirectoryMember').mockResolvedValue(senior);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('Department employee directory',()=>{
  it('opens department then team and starts only the selected employee chat',async()=>{
    const user=userEvent.setup(),onStartChat=vi.fn();
    render(<ChatDirectory data={directory} loading={false} currentUserId="me" onReload={vi.fn()} onStartChat={onStartChat}/>);
    expect(screen.queryByRole('button',{name:/Chat with/})).toBeNull();
    await user.click(screen.getByRole('button',{name:/Engineering/}));
    expect(screen.queryByRole('button',{name:/Chat with/})).toBeNull();
    await user.click(screen.getByRole('button',{name:/Platform/}));
    expect(screen.getAllByRole('button',{name:/Chat with/}).map(row=>row.getAttribute('aria-label'))).toEqual(['Chat with Senior Employee','Chat with Junior Employee']);
    expect(onStartChat).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Chat with Junior Employee'}));
    expect(onStartChat).toHaveBeenCalledWith(employee.user.email);
  });

  it('shows existing teams without a department under Unassigned',async()=>{
    render(<ChatDirectory data={{...directory,departments:[],teams:[{...directory.teams[0],department_id:null}]}} loading={false} currentUserId="me" onReload={vi.fn()} onStartChat={vi.fn()}/>);
    await userEvent.setup().click(screen.getByRole('button',{name:/Unassigned teams/}));
    expect(screen.getByRole('button',{name:/Platform/})).toBeTruthy();
  });

  it('allows admins to assign the separate Senior role and position order',async()=>{
    const user=userEvent.setup(),reload=vi.fn();
    render(<ChatDirectory data={directory} loading={false} currentUserId="me" onReload={reload} onStartChat={vi.fn()}/>);
    await user.click(screen.getByRole('button',{name:'Manage departments and positions'}));
    const dialog=within(screen.getByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Employee'),employee.id);
    await user.clear(dialog.getByLabelText('Position title'));
    await user.type(dialog.getByLabelText('Position title'),'Team Lead');
    await user.clear(dialog.getByLabelText('Position order (1 is highest)'));
    await user.type(dialog.getByLabelText('Position order (1 is highest)'),'2');
    await user.selectOptions(dialog.getByLabelText('Employee role'),'senior');
    await user.click(dialog.getByRole('button',{name:'Save employee position'}));
    await waitFor(()=>expect(api.updateDirectoryMember).toHaveBeenCalledWith(employee.id,{job_title:'Team Lead',position_rank:2,is_senior:true}));
    expect(reload).toHaveBeenCalled();
  });

  it('hides management controls for ordinary employees',()=>{
    render(<ChatDirectory data={{...directory,can_manage:false}} loading={false} currentUserId="me" onReload={vi.fn()} onStartChat={vi.fn()}/>);
    expect(screen.queryByRole('button',{name:'Manage departments and positions'})).toBeNull();
  });
});

describe('Employee tasks',()=>{
  it('lets a Senior assign a task with employee, due date and priority',async()=>{
    const user=userEvent.setup();
    render(<TasksPanel workspaceId="workspace"/>);
    await user.click(await screen.findByRole('button',{name:'Assign task'}));
    const dialog=within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Task title'),'Review release');
    await user.type(dialog.getByLabelText('Description'),'Review all checks');
    await user.selectOptions(dialog.getByLabelText('Assign to employee'),employee.user.id);
    await user.type(dialog.getByLabelText('Due date'),'2026-12-20');
    await user.selectOptions(dialog.getByLabelText('Priority'),'high');
    await user.click(dialog.getByRole('button',{name:'Assign task'}));
    await waitFor(()=>expect(api.createEmployeeTask).toHaveBeenCalledWith({title:'Review release',description:'Review all checks',assignee_id:'employee',priority:'high',due_date:'2026-12-20'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('employees can change status without seeing management controls',async()=>{
    vi.mocked(api.employeeTasks).mockResolvedValue({results:[{...task,can_manage:false}],can_assign:false,limit:200});
    const user=userEvent.setup();
    render(<TasksPanel workspaceId="workspace"/>);
    await screen.findByRole('heading',{name:task.title});
    expect(screen.queryByRole('button',{name:'Assign task'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Edit '+task.title})).toBeNull();
    expect(screen.queryByRole('button',{name:'Delete '+task.title})).toBeNull();
    await user.selectOptions(screen.getByLabelText('Status for '+task.title),'in_progress');
    await waitFor(()=>expect(api.updateEmployeeTask).toHaveBeenCalledWith(task.id,{status:'in_progress'}));
  });

  it('retains the assignment form and shows server errors on failed save',async()=>{
    vi.mocked(api.createEmployeeTask).mockRejectedValue(new Error('Employee no longer belongs to this workspace'));
    const user=userEvent.setup();
    render(<TasksPanel workspaceId="workspace"/>);
    await user.click(await screen.findByRole('button',{name:'Assign task'}));
    const dialog=within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Task title'),'Review');
    await user.selectOptions(dialog.getByLabelText('Assign to employee'),employee.user.id);
    await user.click(dialog.getByRole('button',{name:'Assign task'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Employee no longer belongs to this workspace');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
