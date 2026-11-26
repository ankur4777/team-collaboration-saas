import { LayoutGrid } from 'lucide-react';

export default function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand" aria-label="TeamWorkspace"><span className="brand-mark" aria-hidden="true"><LayoutGrid size={19} strokeWidth={2.6}/></span>{!compact && <span>team<span className="brand-accent">workspace</span></span>}</div>;
}
