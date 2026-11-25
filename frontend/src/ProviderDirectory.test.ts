import {describe,it,expect} from 'vitest';
import {csvCell} from './ProviderDirectory';
describe('directory CSV safety',()=>{
  it('quotes delimiters and neutralizes spreadsheet formulas',()=>{
    expect(csvCell('Example, Inc.')).toBe('"Example, Inc."');
    expect(csvCell('A "quoted" name')).toBe('"A ""quoted"" name"');
    expect(csvCell('=1+1')).toBe('"\'=1+1"');
    expect(csvCell('  +123')).toBe('"\'  +123"');
  });
});
