import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SharedFilesPanel from './SharedFilesPanel';
import {api,type WorkspaceFile} from './api';

const image:WorkspaceFile = {id:'image-1',name:'Team photo.png',content_type:'image/png',size:1024,created_at:'2026-11-27T10:00:00Z',uploaded_by:{id:'user-1',full_name:'Ankur',email:'ankur@example.com'}};
const pdf = {...image,id:'pdf-1',name:'Guide.pdf',content_type:'application/pdf'};
const text = {...image,id:'text-1',name:'Notes.txt',content_type:'text/plain'};
const createUrl = vi.fn((_blob:Blob) => 'blob:shared-preview');
const revokeUrl = vi.fn();
const payload = () => new Blob(['file bytes'],{type:'application/octet-stream'});

// jsdom exposes dialog elements but does not implement their native methods.
if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open',''); };
if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };

beforeEach(() => {
  vi.spyOn(api,'workspaceFiles').mockResolvedValue({results:[image,pdf,text],limit:100});
  vi.spyOn(api,'downloadWorkspaceFile').mockResolvedValue();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,blob:async()=>payload()}));
  createUrl.mockClear(); revokeUrl.mockClear();
  vi.stubGlobal('URL',class extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
  vi.spyOn(HTMLDialogElement.prototype,'showModal').mockImplementation(function(this:HTMLDialogElement) { this.setAttribute('open',''); });
  vi.spyOn(HTMLDialogElement.prototype,'close').mockImplementation(function(this:HTMLDialogElement) { this.removeAttribute('open'); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Shared file previews',() => {
  it('previews images through the authenticated endpoint and preserves download',async() => {
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Open preview of Team photo.png'}));
    const dialog = await screen.findByRole('dialog',{name:image.name});
    const img = await screen.findByRole('img',{name:image.name});
    expect(img.getAttribute('src')).toBe('blob:shared-preview');
    expect(createUrl.mock.calls[0][0].type).toBe('image/png');
    expect(fetch).toHaveBeenCalledWith('/api/files/image-1/download/',expect.objectContaining({credentials:'same-origin',cache:'no-store',signal:expect.any(AbortSignal)}));
    await user.click(dialog.querySelector('footer button')!);
    expect(api.downloadWorkspaceFile).toHaveBeenCalledWith(image);
    await user.click(screen.getByRole('button',{name:'Close file preview'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith('blob:shared-preview');
    expect(document.body.style.overflow).toBe('');
  });

  it('opens PDFs with the correct content type',async() => {
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Preview Guide.pdf'}));
    await waitFor(() => expect(screen.getByTitle('PDF preview of Guide.pdf').getAttribute('src')).toBe('blob:shared-preview'));
    expect(createUrl.mock.calls[0][0].type).toBe('application/pdf');
  });

  it('renders text literally, including HTML, without executing it',async() => {
    const contents = '<script>alert("unsafe")</script>\nMeeting notes';
    vi.spyOn(api,'workspaceFileContent').mockResolvedValue(Object.assign(payload(),{text:async()=>contents}));
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Preview Notes.txt'}));
    const pre = await screen.findByText(contents,{selector:'pre',normalizer:value=>value});
    expect(pre.textContent).toBe(contents);
    expect(pre.querySelector('script')).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('previews the selected file locally and waits for Upload confirmation',async() => {
    const upload = vi.spyOn(api,'uploadWorkspaceFile').mockResolvedValue({...image,id:'new-image',name:'New photo.png'});
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    const selectedFile = new File(['png'],'New photo.png',{type:'image/png'});
    await user.upload(screen.getByLabelText('Upload a shared file'),selectedFile);
    expect(await screen.findByRole('dialog',{name:'New photo.png'})).toBeTruthy();
    expect(await screen.findByRole('img',{name:'New photo.png'})).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Upload'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(upload).toHaveBeenCalledWith(selectedFile);
    expect(screen.getByRole('button',{name:'Preview New photo.png'})).toBeTruthy();
  });

  it('cancels without uploading and allows selecting the same file again',async() => {
    const upload = vi.spyOn(api,'uploadWorkspaceFile');
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    const selectedFile = new File(['png'],'New photo.png',{type:'image/png'});
    const input = screen.getByLabelText('Upload a shared file');
    await user.upload(input,selectedFile);
    await screen.findByRole('img',{name:selectedFile.name});
    await user.click(screen.getByRole('button',{name:'Cancel'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:shared-preview');
    await user.upload(input,selectedFile);
    expect(await screen.findByRole('img',{name:selectedFile.name})).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('previews a local PDF without a network request',async() => {
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    await user.upload(screen.getByLabelText('Upload a shared file'),new File(['%PDF-1.4'],'Draft.pdf',{type:'application/pdf'}));
    expect(await screen.findByTitle('PDF preview of Draft.pdf')).toBeTruthy();
    expect(createUrl.mock.calls[0][0].type).toBe('application/pdf');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('previews local text as plain text before uploading',async() => {
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    const contents = '<script>local preview</script>\nDraft notes';
    await user.upload(screen.getByLabelText('Upload a shared file'),new File([contents],'Draft.txt',{type:'text/plain'}));
    const pre = await screen.findByText(contents,{selector:'pre',normalizer:value=>value});
    expect(pre.querySelector('script')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains the selected file and allows retrying a failed upload',async() => {
    const upload = vi.spyOn(api,'uploadWorkspaceFile').mockRejectedValueOnce(new Error('Upload failed')).mockResolvedValue({...image,id:'new-image',name:'New photo.png'});
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    const selectedFile = new File(['png'],'New photo.png',{type:'image/png'});
    await user.upload(screen.getByLabelText('Upload a shared file'),selectedFile);
    await screen.findByRole('img',{name:selectedFile.name});
    await user.click(screen.getByRole('button',{name:'Upload'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Upload failed');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Upload'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('discards an unuploaded selection when switching workspaces',async() => {
    const upload = vi.spyOn(api,'uploadWorkspaceFile');
    const user = userEvent.setup();
    const view = render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await screen.findByRole('button',{name:'Preview Team photo.png'});
    await user.upload(screen.getByLabelText('Upload a shared file'),new File(['png'],'Draft.png',{type:'image/png'}));
    await screen.findByRole('img',{name:'Draft.png'});
    view.rerender(<SharedFilesPanel workspaceId="workspace-b"/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:shared-preview');
  });

  it('shows denied access as an error and supports retry',async() => {
    vi.mocked(fetch).mockResolvedValueOnce({ok:false} as Response);
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Preview Team photo.png'}));
    expect((await screen.findByRole('alert')).textContent).toContain('File unavailable or access denied');
    expect(createUrl).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Try again'}));
    expect(await screen.findByRole('img',{name:image.name})).toBeTruthy();
  });

  it('closes and releases preview data when switching workspaces',async() => {
    const user = userEvent.setup();
    const view = render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Preview Team photo.png'}));
    await screen.findByRole('img',{name:image.name});
    const options = vi.mocked(fetch).mock.calls[0][1]!;
    view.rerender(<SharedFilesPanel workspaceId="workspace-b"/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(options.signal!.aborted).toBe(true);
    expect(revokeUrl).toHaveBeenCalledWith('blob:shared-preview');
    view.rerender(<SharedFilesPanel workspaceId="workspace-a"/>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores an outstanding request after the preview closes',async() => {
    let resolve!:(blob:Blob)=>void;
    vi.spyOn(api,'workspaceFileContent').mockImplementation(() => new Promise(done => {resolve=done;}));
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    await user.click(await screen.findByRole('button',{name:'Preview Team photo.png'}));
    expect(screen.getByRole('status').textContent).toBe('Loading preview…');
    await user.click(screen.getByRole('button',{name:'Close file preview'}));
    await act(async() => { resolve(payload()); });
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('handles Escape cancellation and returns focus to the trigger',async() => {
    const user = userEvent.setup();
    render(<SharedFilesPanel workspaceId="workspace-a"/>);
    const trigger = await screen.findByRole('button',{name:'Preview Team photo.png'});
    await user.click(trigger);
    fireEvent(screen.getByRole('dialog'),new Event('cancel',{cancelable:true}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
