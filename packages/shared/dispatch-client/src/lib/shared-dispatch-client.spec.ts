import { sharedDispatchClient } from './shared-dispatch-client';

describe('sharedDispatchClient', () => {
  it('should work', () => {
    expect(sharedDispatchClient()).toEqual('shared-dispatch-client');
  });
});
