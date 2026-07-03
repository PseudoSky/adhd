import { rangeToRegex } from './regex';

describe('regex', () => {
  it('should produce range validation regexes', () => {
    expect(rangeToRegex(1, 90)).toEqual(/^([1-9]|[1-8][0-9]|90)$/);
    expect(rangeToRegex(undefined, 90)).toEqual(/^(([0-9]|[1-8][0-9]|90)|(-[0-9]+))$/);
    expect(rangeToRegex(90, undefined)).toEqual(/^((9[0-9]|[1-8][0-9]{2}|900)[0-9]*)$/);
    expect(rangeToRegex(-90, undefined)).toEqual(/^((-[1-9]|-[1-8][0-9]|-90|0)|([0-9]+))$/);
  });
});

/* rangeToRegex(1, 90)
 * /^([1-9]|[1-8][0-9]|90)$/
 *
 * rangeToRegex(null, 90)
 * /^(([0-9]|[1-8][0-9]|90)|(-[0-9]+))$/
 *
 * rangeToRegex(90, null)
 * /^((9[0-9]|[1-8][0-9]{2}|900)[0-9]*)$/
 *
 * rangeToRegex(-90, null)
 * /^((-[1-9]|-[1-8][0-9]|-90|0)|([0-9]+))$/
 */
