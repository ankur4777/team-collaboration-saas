import {describe,it,expect} from 'vitest';
import {showPlatformAdmin} from './adminRouting';
import type {Session} from './api';
const session=(admin:boolean,org:string|null):Session=>({user:{id:'user',email:'user@example.test',full_name:'Test',email_verified:true,is_platform_admin:admin},organizations:[],active_organization_id:org});
describe('provider admin routing',()=>{
  it('routes superadmins to the provider console even with an active workspace',()=>{
    expect(showPlatformAdmin('/',session(true,'company'))).toBe(true);
    expect(showPlatformAdmin('/',session(true,null))).toBe(true);
  });
  it('keeps regular employees on their normal workspace route',()=>{
    expect(showPlatformAdmin('/',session(false,'company'))).toBe(false);
    expect(showPlatformAdmin('/',null)).toBe(false);
  });
  it('renders the restricted provider login on the explicit path with or without a trailing slash',()=>{
    expect(showPlatformAdmin('/platform-admin',null)).toBe(true);
    expect(showPlatformAdmin('/platform-admin/',null)).toBe(true);
    expect(showPlatformAdmin('/platform-admin/',session(false,'company'))).toBe(true);
  });
});
