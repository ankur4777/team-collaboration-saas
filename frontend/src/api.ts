export interface Presence { user_id:string; online:boolean; last_seen_at:string|null }
export type PresenceMap = Record<string,Presence>;
export interface Person { id: string; email: string; full_name: string; email_verified: boolean }
export interface NotificationPreferences { direct_chats: boolean; group_chats: boolean; team_channels: boolean }
export interface AccountDeviceSession {
  id:string; user_agent:string; ip_address:string|null;
  created_at:string; last_seen_at:string; current:boolean;
}
export interface Org { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member' }
export interface Session { user: Person; organizations: Org[]; active_organization_id: string | null }
export interface Team { id: string; name: string; description: string; created_at: string; archived_at?: string|null }
export interface Channel { id: string; name: string; description: string; created_at: string; archived_at?: string|null; is_private?:boolean }
export interface ConversationPreferences {is_muted:boolean;is_pinned:boolean}
export interface ChannelNotice {
  is_muted?:boolean;is_pinned?:boolean;
  channel_id: string; channel_name: string; team_id: string; team_name: string;
  joined_at: string; unread_count: number; last_read_at: string|null;
}
export interface MentionNotification {
  id:string;
  kind:'chat'|'channel';
  chat_kind:'direct'|'group'|null;
  source_id:string;
  source_name:string;
  team_id:string|null;
  sender_name:string;
  created_at:string;
  read_at:string|null;
}
export interface PrivateAttachment {
  id:string; name:string; size:number; content_type:string;
  created_at:string; uploaded_by:Pick<Person,'id'|'full_name'|'email'>;
}
export interface WorkspaceFile {
  id:string; name:string; size:number; content_type:string;
  created_at:string; uploaded_by:Pick<Person,'id'|'full_name'|'email'>;
}
export interface Message { id: string; body: string; created_at: string; edited_at: string|null; deleted_at: string|null; sender: Person; reply_to_id?: string|null; is_forwarded?: boolean; pinned_at?: string|null }
export type ForwardDestination = {kind:'chat'|'channel';id:string;label:string};
export type ForwardResult = {kind:'chat'|'channel';destination_id:string;message:Message|ChatMessage};
export interface ChannelMessageCursor { before:string; before_id:string }
export interface ChannelMessagePage { items:Message[]; has_more:boolean; next_cursor:ChannelMessageCursor|null }
export interface ChatThread {
  is_muted?:boolean;is_pinned?:boolean;
  archived_at?: string|null;
  id: string; kind: 'direct'|'group'; title: string;
  created_at: string; updated_at: string; created_by: Person; unread_count: number;
  participants: Array<{user: Person; joined_at: string; last_read_at: string|null}>;
}
export interface ReactionSummary {emoji:string; count:number; user_ids:string[]}
export type ChatMessage = Message & { edited_at: string|null; deleted_at: string|null; reactions:ReactionSummary[] };
export interface ChatMessagePage { items:ChatMessage[]; has_more:boolean; next_cursor:ChannelMessageCursor|null }
export type SearchScope = 'all'|'chats'|'channels';
export interface MessageSearchResult {
  id:string;
  source:'chat'|'channel';
  source_id:string;
  source_name:string;
  chat_kind:'direct'|'group'|null;
  team_id:string|null;
  team_name?:string;
  sender_name:string;
  created_at:string;
  excerpt:string;
}
export interface MessageSearchResponse {results:MessageSearchResult[];limit:number;has_more?:boolean;next_cursor?:string|null}
export interface MessageSearchFilters {sender?:string;start?:string;end?:string;cursor?:string}


export interface Member { id: string; role: string; joined_at: string; user: Person }
export interface InvitePreview { email: string; organization_name: string; role: string }

let csrfToken = '';
export class ApiError extends Error {
  constructor(public status: number, public payload: unknown, message: string) {
    super(message);
  }
}
export async function csrf(): Promise<void> {
  const response = await fetch('/api/auth/csrf/', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not initialize browser security');
  csrfToken = (await response.json() as { csrf_token: string }).csrf_token;
}
async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  if (method !== 'GET' && !csrfToken) await csrf();
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-CSRFToken': csrfToken }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let payload: any;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail :
      typeof payload === 'object' ? Object.entries(payload).map(([key,val]) => `${key}: ${String(val)}`).join(', ') : 'Request failed';
    throw new ApiError(response.status, payload, detail || `Request failed (${response.status})`);
  }
  return payload as T;
}
const post = <T,>(path: string, body: unknown) => request<T>(path, 'POST', body);
async function secureLogin(path: string, body: unknown) {
  const session = await post<Session>(path, body);
  await csrf(); // Django rotates CSRF secret after login.
  return session;
}
async function uploadPrivateFile(path:string,file:File): Promise<PrivateAttachment> {
  if(!csrfToken)await csrf();
  const body=new FormData();
  body.append('file',file);
  const response=await fetch(`/api/${path}`,{
    method:'POST',credentials:'same-origin',
    headers:{'X-CSRFToken':csrfToken},body,
  });
  if(!response.ok){
    const details=await response.json().catch(()=>null);
    const message=typeof details?.file==='string'?details.file:
      Array.isArray(details?.file)?details.file.join(', '):'Could not upload attachment';
    throw new Error(message);
  }
  return response.json() as Promise<PrivateAttachment>;
}

