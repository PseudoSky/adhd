import { apigenRuntime } from '../../../src/lib/apigen-runtime';

describe('apigenRuntime', () => {
  it('should work', () => {
    expect(apigenRuntime()).toEqual('apigen-runtime');
  });
});
