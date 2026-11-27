import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react';
import { api, type WorkspaceFile } from './api';

type Preview = {kind:'loading'} | {kind:'error';message:string} | {kind:'unsupported'}
  | {kind:'image'|'pdf';url:string} | {kind:'text';text:string};
const imageTypes = new Set(['image/png','image/jpeg','image/webp']);

function localContentType(file:File) {
  const types:Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain'};
  return types[file.name.split('.').pop()?.toLowerCase() || ''] || file.type;
}

function localText(file:File):Promise<string> {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsText(file);
  });
}

export default function SharedFilePreview({file,onClose,onUpload,uploading=false,uploadError=''}:{
  file:WorkspaceFile|File;onClose:()=>void;onUpload?:(file:File)=>void;uploading?:boolean;uploadError?:string;
}) {
  const contentType = file instanceof File ? localContentType(file) : file.content_type;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [preview,setPreview] = useState<Preview>({kind:'loading'});
  const [attempt,setAttempt] = useState(0);
  const [downloading,setDownloading] = useState(false);
  const [downloadError,setDownloadError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const type = contentType.toLowerCase().split(';')[0].trim();
    if (!imageTypes.has(type) && type !== 'application/pdf' && type !== 'text/plain') {
      setPreview({kind:'unsupported'});
      return;
    }
    const controller = new AbortController();
    let active = true;
    let objectUrl:string|undefined;
    setPreview({kind:'loading'});
    void (async () => {
      try {
        const blob = file instanceof File ? file : await api.workspaceFileContent(file,controller.signal);
        if (!active) return;
        if (type === 'text/plain') {
          const text = file instanceof File ? await localText(file) : await blob.text();
          if (active) setPreview({kind:'text',text});
        } else {
          // Downloads deliberately use octet-stream. Restore only an allowed MIME
          // type on this temporary blob so the browser can render it inline.
          objectUrl = URL.createObjectURL(new Blob([blob],{type}));
          setPreview({kind:type === 'application/pdf' ? 'pdf' : 'image',url:objectUrl});
        }
      } catch (reason) {
        if (active) setPreview({kind:'error',message:reason instanceof Error ? reason.message : 'Could not load this preview.'});
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file,contentType,attempt]);

  async function download() {
    if (file instanceof File) return;
    setDownloading(true); setDownloadError('');
    try { await api.downloadWorkspaceFile(file); }
    catch (reason) { setDownloadError(reason instanceof Error ? reason.message : 'Could not download file'); }
    finally { setDownloading(false); }
  }

  return createPortal(<dialog ref={dialogRef} className="shared-file-preview-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}>
    <header className="shared-file-preview-heading">
      <span className="shared-file-preview-symbol"><Eye size={20}/></span>
      <div><p>{file instanceof File ? 'REVIEW BEFORE UPLOADING' : 'FILE PREVIEW'}</p><h2 id={titleId}>{file.name}</h2></div>
      <button type="button" className="shared-file-preview-close" disabled={uploading} aria-label="Close file preview" onClick={onClose}><X size={20}/></button>
    </header>
    <div className="shared-file-preview-body" aria-busy={preview.kind === 'loading'}>
      {preview.kind === 'loading' && <div className="shared-file-preview-status" role="status"><LoaderCircle className="shared-file-preview-spinner" size={28}/><p>Loading preview…</p></div>}
      {preview.kind === 'error' && <div className="shared-file-preview-status" role="alert"><p>{preview.message}</p><button type="button" className="shared-file-preview-button" onClick={() => setAttempt(value => value+1)}><RotateCcw size={15}/>Try again</button></div>}
      {preview.kind === 'unsupported' && <div className="shared-file-preview-status"><p>Preview is not available for this file type. You can download it below.</p></div>}
      {preview.kind === 'image' && <img className="shared-file-preview-image" src={preview.url} alt={file.name}
        onError={() => setPreview({kind:'error',message:'This image could not be displayed. Try again or download the file.'})}/>}
      {preview.kind === 'pdf' && <iframe className="shared-file-preview-pdf" title={`PDF preview of ${file.name}`} src={preview.url}/>}
      {preview.kind === 'text' && <pre className="shared-file-preview-text">{preview.text || 'This text file is empty.'}</pre>}
    </div>
    <footer className="shared-file-preview-footer">
      <div><p>{file instanceof File ? 'This file has not been uploaded yet.' : `Shared by ${file.uploaded_by.full_name}`}</p>{contentType === 'application/pdf' && <small>PDF viewing depends on your browser.</small>}
        {uploadError && file instanceof File && <p className="shared-file-preview-download-error" role="alert">{uploadError}</p>}
        {downloadError && <p className="shared-file-preview-download-error" role="alert">{downloadError}</p>}</div>
      {file instanceof File ? <div className="shared-file-preview-footer-actions">
        <button type="button" className="shared-file-download" disabled={uploading} onClick={onClose}>Cancel</button>
        <button type="button" className="shared-file-preview-button shared-file-preview-confirm" disabled={uploading || preview.kind === 'loading'} onClick={() => onUpload?.(file)}><Upload size={16}/>{uploading ? 'Uploading…' : 'Upload'}</button>
      </div> : <button type="button" className="shared-file-download" disabled={downloading} onClick={() => void download()}><Download size={16}/>{downloading ? 'Downloading…' : 'Download'}</button>}
    </footer>
  </dialog>,document.body);
}