async function downloadPrivateFile(row:PrivateAttachment): Promise<void> {
  const response=await fetch(`/api/attachments/${encodeURIComponent(row.id)}/download/`,{
    credentials:'same-origin',cache:'no-store',
  });
  if(!response.ok)throw new Error('File unavailable or access denied');
  const blob=await response.blob();
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=row.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function downloadWorkspaceFile(row:WorkspaceFile): Promise<void> {
  const response=await fetch(`/api/files/${encodeURIComponent(row.id)}/download/`,{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error('File unavailable or access denied');
  const blob=await response.blob();
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download=row.name;
  document.body.appendChild(link);link.click();link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export const api = {
  chatPreferences: (id:string,values:Partial<ConversationPreferences>) => post<ConversationPreferences>(`chats/${id}/preferences/`,values),
  channelPreferences: (id:string,values:Partial<ConversationPreferences>) => post<ConversationPreferences>(`channels/${id}/preferences/`,values),
  messageContext: (kind:'chat'|'channel',id:string,messageId:string) => request<{items:Message[]}>(`${kind==='chat'?'chats':'channels'}/${id}/messages/${messageId}/context/`),
  workspacePresence: (id:string) => post<{workspace_id:string;members:Presence[]}>(`organizations/${id}/presence/`,{}),
  chatAttachments: (chatId:string) => request<PrivateAttachment[]>(`chats/${chatId}/attachments/`),
  channelAttachments: (channelId:string) => request<PrivateAttachment[]>(`channels/${channelId}/attachments/`),
  uploadChatAttachment: (chatId:string,file:File) => uploadPrivateFile(`chats/${chatId}/attachments/`,file),
  uploadChannelAttachment: (channelId:string,file:File) => uploadPrivateFile(`channels/${channelId}/attachments/`,file),
  downloadPrivateAttachment: (row:PrivateAttachment) => downloadPrivateFile(row),
  workspaceFiles: (query='',category:'all'|'images'|'documents'='all') => request<{results:WorkspaceFile[];limit:number}>(`files/?${new URLSearchParams({q:query,category}).toString()}`),
  uploadWorkspaceFile: (file:File) => uploadPrivateFile('files/',file) as Promise<WorkspaceFile>,
  downloadWorkspaceFile: (row:WorkspaceFile) => downloadWorkspaceFile(row),
  me: () => request<Session>('auth/me/'),
  register: (body: {email:string; password:string;full_name:string;organization_name:string}) => secureLogin('auth/register/', body),
  login: (email: string, password: string) => secureLogin('auth/login/', {email, password}),
  resendVerification: () => post<{detail:string}>('auth/verify-email/resend/', {}),
  verifyEmail: (token:string) => post<{detail:string}>('auth/verify-email/', {token}),
  requestPasswordReset: (email:string) => post<{detail:string}>('auth/password-reset/request/', {email}),
  confirmPasswordReset: (uid:string, token:string, password:string) =>
    post<{detail:string}>('auth/password-reset/confirm/', {uid,token,password}),
  activeSessions: () => request<AccountDeviceSession[]>('auth/sessions/'),
  signOutDevice: (id:string) => request<void>(`auth/sessions/${id}/`,'DELETE'),
  signOutOtherDevices: () => post<{detail:string}>('auth/sessions/sign-out-others/', {}),
  changePassword: (current_password:string,new_password:string) =>
    post<{detail:string}>('auth/password-change/',{current_password,new_password}),
  mentionNotifications: () => request<{results:MentionNotification[]}>('mentions/'),
  markMentionRead: (id:string) => post<{read_at:string}>(`mentions/${id}/read/`, {}),
  notificationPreferences: () => request<NotificationPreferences>('notification-preferences/'),
  saveNotificationPreferences: (values:Partial<NotificationPreferences>) =>
    request<NotificationPreferences>('notification-preferences/','PATCH',values),
  logout: async () => { await post('auth/logout/', {}); await csrf(); },
  activate: (id: string) => post<Session>(`organizations/${id}/activate/`, {}),
  members: (id:string) => request<Member[]>(`organizations/${id}/members/`),
  updateMemberRole: (orgId:string, memberId:string, role:'admin'|'member') => request<Member>(`organizations/${orgId}/members/${memberId}/`, 'PATCH', {role}),
  removeMember: (orgId:string, memberId:string) => request<void>(`organizations/${orgId}/members/${memberId}/`, 'DELETE'),
  invite: (id:string, email:string, role: string) => post<{detail:string; development_invite_url?:string}>(`organizations/${id}/invitations/`, {email,role}),
  previewInvite: (token:string) => request<InvitePreview>(`invitations/${encodeURIComponent(token)}/`),
  acceptInvite: (token:string, full_name:string, password:string) => secureLogin(`invitations/${encodeURIComponent(token)}/accept/`, {full_name, password}),
  searchMessages: (query:string,scope:SearchScope='all',filters?:MessageSearchFilters) => {
    const params=new URLSearchParams({q:query,scope});
    if(filters){params.set('page','1');for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);}
    return request<MessageSearchResponse>(`search/messages/?${params.toString()}`);
  },
  channelPins: (id:string) => request<{items:Message[];has_more:boolean}>(`channels/${id}/pins/`),
  chatPins: (id:string) => request<{items:ChatMessage[];has_more:boolean}>(`chats/${id}/pins/`),
  pinChannelMessage: (id:string,messageId:string,pinned:boolean) => post<Message>(`channels/${id}/messages/${messageId}/pin/`,{pinned}),
  pinChatMessage: (id:string,messageId:string,pinned:boolean) => post<ChatMessage>(`chats/${id}/messages/${messageId}/pin/`,{pinned}),
  forwardDestinations: () => request<ForwardDestination[]>('messages/forward/destinations/'),
  forwardMessage: (sourceKind:'chat'|'channel',sourceId:string,messageId:string,destination:ForwardDestination) => post<ForwardResult>('messages/forward/',{source_kind:sourceKind,source_id:sourceId,message_id:messageId,destination_kind:destination.kind,destination_id:destination.id}),
  archiveChat: (id:string,archived:boolean) => post<{archived_at:string|null}>(`chats/${id}/archive/`,{archived}),
  leaveTeam: (id:string) => post<void>(`teams/${id}/leave/`,{}),
  archiveTeam: (id:string,archived:boolean) => post<Team>(`teams/${id}/archive/`,{archived}),
  archiveChannel: (teamId:string,id:string,archived:boolean) => post<Channel>(`teams/${teamId}/channels/${id}/archive/`,{archived}),
  chats: () => request<ChatThread[]>('chats/'),
  startDirectChat: (email:string) => post<ChatThread>('chats/', {kind:'direct',email}),
  startGroupChat: (title:string,emails:string[]) => post<ChatThread>('chats/', {kind:'group',title,emails}),
  chatMessages: (id:string) => request<ChatMessage[]>(`chats/${id}/messages/`),
  chatMessagePage: (id:string, cursor?:ChannelMessageCursor) => {
    const query = new URLSearchParams({page:'1'});
    if(cursor) { query.set('before',cursor.before); query.set('before_id',cursor.before_id); }
    return request<ChatMessagePage>(`chats/${id}/messages/?${query.toString()}`);
  },
  sendChatMessage: (id:string, body:string, replyTo?:string|null) => post<ChatMessage>(`chats/${id}/messages/`,{body,...(replyTo?{reply_to_id:replyTo}:{})}),
  toggleChatReaction: (chatId:string,messageId:string,emoji:string) => post<ChatMessage>(`chats/${chatId}/messages/${messageId}/reactions/`,{emoji}),
  markChatRead: (id:string, messageId:string) => post<{last_read_at:string}>(`chats/${id}/read/`,{message_id:messageId}),
  editChatMessage: (chatId:string, messageId:string, body:string) => request<ChatMessage>(`chats/${chatId}/messages/${messageId}/`, 'PATCH', {body}),
  deleteChatMessage: (chatId:string, messageId:string) => request<void>(`chats/${chatId}/messages/${messageId}/`, 'DELETE'),
  addGroupParticipant: (chatId:string,email:string) => post<ChatThread>(`chats/${chatId}/participants/`,{email}),
  transferGroupOwnership: (chatId:string,userId:string) => post<void>(`chats/${chatId}/ownership/`,{user_id:userId}),
  leaveGroup: (chatId:string) => post<void>(`chats/${chatId}/leave/`,{}),
  removeGroupParticipant: (chatId:string,userId:string) => request<void>(`chats/${chatId}/participants/${userId}/`,'DELETE'),
  renameGroup: (chatId:string,title:string) => request<ChatThread>(`chats/${chatId}/`,'PATCH',{title}),
  renameTeam: (teamId:string,name:string) => request<Team>(`teams/${teamId}/`,'PATCH',{name}),
  renameChannel: (teamId:string,channelId:string,name:string) => request<Channel>(`teams/${teamId}/channels/${channelId}/`,'PATCH',{name}),
  transferTeamOwnership: (teamId:string,userId:string) => post<void>(`teams/${teamId}/ownership/`,{user_id:userId}),
  removeTeamMember: (teamId:string,userId:string) => request<void>(`teams/${teamId}/members/${userId}/`,'DELETE'),
  teams: () => request<Team[]>('teams/'),
  createTeam: (name:string) => post<Team>('teams/', {name}),
  channelNotifications: () => request<ChannelNotice[]>('channel-notifications/'),
  markChannelRead: (channelId:string, messageId:string) => post<{last_read_at:string}>(`channels/${channelId}/read/`, {message_id:messageId}),
  channels: (teamId:string) => request<Channel[]>(`teams/${teamId}/channels/`),
  createChannel: (teamId:string, name:string, isPrivate=false) => post<Channel>(`teams/${teamId}/channels/`, {name,is_private:isPrivate}),
  privateChannelMembers: (id:string) => request<Array<Pick<Person,'id'|'email'|'full_name'>>>(`channels/${id}/members/`),
  addPrivateChannelMember: (id:string,email:string) => post<{id:string}>(`channels/${id}/members/`,{email}),
  removePrivateChannelMember: (id:string,userId:string) => request<void>(`channels/${id}/members/${userId}/`,'DELETE'),
  teamMembers: (teamId:string) => request<Array<{user:Person;role:string}>>(`teams/${teamId}/members/`),
  addTeamMember: (teamId:string,email:string) => post(`teams/${teamId}/members/`,{email}),
  messages: (channelId:string) => request<Message[]>(`channels/${channelId}/messages/`),
  channelMessagePage: (channelId:string, cursor?:ChannelMessageCursor|null) => {
    const query = new URLSearchParams({page:'1'});
    if (cursor) {
      query.set('before',cursor.before);
      query.set('before_id',cursor.before_id);
    }
    return request<ChannelMessagePage>(`channels/${channelId}/messages/?${query.toString()}`);
  },
  sendMessage: (channelId:string,body:string,replyTo?:string|null) => post<Message>(`channels/${channelId}/messages/`,{body,...(replyTo?{reply_to_id:replyTo}:{})}),
  editChannelMessage: (channelId:string,messageId:string,body:string) => request<Message>(`channels/${channelId}/messages/${messageId}/`, 'PATCH', {body}),
  deleteChannelMessage: (channelId:string,messageId:string) => request<void>(`channels/${channelId}/messages/${messageId}/`, 'DELETE'),
};


export interface MeetingActionItem {id:string;title:string;assignee_id:string|null;due_date:string|null;done:boolean}
export interface MeetingRecord {
  id:string;title:string;agenda:string;starts_at:string;ends_at:string;time_zone:string;meeting_url:string;
  notes:string;call_ended:boolean;cancelled:boolean;revision:number;organizer:Pick<Person,'id'|'full_name'|'email'>;
  channel:{id:string;name:string;team_id:string;team_name:string}|null;
  my_response:'pending'|'accepted'|'tentative'|'declined';
  attendees:Array<{user:Pick<Person,'id'|'full_name'|'email'>;response:MeetingRecord['my_response']}>;
  action_items:MeetingActionItem[];
}
export interface MeetingPayload {
  title:string;agenda:string;starts_at:string;ends_at:string;time_zone:string;
  attendee_ids:string[];channel_id:string|null;invite_channel:boolean;notes?:string;revision?:number;
}
export interface MeetingNotice {id:string;title:string;starts_at:string;kind:string}
export const meetingsApi = {
  list:(from:string,to:string,channelId?:string)=>request<{results:MeetingRecord[];limit:number}>(`meetings/?${new URLSearchParams({from,to,...(channelId?{channel_id:channelId}:{})})}`),
  detail:(id:string)=>request<MeetingRecord>(`meetings/${id}/`),
  create:(data:MeetingPayload)=>post<MeetingRecord>('meetings/',data),
  update:(id:string,data:MeetingPayload)=>request<MeetingRecord>(`meetings/${id}/`,'PATCH',data),
  remove:(id:string,revision:number)=>request<{status:string}>(`meetings/${id}/`,'DELETE',{revision}),
  cancel:(id:string,revision:number)=>post<MeetingRecord>(`meetings/${id}/cancel/`,{revision}),
  rsvp:(id:string,response:string)=>post<MeetingRecord>(`meetings/${id}/rsvp/`,{response}),
  notifications:()=>request<{results:MeetingNotice[]}>('meetings/notifications/'),
  read:(id:string)=>post<{status:string}>(`meetings/${id}/read/`,{}),
  addAction:(id:string,data:{title:string;assignee_id:string|null;due_date:string|null})=>post<MeetingRecord>(`meetings/${id}/actions/`,data),
  completeAction:(id:string,item:string,done:boolean)=>request<MeetingRecord>(`meetings/${id}/actions/${item}/`,'PATCH',{done}),
};

export interface CallConfig {rtc:RTCConfiguration;websocket_path:string;max_peers:number|null;relay_configured:boolean;translation_enabled:boolean}
export const callsApi = {
  translate:(id:string,data:{text:string;source:string;target:string})=>post<{text:string}>(`meetings/${id}/call/translate/`,data),
  config:(id:string)=>request<CallConfig>(`meetings/${id}/call/`),
  end:(id:string)=>post<{status:string}>(`meetings/${id}/call/end/`,{}),
};
