import type {Session} from './api';

// Provider access is based on the server-confirmed role, never tenant membership.
export function isPlatformPath(path:string){
  return path.replace(/\/+$/,'')==='/platform-admin';
}
export function showPlatformAdmin(path:string,session:Session|null|undefined){
  return isPlatformPath(path)||session?.user.is_platform_admin===true;
}
