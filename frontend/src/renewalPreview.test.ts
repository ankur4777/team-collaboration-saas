import {describe,expect,it} from 'vitest';
import {renewalPreview} from './renewalPreview';
import type {PlatformCompany} from './api';
const base:Pick<PlatformCompany,'server_now'|'subscription_timezone'|'starts_on'|'ends_on'|'status'>={server_now:'2026-11-28T20:00:00Z',subscription_timezone:'Asia/Kolkata',starts_on:'2026-11-01',ends_on:'2026-12-01',status:'active'};
describe('renewal preview',()=>{
  it('extends an existing term by exactly the requested days',()=>expect(renewalPreview(base,30,false)).toEqual({start:'2026-11-01',end:'2026-12-31',status:'active'}));
  it('starts an expired term on the server local date, inclusively',()=>expect(renewalPreview({...base,ends_on:'2026-11-28'},1,false)).toEqual({start:'2026-11-29',end:'2026-11-29',status:'active'}));
  it('retains restrictions unless reactivated',()=>{
    expect(renewalPreview({...base,status:'suspended'},30,false)?.status).toBe('suspended');
    expect(renewalPreview({...base,status:'suspended'},30,true)?.status).toBe('active');
  });
  it('keeps future starts and rejects invalid durations',()=>{
    expect(renewalPreview({...base,starts_on:'2026-12-10',ends_on:null},1,false)).toEqual({start:'2026-12-10',end:'2026-12-10',status:'scheduled'});
    expect(renewalPreview(base,0,false)).toBeNull();
  });
});
