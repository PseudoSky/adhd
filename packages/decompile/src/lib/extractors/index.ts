import Stack from '../pipeline/stack.js';
import Store from '../store/index.js';
import extractLocal from './local-file.js';
import { extractMapLink, extractSource } from './map.js';
import { extractRawHtml, isHtml } from './raw-html.js';
import extractSite from './site.js';
export const extract = async (callStack) => {
  if (callStack.data.length === 0) return;
  const [type, input] = callStack.pop();
  try {
    if (!!Stack && input) {
      let r;
      if (type === 'site') {
        /*
         * desc: url of website to crawl
         * input: str
         */
        try {
          const res = await extractSite(input);
          if (res.path.endsWith('.js')) {
            callStack.push('link', res);
          } else if (res.path.endsWith('.map')) {
            callStack.push('map', res);
          } else {
            callStack.push('raw', res);
          }
        } catch (e) {
          console.error('extract site error:', Stack, e);
        }
      } else if (type === 'local') {
        /*
         * desc: file or dir path of local source files
         * input: str
         */
        r = extractLocal(input);

        r.forEach((f) => {
          if (f.path.endsWith('.html')) {
            callStack.push('raw', f);
          } else if (f.path.endsWith('.map')) {
            callStack.push('map', f);
          } else {
            callStack.push('source', f);
          }
        });
      } else if (type === 'raw') {
        /*
         * desc: raw html from website to extract links
         * input: str
         */

        r = extractRawHtml(input);
        r.reduce((r, a) => r.concat(a), []).forEach((l) => {
          callStack.push('link', l);
        });
      } else if (type === 'link') {
        /*
         * all requested js, css, etc should start here
         * desc: url of the extracted source
         * input: str
         */
        try {
          r = await extractSite(input);
          if (input.endsWith('.map')) {
            callStack.push('map', r);
          } else {
            callStack.push('source', r);
          }
        } catch (e) {
          console.error('Failed to extract site:', e);
        }
      } else if (type === 'source') {
        /*
         * desc: raw text from the requested link
         * input: <str>
         */
        r = extractMapLink(input);
        if (r && r.length) {
          r.forEach((l) => callStack.push('link', l));
        } else {
          callStack.push('write', [{ name: input.path, data: input.data }]);
        }
      } else if (type === 'map') {
        /*
         * desc: raw source map
         * input: json
         */
        try {
          r = await extractSource(input.data);
          callStack.push('write', r);
        } catch (e) {
          console.error('Failed to extract source map:', e);
        }
      } else if (type === 'write') {
        /*
         * desc=source and map files to write
         * input=[{"name": str, "data": json}]
         */

        input.filter((e) => !!e).forEach((f) => {
          Store.addToImports(f.name);
          Store.addFile(f.name, f.data);
          // fs.writeJSONSync(f.name, f.data)
        });
      }
    }
  } catch (e) {
    console.error('Extract error:', e);
  }
};

const run = async (callStack, debug = true) => {
  while (callStack.hasMore()) {
    await extract(callStack);
    if (callStack.isComplete()) {
      break;
    }
  }
  await Store.finalize();
};

export const testpipeline = (files, prefix) => {
  return Promise.all(
    files.map((f) => pipeline(f, prefix)),
  ).then((r) => r);
};

import { constants } from "fs";
import { access } from "fs/promises";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}


/* EXAMPLE:
 *
 * pipeline('./maps/bitbucket/app.f606c0f20e8744e93489.js.map',
 *  './build/test','map').then(() => console.log('complete'))
 */
export const pipeline = async (input, prefix = './build/src', debug = true) => {
  const callStack = new Stack();
  Store.setPrefix(prefix);
  // pkg="test"
  // Store.package=pkg
  if (typeof (input) === 'string' && input.startsWith('http')) {
    if (input.endsWith('js')) {
      callStack.push('link', input);
    } else {
      callStack.push('site', input);
    }
  } else if (await fileExists(input)) {
    callStack.push('local', input);
  } else if (isHtml(input)) {
    callStack.push('raw', input);
  } else {
    console.error('Input not found or recognized:', input);
  }
  await run(callStack, debug);
  return Store.finalize();
};

const Extractors = {
  testpipeline,
  pipeline,
  extract,
};

export default Extractors;

