import {describe,expect,it} from 'vitest';
import {retainSelection} from './explicitSelection';
describe('Explicit team and channel selection',()=>{
  const rows=[{id:'general'},{id:'sales'}];
  it('does not auto-select on initial load or unread refresh',()=>{
    expect(retainSelection(null,rows)).toBeNull();
    expect(retainSelection(null,[{id:'new'},...rows])).toBeNull();
  });
  it('preserves an explicitly selected channel including notification/search navigation',()=>{
    expect(retainSelection('sales',rows)).toBe('sales');
    expect(retainSelection('sales',[...rows].reverse())).toBe('sales');
  });
  it('clears removed or inaccessible selections without opening another channel',()=>{
    expect(retainSelection('sales',[rows[0]])).toBeNull();
    expect(retainSelection('sales',[])).toBeNull();
  });
});
