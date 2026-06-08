// import test from 'ava';
// import { describe } from 'node:test';
import { defaultOptions, isValidUrl, normalizeUrl } from '.';
// function expectThrowError(t, f, error) {
//   const e = expectEqual(expect, f);
//   expectEqual(expect, e.message, error);
// }
function expectEqual(test: jest.Expect, actual: Parameters<jest.Expect>[0], expected?: Parameters<jest.Expect>[0]) {
  test(actual).toEqual(expected);
}
const scheme = defaultOptions.defaultProtocol;
describe('url', () => {
  it('isUrl', () => {
    expectEqual(expect, isValidUrl('HTTP://sindresorhus.com'), true);
    expectEqual(expect, isValidUrl('ftp://sindresorhus.com:21'), true);
    expectEqual(expect, isValidUrl('http://www.sindresorhus.com'), true);
    expectEqual(expect, isValidUrl('https://user:password@www.sindresorhus.com/@user'), true);
    expectEqual(expect, isValidUrl('www.sindresorhus.com?foo=bar&utm_medium=test&ref=test_ref'), false);
    expectEqual(expect, isValidUrl('http://www.sindresorhus.com?foo=bar&utm_medium=test&ref=test_ref'), true);

    expectEqual(expect, isValidUrl('sindresorhus.com.'), false);
    expectEqual(expect, isValidUrl('[www].com'), false);
    expectEqual(expect, isValidUrl('.'), false);
    expectEqual(expect, isValidUrl('./'), false);
    // expectEqual(expect, normalizeUrl('.', {returns:'url'}),'asdf')
    // expectEqual(expect, normalizeUrl('./',{returns:'url'}),'asdf')
    expectEqual(expect, isValidUrl('./index.js'), false);
    expectEqual(expect, isValidUrl('/'), false);
    expectEqual(expect, isValidUrl('/index.js'), false);
    expectEqual(expect, isValidUrl('<root>\\--'), false);
  });

  it('main', () => {

    expectEqual(expect, normalizeUrl('sindresorhus.com'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('sindresorhus.com '), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('sindresorhus.com.'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('SindreSorhus.com'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('sindresorhus.com', { defaultProtocol: 'https:' }), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('HTTP://sindresorhus.com'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('//sindresorhus.com'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('http://sindresorhus.com'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com:80'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://sindresorhus.com:443'), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('ftp://sindresorhus.com:21'), 'ftp://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://www.sindresorhus.com'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('www.com'), `${scheme}//www.com`);
    expectEqual(expect, normalizeUrl('http://www.www.sindresorhus.com'), 'http://www.www.sindresorhus.com');
    expectEqual(expect, normalizeUrl('www.sindresorhus.com'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo/'), 'http://sindresorhus.com/foo');
    expectEqual(expect, normalizeUrl('sindresorhus.com/?foo=bar baz'), `${scheme}//sindresorhus.com/?foo=bar+baz`);
    expectEqual(expect, normalizeUrl('https://foo.com/https://bar.com'), 'https://foo.com/https://bar.com');
    expectEqual(expect, normalizeUrl('https://foo.com/https://bar.com/foo//bar'), 'https://foo.com/https://bar.com/foo/bar');
    expectEqual(expect, normalizeUrl('https://foo.com/http://bar.com'), 'https://foo.com/http://bar.com');
    expectEqual(expect, normalizeUrl('https://foo.com/http://bar.com/foo//bar'), 'https://foo.com/http://bar.com/foo/bar');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/%7Efoo/'), 'http://sindresorhus.com/~foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('êxample.com'), `${scheme}//xn--xample-hva.com`);
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?b=bar&a=foo'), 'http://sindresorhus.com/?a=foo&b=bar');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?foo=bar*|<>:"'), 'http://sindresorhus.com/?foo=bar*%7C%3C%3E%3A%22');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com:5000'), 'http://sindresorhus.com:5000');
    expectEqual(expect, normalizeUrl('//sindresorhus.com/', { normalizeProtocol: false }), '//sindresorhus.com');
    expectEqual(expect, normalizeUrl('//sindresorhus.com:443/', { normalizeProtocol: false }), '//sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo#bar'), 'http://sindresorhus.com/foo#bar');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo#bar', { stripHash: true }), 'http://sindresorhus.com/foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo/bar/../baz'), 'http://sindresorhus.com/foo/baz');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo/bar/./baz'), 'http://sindresorhus.com/foo/bar/baz');
    expectEqual(expect, normalizeUrl('sindre://www.sorhus.com'), 'sindre://sorhus.com');
    expectEqual(expect, normalizeUrl('sindre://www.sorhus.com/'), 'sindre://sorhus.com');
    expectEqual(expect, normalizeUrl('sindre://www.sorhus.com/foo/bar'), 'sindre://sorhus.com/foo/bar');
    expectEqual(expect, normalizeUrl('https://i.vimeocdn.com/filter/overlay?src0=https://i.vimeocdn.com/video/598160082_1280x720.jpg&src1=https://f.vimeocdn.com/images_v6/share/play_icon_overlay.png'), 'https://i.vimeocdn.com/filter/overlay?src0=https%3A%2F%2Fi.vimeocdn.com%2Fvideo%2F598160082_1280x720.jpg&src1=https%3A%2F%2Ff.vimeocdn.com%2Fimages_v6%2Fshare%2Fplay_icon_overlay.png');
  });

  it('stripAuthentication option', () => {

    expectEqual(expect, normalizeUrl('http://user:password@www.sindresorhus.com'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://user:password@www.sindresorhus.com'), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://user:password@www.sindresorhus.com/@user'), 'https://sindresorhus.com/@user');
    expectEqual(expect, normalizeUrl('user:password@sindresorhus.com'), `${scheme}//sindresorhus.com`);
    expectEqual(expect, normalizeUrl('http://user:password@www.êxample.com'), 'http://xn--xample-hva.com');
    expectEqual(expect, normalizeUrl('sindre://user:password@www.sorhus.com'), 'sindre://sorhus.com');

    const options = { stripAuthentication: false };
    expectEqual(expect, normalizeUrl('http://user:password@www.sindresorhus.com', options), 'http://user:password@sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://user:password@www.sindresorhus.com', options), 'https://user:password@sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://user:password@www.sindresorhus.com/@user', options), 'https://user:password@sindresorhus.com/@user');
    expectEqual(expect, normalizeUrl('user:password@sindresorhus.com', options), `${scheme}//user:password@sindresorhus.com`);
    expectEqual(expect, normalizeUrl('http://user:password@www.êxample.com', options), 'http://user:password@xn--xample-hva.com');
    expectEqual(expect, normalizeUrl('sindre://user:password@www.sorhus.com', options), 'sindre://user:password@sorhus.com');
  });

  it('stripProtocol option', () => {

    const options = { stripProtocol: true };
    expectEqual(expect, normalizeUrl('http://www.sindresorhus.com', options), 'sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com', options), 'sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://www.sindresorhus.com', options), 'sindresorhus.com');
    expectEqual(expect, normalizeUrl('//www.sindresorhus.com', options), 'sindresorhus.com');
    expectEqual(expect, normalizeUrl('sindre://user:password@www.sorhus.com', options), 'sindre://sorhus.com');
    expectEqual(expect, normalizeUrl('sindre://www.sorhus.com', options), 'sindre://sorhus.com');
  });

  it('stripWWW option', () => {

    const options = { stripWWW: false };
    expectEqual(expect, normalizeUrl('http://www.sindresorhus.com', options), 'http://www.sindresorhus.com');
    expectEqual(expect, normalizeUrl('www.sindresorhus.com', options), `${scheme}//www.sindresorhus.com`);
    expectEqual(expect, normalizeUrl('http://www.êxample.com', options), 'http://www.xn--xample-hva.com');
    expectEqual(expect, normalizeUrl('sindre://www.sorhus.com', options), 'sindre://www.sorhus.com');
  });

  it('removeQueryParameters option', () => {

    const options = {
      stripWWW: false,
      removeQueryParameters: [/^utm_\w+/i, 'ref'],
    };
    expectEqual(expect, normalizeUrl('www.sindresorhus.com?foo=bar&utm_medium=test'), `${scheme}//sindresorhus.com/?foo=bar`);
    expectEqual(expect, normalizeUrl('http://www.sindresorhus.com', options), 'http://www.sindresorhus.com');
    expectEqual(expect, normalizeUrl('www.sindresorhus.com?foo=bar', options), `${scheme}//www.sindresorhus.com/?foo=bar`);
    expectEqual(expect, normalizeUrl('www.sindresorhus.com?foo=bar&utm_medium=test&ref=test_ref', options), `${scheme}//www.sindresorhus.com/?foo=bar`);
  });

  it('forceHttp option', () => {

    const options = { forceHttp: true };
    expectEqual(expect, normalizeUrl('https://sindresorhus.com'), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com', options), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://www.sindresorhus.com', options), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('//sindresorhus.com', options), 'http://sindresorhus.com');
  });

  it('forceHttp option with forceHttps', () => {

    const e = normalizeUrl('https://www.sindresorhus.com', { forceHttp: true, forceHttps: true });
    expectEqual(expect, e.message, 'The `forceHttp` and `forceHttps` options cannot be used together');
  });

  it('forceHttps option', () => {

    const options = { forceHttps: true };
    expectEqual(expect, normalizeUrl('https://sindresorhus.com'), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com', options), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('https://www.sindresorhus.com', options), 'https://sindresorhus.com');
    expectEqual(expect, normalizeUrl('//sindresorhus.com', options), 'https://sindresorhus.com');
  });

  it('removeTrailingSlash option', () => {

    const options = { removeTrailingSlash: false };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/'), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/', options), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/redirect/'), 'http://sindresorhus.com/redirect');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/redirect/', options), 'http://sindresorhus.com/redirect/');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/#/', options), 'http://sindresorhus.com/#/');
  });

  it('removeDirectoryIndex option', () => {

    const options1 = { removeDirectoryIndex: ['index.html', 'index.php'] };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html'), 'http://sindresorhus.com/index.html');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html', options1), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.htm', options1), 'http://sindresorhus.com/index.htm');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.php', options1), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.html'), 'http://sindresorhus.com/path/index.html');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.html', options1), 'http://sindresorhus.com/path');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.htm', options1), 'http://sindresorhus.com/path/index.htm');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.php', options1), 'http://sindresorhus.com/path');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo/bar/index.html', options1), 'http://sindresorhus.com/foo/bar');

    const options2 = { removeDirectoryIndex: [/^index\.[a-z]+$/, 'remove.html'] };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html'), 'http://sindresorhus.com/index.html');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html', options2), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index/index.html', options2), 'http://sindresorhus.com/index');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/remove.html', options2), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/defaulexpect', options2), 'http://sindresorhus.com/defaulexpect');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.php', options2), 'http://sindresorhus.com');

    const options3 = { removeDirectoryIndex: true };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html'), 'http://sindresorhus.com/index.html');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.html', options3), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.htm', options3), 'http://sindresorhus.com');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/index.php', options3), 'http://sindresorhus.com');
  });

  it('removeTrailingSlash and removeDirectoryIndex options)', () => {

    const options1 = {
      removeTrailingSlash: true,
      removeDirectoryIndex: true,
    };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/', options1), 'http://sindresorhus.com/path');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.html', options1), 'http://sindresorhus.com/path');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/#/path/', options1), 'http://sindresorhus.com/#/path/');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/foo/#/bar/', options1), 'http://sindresorhus.com/foo#/bar/');

    const options2 = {
      removeTrailingSlash: false,
      removeDirectoryIndex: true,
    };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/', options2), 'http://sindresorhus.com/path/');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/path/index.html', options2), 'http://sindresorhus.com/path/');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/#/path/', options2), 'http://sindresorhus.com/#/path/');
  });

  it('sortQueryParameters option', () => {

    const options1 = {
      sortQueryParameters: true,
    };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?a=Z&b=Y&c=X&d=W', options1), 'http://sindresorhus.com/?a=Z&b=Y&c=X&d=W');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?b=Y&c=X&a=Z&d=W', options1), 'http://sindresorhus.com/?a=Z&b=Y&c=X&d=W');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?a=Z&d=W&b=Y&c=X', options1), 'http://sindresorhus.com/?a=Z&b=Y&c=X&d=W');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/', options1), 'http://sindresorhus.com');

    const options2 = {
      sortQueryParameters: false,
    };
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?a=Z&b=Y&c=X&d=W', options2), 'http://sindresorhus.com/?a=Z&b=Y&c=X&d=W');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?b=Y&c=X&a=Z&d=W', options2), 'http://sindresorhus.com/?b=Y&c=X&a=Z&d=W');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/?a=Z&d=W&b=Y&c=X', options2), 'http://sindresorhus.com/?a=Z&d=W&b=Y&c=X');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com/', options2), 'http://sindresorhus.com');
  });

  it('invalid urls', () => {

    let e;
    e = normalizeUrl('http://');
    expectEqual(expect, e.message, 'Invalid URL: http://');

    e = normalizeUrl('/');
    expectEqual(expect, e.message, 'Invalid URL: /');

    e = normalizeUrl('/relative/path/');
    expectEqual(expect, e.message, 'Invalid URL: /relative/path/');
  });

  it('remove duplicate pathname slashes', () => {

    expectEqual(expect, normalizeUrl('http://sindresorhus.com////foo/bar'), 'http://sindresorhus.com/foo/bar');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com////foo////bar'), 'http://sindresorhus.com/foo/bar');
    expectEqual(expect, normalizeUrl('//sindresorhus.com//foo', { normalizeProtocol: false }), '//sindresorhus.com/foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com:5000///foo'), 'http://sindresorhus.com:5000/foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com///foo'), 'http://sindresorhus.com/foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com:5000//foo'), 'http://sindresorhus.com:5000/foo');
    expectEqual(expect, normalizeUrl('http://sindresorhus.com//foo'), 'http://sindresorhus.com/foo');
  });

  // it('deprecated options', () => {

  //   let e;
  //   e = expectEqual(expect, () => normalizeUrl('', {normalizeHttps: true}));
  //   expectEqual(expect, e.message, 'options.normalizeHttps is renamed to options.forceHttp');
  //   e = expectEqual(expect, () => normalizeUrl('', {normalizeHttp: true}));
  //   expectEqual(expect, e.message, 'options.normalizeHttp is renamed to options.forceHttps');
  //   e = expectEqual(expect, () => normalizeUrl('', {stripFragment: true}));
  //   expectEqual(expect, e.message, 'options.stripFragment is renamed to options.stripHash');
  // });

  it('data URL', () => {

    // Invalid URL.
    const e = normalizeUrl('data:');
    expectEqual(expect, e.message, 'Invalid URL: data:');

    // Strip default MIME type
    expectEqual(expect, normalizeUrl('data:text/plain,foo'), 'data:,foo');

    // Strip default charset
    expectEqual(expect, normalizeUrl('data:;charset=us-ascii,foo'), 'data:,foo');

    // Normalize away trailing semicolon.
    expectEqual(expect, normalizeUrl('data:;charset=UTF-8;,foo'), 'data:;charset=utf-8,foo');

    // Empty MIME type.
    expectEqual(expect, normalizeUrl('data:,'), 'data:,');

    // Empty MIME type with charseexpect(normalizeUrl('data:;charset=utf-8,foo'), 'data:;charset=utf-8,foo');

    // Lowercase the MIME type.
    expectEqual(expect, normalizeUrl('data:TEXT/HTML,foo'), 'data:text/html,foo');

    // Strip empty hash.
    expectEqual(expect, normalizeUrl('data:,foo# '), 'data:,foo');

    // Key only mediaType attribute.
    expectEqual(expect, normalizeUrl('data:;foo=;bar,'), 'data:;foo;bar,');

    // Lowercase the charseexpect(normalizeUrl('data:;charset=UTF-8,foo'), 'data:;charset=utf-8,foo');

    // Remove spaces after the comma when it's base64.
    expectEqual(expect, normalizeUrl('data:;base64, Zm9v #foo #bar'), 'data:;base64,Zm9v#foo #bar');

    // Keep spaces when it's not base64.
    expectEqual(expect, normalizeUrl('data:, foo #bar'), 'data:, foo #bar');

    // Options.
    const options = {
      defaultProtocol: 'http:',
      normalizeProtocol: true,
      forceHttp: true,
      stripHash: true,
      stripWWW: true,
      stripProtocol: true,
      removeQueryParameters: [/^utm_\w+/i, 'ref'],
      sortQueryParameters: true,
      removeTrailingSlash: true,
      removeDirectoryIndex: true,
    };
    expectEqual(expect, normalizeUrl('data:,sindresorhus.com/', options), 'data:,sindresorhus.com/');
    expectEqual(expect, normalizeUrl('data:,sindresorhus.com/index.html', options), 'data:,sindresorhus.com/index.html');
    expectEqual(expect, normalizeUrl('data:,sindresorhus.com?foo=bar&a=a&utm_medium=test', options), 'data:,sindresorhus.com?foo=bar&a=a&utm_medium=test');
    expectEqual(expect, normalizeUrl('data:,foo#bar', options), 'data:,foo');
    expectEqual(expect, normalizeUrl('data:,www.sindresorhus.com', options), 'data:,www.sindresorhus.com');
  });
})