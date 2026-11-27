import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, Eye, File as FileIcon, FileText, FolderOpen, Image, Search, Trash2, Upload } from 'lucide-react';
import { api, type WorkspaceFile } from './api';
import SharedFilePreview from './SharedFilePreview';
import SharedFileDeleteDialog from './SharedFileDeleteDialog';
import './SharedFilesPanel.css';

type Category = 'all' | 'images' | 'documents';
const LIMIT = 5 * 1024 * 1024;

function sizeLabel(bytes:number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function dateLabel(value:string) {
  return new Intl.DateTimeFormat(undefined, {day:'numeric', month:'short', year:'numeric'}).format(new Date(value));
}
function FileGlyph({type}:{type:string}) {
  return type.startsWith('image/') ? <Image size={21}/> : type === 'application/pdf' ? <FileText size={21}/> : <FileIcon size={21}/>;
}

export default function SharedFilesPanel({workspaceId}:{workspaceId:string|null}) {
  const [files,setFiles] = useState<WorkspaceFile[]>([]);
  const [query,setQuery] = useState('');
  const [category,setCategory] = useState<Category>('all');
  const [loading,setLoading] = useState(true);
  const [uploading,setUploading] = useState(false);
  const [error,setError] = useState('');
  const [preview,setPreview] = useState<{file:WorkspaceFile|File;workspaceId:string|null}|null>(null);
  const [uploadError,setUploadError] = useState('');
  const [deleteTarget,setDeleteTarget] = useState<{file:WorkspaceFile;workspaceId:string|null}|null>(null);
  const [deleting,setDeleting] = useState(false);
  const [deleteError,setDeleteError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;

  useEffect(() => { setPreview(null); setDeleteTarget(null); setDeleteError(''); }, [workspaceId]);

  async function load(nextQuery=query, nextCategory=category) {
    if (!workspaceId) { setFiles([]); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const response = await api.workspaceFiles(nextQuery, nextCategory);
      setFiles(response.results);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load shared files');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [workspaceId, category]);

  function selectFile(file:File|undefined) {
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    if (file.size <= 0 || file.size > LIMIT) {
      setError('Choose a file up to 5 MB.');
      return;
    }
    if (!/\.(png|jpe?g|webp|pdf|txt)$/i.test(file.name)) {
      setError('Choose a PNG, JPEG, WebP, PDF, or TXT file.');
      return;
    }
    setError(''); setUploadError('');
    setPreview({file,workspaceId});
  }

  async function upload(file:File) {
    if (uploading) return;
    const uploadWorkspace = workspaceId;
    setUploading(true); setUploadError('');
    try {
      const row = await api.uploadWorkspaceFile(file);
      if (activeWorkspace.current === uploadWorkspace) {
        setFiles(current => [row, ...current.filter(item => item.id !== row.id)]);
        setPreview(null);
      }
    } catch (reason) {
      if (activeWorkspace.current === uploadWorkspace) setUploadError(reason instanceof Error ? reason.message : 'Could not upload file');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  function submitSearch(event:FormEvent) {
    event.preventDefault();
    void load(query, category);
  }

  async function download(file:WorkspaceFile) {
    try { await api.downloadWorkspaceFile(file); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not download file'); }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting || deleteTarget.workspaceId !== activeWorkspace.current) return;
    const target = deleteTarget;
    setDeleting(true); setDeleteError('');
    try {
      await api.deleteWorkspaceFile(target.file.id);
      if (activeWorkspace.current === target.workspaceId) {
        setFiles(current => current.filter(file => file.id !== target.file.id));
        setDeleteTarget(null);
      }
    } catch (reason) {
      if (activeWorkspace.current === target.workspaceId) setDeleteError(reason instanceof Error ? reason.message : 'Could not delete file');
    } finally { setDeleting(false); }
  }

  return <section className="shared-files-page" aria-label="Shared files">
    <header className="shared-files-heading">
      <div>
        <div className="eyebrow">WORKSPACE LIBRARY</div>
        <h1>Shared files</h1>
        <p>Files shared securely with everyone in this workspace.</p>
      </div>
      <label className={"shared-files-upload" + (uploading ? ' busy' : '')}>
        <Upload size={16}/>{uploading ? 'Uploading…' : 'Upload file'}
        <input ref={inputRef} type="file" aria-label="Upload a shared file" disabled={uploading}
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt" onChange={event => selectFile(event.target.files?.[0])}/>
      </label>
    </header>

    <div className="shared-files-toolbar">
      <form className="shared-files-search" onSubmit={submitSearch}>
        <Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Search files" aria-label="Search shared files"/>
        <button className="outline-button" type="submit">Search</button>
      </form>
      <div className="shared-files-filter" role="group" aria-label="File type filter">
        {([['all','All files'],['images','Images'],['documents','Documents']] as const).map(([value,label]) =>
          <button key={value} type="button" className={category===value ? 'active' : ''}
            onClick={() => setCategory(value)}>{label}</button>)}
      </div>
    </div>

    {error && <div className="shared-files-error" role="alert">{error}</div>}
    <div className="shared-files-summary">{loading ? 'Loading files…' : `${files.length} file${files.length===1?'':'s'} in this workspace`}</div>
    {loading ? <div className="shared-files-empty"><FolderOpen size={30}/><p>Loading your workspace files…</p></div>
      : files.length === 0 ? <div className="shared-files-empty"><FolderOpen size={34}/><h2>No shared files yet</h2><p>Upload a PDF, image, or text file to make it available to your workspace.</p></div>
      : <div className="shared-files-list">{files.map(file =>
        <article key={file.id} className="shared-file-row">
          <span className="shared-file-icon"><FileGlyph type={file.content_type}/></span>
          <div className="shared-file-main"><button type="button" className="shared-file-name" onClick={() => setPreview({file,workspaceId})}
            aria-label={`Preview ${file.name}`} title={file.name}>{file.name}</button><small>{sizeLabel(file.size)} · Uploaded by {file.uploaded_by.full_name} · {dateLabel(file.created_at)}</small></div>
          <div className="shared-file-actions">
            <button type="button" className="shared-file-preview-button" onClick={() => setPreview({file,workspaceId})}
              aria-label={`Open preview of ${file.name}`}><Eye size={16}/>Preview</button>
            <button type="button" className="shared-file-download" onClick={() => void download(file)}
              aria-label={`Download ${file.name}`}><Download size={16}/>Download</button>
            {file.can_delete && <button type="button" className="shared-file-download shared-file-delete" disabled={deleting}
              onClick={() => {setDeleteError('');setDeleteTarget({file,workspaceId});}}
              aria-label={`Delete ${file.name}`}><Trash2 size={16}/>Delete</button>}
          </div>
        </article>)}</div>}
    <p className="shared-files-note">Allowed: PNG, JPEG, WebP, PDF, and TXT files up to 5 MB. Files are visible only inside this workspace.</p>
    {preview && preview.workspaceId === workspaceId && <SharedFilePreview key={preview.file instanceof File ? 'selected-file' : preview.file.id}
      file={preview.file} uploading={uploading} uploadError={uploadError} onUpload={file => void upload(file)}
      onClose={() => { if (!uploading) setPreview(null); }}/>}
    {deleteTarget && deleteTarget.workspaceId === workspaceId && <SharedFileDeleteDialog name={deleteTarget.file.name}
      deleting={deleting} error={deleteError} onCancel={() => {if(!deleting)setDeleteTarget(null);}} onConfirm={() => void confirmDelete()}/>}
  </section>;
}

