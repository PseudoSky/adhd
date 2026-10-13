/**
 * Ticket 8468f7b1 - adhdDataDir: `<ADHD_HOME>/<segments>` with ADHD_HOME
 * taken from the `env` PARAMETER, else `<home>/.adhd`; pure (it never
 * reads process.env, never touches the file system).
 * Criteria: [tripwire-core.30] TW37.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adhdDataDir } from '../../index';

describe('[tripwire-core.30] TW37 adhdDataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adhdDataDir(['reverse','data'], { ADHD_HOME: '/x' }) is /x/reverse/data",
    () => {
      expect(adhdDataDir(['reverse', 'data'], { ADHD_HOME: '/x' }))
        .toBe('/x/reverse/data');
    });

  it('falls back to <home>/.adhd/<segments> with no ADHD_HOME', () => {
    expect(adhdDataDir(['reverse', 'data'], {}, '/home/u'))
      .toBe('/home/u/.adhd/reverse/data');
    expect(adhdDataDir(['reverse', 'data'], { OTHER: '/y' }, '/home/u'))
      .toBe('/home/u/.adhd/reverse/data');
    // a blank ADHD_HOME is treated as unset
    expect(adhdDataDir(['a'], { ADHD_HOME: '  ' }, '/h')).toBe('/h/.adhd/a');
    expect(adhdDataDir(['a'], { ADHD_HOME: undefined }, '/h'))
      .toBe('/h/.adhd/a');
  });

  it('defaults home to the OS home directory', () => {
    expect(adhdDataDir(['reverse', 'data']))
      .toBe(join(homedir(), '.adhd', 'reverse', 'data'));
  });

  it('is pure: the process ADHD_HOME is never read', () => {
    vi.stubEnv('ADHD_HOME', '/evil');
    expect(adhdDataDir(['a'], {}, '/h')).toBe('/h/.adhd/a');
    expect(adhdDataDir(['a'], { ADHD_HOME: '/x' }, '/h')).toBe('/x/a');
    expect(adhdDataDir(['a'])).toBe(join(homedir(), '.adhd', 'a'));
  });

  it('is deterministic and does not mutate its inputs', () => {
    const segs = Object.freeze(['reverse', 'data']);
    const env = Object.freeze({ ADHD_HOME: '/x' });
    const first = adhdDataDir(segs, env, '/h');
    expect(adhdDataDir(segs, env, '/h')).toBe(first);
    expect(segs).toEqual(['reverse', 'data']);
    expect(env).toEqual({ ADHD_HOME: '/x' });
    expect(adhdDataDir([], { ADHD_HOME: '/x' })).toBe('/x');
  });
});
