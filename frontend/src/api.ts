export interface Person { id: string; email: string; full_name: string }
export interface Org { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member' }
export interface Session { user: Person; organizations: Org[]; active_organization_id: string | null }
export interface Team { id: string; name: string; description: string; created_at: string }
export interface Channel { id: string; name: string; description: string; created_at: string }
export interface ChannelNotice {
  channel_id: string; channel_name: string; team_id: string; team_name: string;
  joined_at: string; unread_count: number; last_read_at: string|null;
}
export interface Message { id: string; body: string; created_at: string; sender: Person }
export interface ChatThread {
  id: string; kind: 'direct'|'group'; title: string;
  created_at: string; updated_at: string; created_by: Person; unread_count: number;
  participants: Array<{user: Person; joined_at: string; last_read_at: string|null}>;
}
export type ChatMessage = Message & { edited_at: string|null; deleted_at: string|null };

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
export const api = {
  me: () => request<Session>('auth/me/'),
  register: (body: {email:string; password:string;full_name:string;organization_name:string}) => secureLogin('auth/register/', body),
  login: (email: string, password: string) => secureLogin('auth/login/', {email, password}),
  logout: async () => { await post('auth/logout/', {}); await csrf(); },
  activate: (id: string) => post<Session>(`organizations/${id}/activate/`, {}),
  members: (id:string) => request<Member[]>(`organizations/${id}/members/`),
  updateMemberRole: (orgId:string, memberId:string, role:'admin'|'member') => request<Member>(`organizations/${orgId}/members/${memberId}/`, 'PATCH', {role}),
  removeMember: (orgId:string, memberId:string) => request<void>(`organizations/${orgId}/members/${memberId}/`, 'DELETE'),
  invite: (id:string, email:string, role: string) => post<{detail:string; development_invite_url?:string}>(`organizations/${id}/invitations/`, {email,role}),
  previewInvite: (token:string) => request<InvitePreview>(`invitations/${encodeURIComponent(token)}/`),
  acceptInvite: (token:string, full_name:string, password:string) => secureLogin(`invitations/${encodeURIComponent(token)}/accept/`, {full_name, password}),
  chats: () => request<ChatThread[]>('chats/'),
  startDirectChat: (email:string) => post<ChatThread>('chats/', {kind:'direct',email}),
  startGroupChat: (title:string,emails:string[]) => post<ChatThread>('chats/', {kind:'group',title,emails}),
  chatMessages: (id:string) => request<ChatMessage[]>(`chats/${id}/messages/`),
  sendChatMessage: (id:string, body:string) => post<ChatMessage>(`chats/${id}/messages/`,{body}),
  markChatRead: (id:string, messageId:string) => post<{last_read_at:string}>(`chats/${id}/read/`,{message_id:messageId}),
  editChatMessage: (chatId:string, messageId:string, body:string) => request<ChatMessage>(`chats/${chatId}/messages/${messageId}/`, 'PATCH', {body}),
  deleteChatMessage: (chatId:string, messageId:string) => request<void>(`chats/${chatId}/messages/${messageId}/`, 'DELETE'),
  addGroupParticipant: (chatId:string,email:string) => post<ChatThread>(`chats/${chatId}/participants/`,{email}),
  removeGroupParticipant: (chatId:string,userId:string) => request<void>(`chats/${chatId}/participants/${userId}/`,'DELETE'),
  teams: () => request<Team[]>('teams/'),
  createTeam: (name:string) => post<Team>('teams/', {name}),
  channelNotifications: () => request<ChannelNotice[]>('channel-notifications/'),
  markChannelRead: (channelId:string, messageId:string) => post<{last_read_at:string}>(`channels/${channelId}/read/`, {message_id:messageId}),
  channels: (teamId:string) => request<Channel[]>(`teams/${teamId}/channels/`),
  createChannel: (teamId:string, name:string) => post<Channel>(`teams/${teamId}/channels/`, {name}),
  teamMembers: (teamId:string) => request<Array<{user:Person;role:string}>>(`teams/${teamId}/members/`),
  addTeamMember: (teamId:string,email:string) => post(`teams/${teamId}/members/`,{email}),
  messages: (channelId:string) => request<Message[]>(`channels/${channelId}/messages/`),
  sendMessage: (channelId:string,body:string) => post<Message>(`channels/${channelId}/messages/`,{body}),
};
