import { apigenCli } from '../../../src/lib/apigen-cli';

describe('apigenCli', () => {
  it('should work', () => {
    expect(apigenCli()).toEqual('apigen-cli');
  });
});
