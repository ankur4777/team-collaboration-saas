import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, File, FileText, FolderOpen, Image, Search, Upload } from 'lucide-react';
import { api, type WorkspaceFile } from './api';
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
  return type.startsWith('image/') ? <Image size={21}/> : type === 'application/pdf' ? <FileText size={21}/> : <File size={21}/>;
}

export default function SharedFilesPanel({workspaceId}:{workspaceId:string|null}) {
  const [files,setFiles] = useState<WorkspaceFile[]>([]);
  const [query,setQuery] = useState('');
  const [category,setCategory] = useState<Category>('all');
  const [loading,setLoading] = useState(true);
  const [uploading,setUploading] = useState(false);
  const [error,setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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

  async function upload(file:File|undefined) {
    if (!file) return;
    if (file.size <= 0 || file.size > LIMIT) {
      setError('Choose a file up to 5 MB.');
      return;
    }
    setUploading(true); setError('');
    try {
      const row = await api.uploadWorkspaceFile(file);
      setFiles(current => [row, ...current.filter(item => item.id !== row.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not upload file');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  function submitSearch(event:FormEvent) {
    event.preventDefault();
    void load(query, category);
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
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt" onChange={event => void upload(event.target.files?.[0])}/>
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
          <div className="shared-file-main"><strong>{file.name}</strong><small>{sizeLabel(file.size)} · Uploaded by {file.uploaded_by.full_name} · {dateLabel(file.created_at)}</small></div>
          <button type="button" className="shared-file-download" onClick={() => void api.downloadWorkspaceFile(file)}
            aria-label={`Download ${file.name}`}><Download size={16}/>Download</button>
        </article>)}</div>}
    <p className="shared-files-note">Allowed: PNG, JPEG, WebP, PDF, and TXT files up to 5 MB. Files are visible only inside this workspace.</p>
  </section>;
}
