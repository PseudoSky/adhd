const request = require('async-request');
import {url} from '../validators';
export const extractSite = async (_url) => {
  // console.log({_url})
  // if (_url.startsWith('//')){
  //   url=`https:${_url}`
  // }
  const assetUrl = url.ensure(_url);
  console.log('extractSite', assetUrl);
  let res = null;
  try {
    res = await request(assetUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;',
        'Accept-Language': 'en-US,en;q=0.9',
        'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) ` +
                      `AppleWebKit/537.36 (KHTML, like Gecko) `+
                      `Chrome/80.0.3987.163 Safari/537.36`,
      },
    });
    return {path: assetUrl, data: res.body};
  } catch (e) {
    console.error(e);
  }
  return null;
};

export default extractSite;
