import { useState } from 'react';
import type { Person } from './api';

export default function ChatAvatar({ person }: { person?: Person }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = person?.avatar_url;
  if (url && url !== failedUrl) {
    return <img className="chat-profile-photo" src={url} alt="" onError={() => setFailedUrl(url)} />;
  }
  return <>{person?.full_name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'}</>;
}
