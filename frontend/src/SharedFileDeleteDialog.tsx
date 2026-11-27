import {useEffect,useId,useRef} from 'react';
import {createPortal} from 'react-dom';
import {Trash2,X} from 'lucide-react';

export default function SharedFileDeleteDialog({name,deleting,error,onCancel,onConfirm}:{
  name:string;deleting:boolean;error:string;onCancel:()=>void;onConfirm:()=>void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef(document.activeElement);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = previousFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<dialog ref={ref} className="shared-file-preview-dialog shared-file-delete-dialog"
    aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => {event.preventDefault();if(!deleting)onCancel();}}>
    <header className="shared-file-preview-heading">
      <span className="shared-file-preview-symbol"><Trash2 size={20}/></span>
      <div><h2 id={titleId}>Delete file?</h2></div>
      <button type="button" className="shared-file-preview-close" disabled={deleting} aria-label="Close delete confirmation" onClick={onCancel}><X size={20}/></button>
    </header>
    <div className="shared-file-delete-content" aria-busy={deleting}>
      <p className="shared-file-delete-name">{name}</p>
      <p id={descriptionId}>This file will be removed from the workspace for everyone. This cannot be undone.</p>
      {error && <p className="shared-file-delete-error" role="alert">{error}</p>}
    </div>
    <footer className="shared-file-preview-footer shared-file-delete-footer">
      <button type="button" className="shared-file-download" autoFocus disabled={deleting} onClick={onCancel}>Cancel</button>
      <button type="button" className="shared-file-preview-button shared-file-preview-confirm" disabled={deleting} onClick={onConfirm}><Trash2 size={16}/>{deleting?'Deleting…':'Delete file'}</button>
    </footer>
  </dialog>,document.body);
}
