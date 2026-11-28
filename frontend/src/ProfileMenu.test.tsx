import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProfileMenu from './ProfileMenu';
import {api,csrf,type Person} from './api';

const person:Person={id:'user-1',full_name:'Test User',email:'test@example.com',email_verified:true,avatar_url:null};
const createUrl=vi.fn(()=> 'blob:photo-preview'),revokeUrl=vi.fn();
if(!HTMLDialogElement.prototype.showModal)HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
if(!HTMLDialogElement.prototype.close)HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
beforeEach(()=>{
  createUrl.mockClear();revokeUrl.mockClear();
  vi.stubGlobal('URL',class extends URL {static createObjectURL=createUrl;static revokeObjectURL=revokeUrl;});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function edit(){
  await userEvent.click(screen.getByRole('button',{name:'Open profile menu'}));
  await userEvent.click(screen.getByRole('button',{name:'Edit profile'}));
  expect(screen.getByRole('dialog',{name:'Edit profile'})).toBeTruthy();
}

describe('Profile editing',()=>{
  it('opens from the avatar, saves a name, and displays the saved photo',async()=>{
    const updated={...person,full_name:'Updated Name',avatar_url:'/api/auth/profile/avatar/?v=photo'};
    vi.spyOn(api,'updateProfile').mockResolvedValue(updated);
    const onSaved=vi.fn();
    const {rerender}=render(<ProfileMenu user={person} onSaved={onSaved}/>);
    await edit();
    const name=screen.getByRole('textbox',{name:'Display name'});
    await userEvent.clear(name);await userEvent.type(name,'Updated Name');
    expect(screen.getByRole('textbox',{name:'Email'}).getAttribute('readonly')).not.toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalledWith(updated));
    expect(api.updateProfile).toHaveBeenCalledWith('Updated Name',null,false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'Open profile menu'}));
    rerender(<ProfileMenu user={updated} onSaved={onSaved}/>);
    expect(screen.getByRole('button',{name:'Open profile menu'}).querySelector('img')?.getAttribute('src')).toBe(updated.avatar_url);
  });

  it('previews a chosen photo, cancels without uploading, and releases the preview',async()=>{
    vi.spyOn(api,'updateProfile').mockResolvedValue(person);
    render(<ProfileMenu user={person} onSaved={vi.fn()}/>);await edit();
    const photo=new File(['png'],'my-photo.png',{type:'image/png'});
    await userEvent.upload(screen.getByLabelText('Choose profile photo'),photo);
    expect(screen.getByRole('img',{name:'Your profile'}).getAttribute('src')).toBe('blob:photo-preview');
    expect(api.updateProfile).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Cancel'}));
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:photo-preview');
  });

  it('uploads the selected photo only on save',async()=>{
    vi.spyOn(api,'updateProfile').mockResolvedValue(person);
    render(<ProfileMenu user={person} onSaved={vi.fn()}/>);await edit();
    const photo=new File(['png'],'my-photo.png',{type:'image/png'});
    await userEvent.upload(screen.getByLabelText('Choose profile photo'),photo);
    await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(api.updateProfile).toHaveBeenCalledWith(person.full_name,photo,false));
  });

  it('removes an existing photo and can retry a failed save',async()=>{
    vi.spyOn(api,'updateProfile').mockRejectedValueOnce(new Error('Could not save')).mockResolvedValue(person);
    const onSaved=vi.fn();render(<ProfileMenu user={{...person,avatar_url:'/photo'}} onSaved={onSaved}/>);await edit();
    await userEvent.click(screen.getByRole('button',{name:'Remove photo'}));
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Could not save');
    expect(onSaved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalledWith(person));
    expect(api.updateProfile).toHaveBeenLastCalledWith(person.full_name,null,true);
  });

  it('rejects oversized photos before uploading',async()=>{
    vi.spyOn(api,'updateProfile').mockResolvedValue(person);
    render(<ProfileMenu user={person} onSaved={vi.fn()}/>);await edit();
    const photo=new File([new Uint8Array(2*1024*1024+1)],'too-big.png',{type:'image/png'});
    await userEvent.upload(screen.getByLabelText('Choose profile photo'),photo);
    expect((await screen.findByRole('alert')).textContent).toContain('2 MB');
    expect(createUrl).not.toHaveBeenCalled();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('prevents duplicate saves and cancellation while the update is pending',async()=>{
    let finish!:(value:Person)=>void;
    vi.spyOn(api,'updateProfile').mockImplementation(()=>new Promise<Person>(resolve=>{finish=resolve;}));
    render(<ProfileMenu user={person} onSaved={vi.fn()}/>);await edit();
    await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    const saving=screen.getByRole('button',{name:'Saving…'}) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Cancel'}) as HTMLButtonElement).disabled).toBe(true);
    const dialog=screen.getByRole('dialog');fireEvent(dialog,new Event('cancel',{cancelable:true}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(saving);expect(api.updateProfile).toHaveBeenCalledOnce();
    finish(person);await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the menu with Escape or a click outside and opens settings',async()=>{
    const settings=vi.fn();render(<ProfileMenu user={person} onSaved={vi.fn()} onOpenSettings={settings}/>);
    const trigger=screen.getByRole('button',{name:'Open profile menu'});
    await userEvent.click(trigger);fireEvent.keyDown(document,{key:'Escape'});
    expect(screen.queryByRole('button',{name:'Edit profile'})).toBeNull();expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button',{name:'Edit profile'})).toBeNull();
    await userEvent.click(trigger);await userEvent.click(screen.getByRole('button',{name:'Account settings'}));
    expect(settings).toHaveBeenCalledOnce();
  });
});

it('sends authenticated multipart data with CSRF and lets the browser set its boundary',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({csrf_token:'token'})})
    .mockResolvedValueOnce({ok:true,json:async()=>person});
  vi.stubGlobal('fetch',fetchMock);await csrf();
  const photo=new File(['image'],'photo.png',{type:'image/png'});
  await api.updateProfile('Updated',photo);
  const [url,options]=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
  expect(url).toBe('/api/auth/profile/');expect(options.method).toBe('PATCH');
  expect(options.credentials).toBe('same-origin');expect(options.headers).toEqual({'X-CSRFToken':'token'});
  const body=options.body as FormData;expect(body.get('full_name')).toBe('Updated');expect(body.get('avatar')).toBe(photo);
});
