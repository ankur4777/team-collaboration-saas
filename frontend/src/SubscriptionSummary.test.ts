import {describe,it,expect} from 'vitest';
import {countdownLabel,initialSeconds} from './SubscriptionSummary';
describe('subscription countdown',()=>{
  it('shows days and switches to hours and minutes below a day',()=>{
    expect(countdownLabel(2*86400+3600)).toBe('2d 1h remaining');
    expect(countdownLabel(23*3600+30*60)).toBe('23h 30m remaining');
    expect(countdownLabel(35)).toBe('Less than 1 minute remaining');
    expect(countdownLabel(-1)).toBe('0 minutes remaining');
  });
  it('uses the server time instead of the device clock',()=>{
    expect(initialSeconds({server_now:'2026-11-25T23:00:00Z',expires_at:'2026-11-26T00:00:00Z'})).toBe(3600);
    expect(initialSeconds({server_now:'2026-11-27T00:00:00Z',expires_at:'2026-11-26T00:00:00Z'})).toBe(0);
    expect(initialSeconds({expires_at:null})).toBeNull();
  });
});
