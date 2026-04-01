import request from 'async-request';
import https from 'https';
import { CookieJar } from 'tough-cookie';
import { url } from '../validators/index.js';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  json?: boolean;
  referer?: string;
};

export class BrowserClient {
  private jar = new CookieJar();
  private lastUrl?: string;

  private agent = new https.Agent({
    keepAlive: true,
  });

  private defaultHeaders(url: string): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      ...(this.lastUrl ? { Referer: this.lastUrl } : {}),
    };
  }

  async fetch(url: string, options: RequestOptions = {}) {
    const method = options.method || 'GET';

    const headers = {
      ...this.defaultHeaders(url),
      ...(options.headers || {}),
      ...(options.referer ? { Referer: options.referer } : {}),
    };

    const res = await request(url, {
      method,
      headers,
      data: options.body,
      // json: options.json,
      jar: this.jar,
      agent: this.agent,
      followRedirect: true,
      maxRedirects: 10,
    });

    this.lastUrl = url;

    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body,
    };
  }

  async get(url: string) {
    return this.fetch(url);
  }

  async post(url: string, body: any) {
    return this.fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  getCookies(url: string) {
    return new Promise<string[]>((resolve, reject) => {
      this.jar.getCookies(url, (err, cookies) => {
        if (err) return reject(err);
        resolve(cookies.map(c => c.cookieString()));
      });
    });
  }
}

const client = new BrowserClient();

export const extractSite = async (_url) => {
  // console.log({_url})
  // if (_url.startsWith('//')){
  //   url=`https:${_url}`
  // }
  const assetUrl = url.ensure(_url);
  console.log('extractSite', assetUrl);
  let res = null;
  try {
    res = await client.fetch(assetUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;',
        'Accept-Language': 'en-US,en;q=0.9',
        'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) ` +
          `AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/80.0.3987.163 Safari/537.36`,
      },
    });
    return { path: assetUrl, data: res.body };
  } catch (e) {
    console.error(e);
  }
  return null;
};

export default extractSite;
