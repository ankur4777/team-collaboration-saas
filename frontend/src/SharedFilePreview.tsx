import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { api, type WorkspaceFile } from './api';

type Preview = {kind:'loading'} | {kind:'error';message:string} | {kind:'unsupported'}
  | {kind:'image'|'pdf';url:string} | {kind:'text';text:string};
const imageTypes = new Set(['image/png','image/jpeg','image/webp']);

export default function SharedFilePreview({file,onClose}:{file:WorkspaceFile;onClose:()=>void}) {
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
    const type = file.content_type.toLowerCase().split(';')[0].trim();
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
        const blob = await api.workspaceFileContent(file,controller.signal);
        if (!active) return;
        if (type === 'text/plain') {
          const text = await blob.text();
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
  }, [file,attempt]);

  async function download() {
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
      <div><p>FILE PREVIEW</p><h2 id={titleId}>{file.name}</h2></div>
      <button type="button" className="shared-file-preview-close" aria-label="Close file preview" onClick={onClose}><X size={20}/></button>
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
      <div><p>Shared by {file.uploaded_by.full_name}</p>{file.content_type === 'application/pdf' && <small>PDF viewing depends on your browser. You can also download the file.</small>}
        {downloadError && <p className="shared-file-preview-download-error" role="alert">{downloadError}</p>}</div>
      <button type="button" className="shared-file-download" disabled={downloading} onClick={() => void download()}><Download size={16}/>{downloading ? 'Downloading…' : 'Download'}</button>
    </footer>
  </dialog>,document.body);
}
