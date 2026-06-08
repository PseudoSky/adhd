import { Transform } from '@adhd/transform';
import Stack from '../pipeline/stack.js';
import Store from '../store/index.js';
import extractLocal from './local-file.js';
import { extractMapLink, extractSource } from './map.js';
import { extractRawHtml, isHtml } from './raw-html.js';
import extractSite from './site.js';


export const extract = async (callStack: Stack) => {
  const item = callStack.pop();
  if (!callStack.hasMore() || item === null) return;

  const [type, input] = item;
  if (input === null) return;
  console.log(`Extract[${type}]`, { input: input.path && input.path?.includes('.js') ? input : input.path });
  try {
    if (!!callStack && input) {
      let r;
      if (type === 'site') {
        /*
         * desc: url of website to crawl
         * input: str
         */
        try {
          const res = await extractSite(input.path);
          console.log({ site: res })
          if (res) {

            if (res.path.endsWith('.js')) {
              callStack.push('link', res);
            } if (res.path.endsWith('.map')) {
              callStack.push('map', { path: res.path, data: "", mapping: res.data });
            } else {
              callStack.push('raw', res);
            }
          }
        } catch (e) {
          console.error('extract site error:', Stack, e);
        }
      } else if (type === 'local') {
        /*
         * desc: file or dir path of local source files
         * input: str
         */
        r = extractLocal(input.path);
        if (r?.path.endsWith('.html')) {
          callStack.push('raw', r);
        } else if (r?.path.endsWith('.map')) {
          callStack.push('map', { path: r.path, data: "", mapping: r.data as unknown as RawSourceMap });
        } else if (r) {
          callStack.push('source', r);
        }
      } else if (type === 'raw') {
        /*
         * desc: raw html from website to extract links
         * input: str
         */

        r = extractRawHtml(input);
        console.log({ links: r });
        r.forEach((l) => {
          callStack.push('link', { path: l, data: "" });
        });
      } else if (type === 'link') {
        /*
         * all requested js, css, etc should start here
         * desc: url of the extracted source
         * input: str
         */
        try {
          r = await extractSite(input.path);
          if (r) {
            // console.log({ res: r })
            if (input.path.endsWith('.map')) {
              callStack.push('map', { path: r.path, data: "", mapping: r.data });
            } else {
              callStack.push('source', r);
            }
          }
        } catch (e) {
          console.error(e);
        }
      } else if (type === 'source' && Transform.isString(input)) {
        /*
         * desc: raw text from the requested link
         * input: <str>
         */
        r = extractMapLink(input);
        if (r && r.length) {
          console.log('EXTRACT[source] map link', r);
          r.forEach((l) => callStack.push('link', { path: l, data: "" }));
        } else {
          callStack.push('write', { path: input.path, data: input.data });
        }
      } else if (type === 'map' && !Transform.isString(input)) {
        /*
         * desc: raw source map
         * input: json
         */
        try {
          if (!input.mapping) throw Error("Mapping missing");
          r = await extractSource(input.mapping).then((res) => {
            res?.forEach(src => {

              callStack.push('write', src);
            })
          });
          // console.log({ map: r })
        } catch (e) {
          console.error(e);
        }
      } else if (type === 'write') {
        /*
         * desc=source and map files to write
         * input=[{"name": str, "data": json}]
         */
        Store.addToImports(input.path);
        Store.addFile(input.path, input.data);
        // if(Transform.isArray(input)){



        // fs.writeJSONSync(f.name, f.data)
        // });
        // }
      }
    }
  } catch (e) {
    console.error('EXTRACT[catchall]', e);
  }
};

const run = async (callStack: Stack) => {
  while (callStack.hasMore()) {
    await extract(callStack);
    if (callStack.isEmpty()) {
      break;
    }
  }
  await Store.finalize();
};

export const testpipeline = (files: string[], prefix: string) => {
  console.log({ files, prefix })
  return Promise.all(
    files.map((f) => {
      console.log(`pipeline started: ${f}`);
      return pipeline(f, prefix);
    }),
  ).then((r) => {
    console.log('complete');
    return r
    // console.log('finalizing package.json + index.js');
    // return Store.finalize()
  })
  // .then(() => {
  // });
  // return argz
};

import { constants } from "fs";
import { access } from "fs/promises";
import { RawSourceMap } from 'source-map';

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
export const pipeline = async (input: string, prefix = './build/src') => {
  const callStack = new Stack();
  Store.setPrefix(prefix);
  // pkg="test"
  // Store.package=pkg
  if (typeof (input) === 'string' && input.startsWith('http')) {
    if (input.endsWith('js')) {
      callStack.push('link', { path: input, data: "" });
    } else {
      callStack.push('site', { path: input, data: "" });
    }
  } else if (await fileExists(input)) {
    callStack.push('local', { path: input, data: "" });
  } else if (isHtml(input)) {
    callStack.push('raw', { path: input, data: "" });
  } else {
    console.log('couldnt find ' + input);
  }
  await run(callStack);
  return Store.finalize();
};

const Extractors = {
  testpipeline,
  pipeline,
  extract,
};

export default Extractors;

