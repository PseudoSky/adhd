import extractLocal from './local-file';
import extractSite from './site';
import Store from '../store';
import Stack from '../pipeline/stack';
import {extractSource, extractMapLink} from './map';
import {isHtml, extractRawHtml} from './raw-html';
import {ensurePathSync} from '../validators/local';
export const extract = async (callStack) => {
  if (callStack.data.length===0) return;
  const [type, input] = callStack.pop();
  console.log(`Extract[${type}]`);
  try {
    if (!!Stack && input) {
      let r;
      if (type==='site') {
        /*
         * desc: url of website to crawl
         * input: str
         */
        try {
          const res = await extractSite(input);
          // console.log({ site: res })
          if (res.path.endsWith('.js')) {
            callStack.push('link', res);
          } if (res.path.endsWith('.map')) {
            callStack.push('map', res);
          } else {
            callStack.push('raw', res);
          }
        } catch (e) {
          console.error('extract site error:', Stack, e);
        }
      } else if (type==='local') {
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
      } else if (type==='raw') {
        /*
         * desc: raw html from website to extract links
         * input: str
         */

        r = extractRawHtml(input);
        console.log({links: r});
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
          // console.log({ res: r })
          if (input.endsWith('.map')) {
            callStack.push('map', r);
          } else {
            callStack.push('source', r);
          }
        } catch (e) {
          console.error(e);
        }
      } else if (type === 'source') {
        /*
         * desc: raw text from the requested link
         * input: <str>
         */
        r = extractMapLink(input);
        if (r && r.length) {
          console.log('EXTRACT[source] map link', r);
          r.forEach((l) => callStack.push('link', l));
        }
      } else if (type === 'map') {
        /*
         * desc: raw source map
         * input: json
         */
        try {
          r = await extractSource(input.data);
          // console.log({ map: r })
          callStack.push('write', r);
        } catch (e) {
          console.error(e);
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
    console.error('EXTRACT[catchall]', e);
  }
};

const run = async (callStack, debug=true) => {
  while (true) {
    if (callStack.hasMore()) {
      await extract(callStack, debug);
    } else if (callStack.isComplete()) {
      break;
    }
  }
  await Store.finalize();
};

export const testpipeline = (files, prefix) =>{
  return Promise.all(
      files.map((f) => {
        console.log(`pipeline started: ${f}`);
        return pipeline(f, prefix);
      }),
  ).then(() =>{
    console.log('finalizing package.json + index.js');
    // return Store.finalize()
  }).then(()=> {
    console.log('complete');
  });
  // return argz
};


/* EXAMPLE:
 *
 * pipeline('./maps/bitbucket/app.f606c0f20e8744e93489.js.map',
 *  './build/test','map').then(() => console.log('complete'))
 */
export const pipeline = async (input, prefix='./build/src', debug=true ) => {
  const callStack = new Stack();
  Store.setPrefix(prefix);
  // pkg="test"
  // Store.package=pkg
  if (typeof(input)==='string' && input.startsWith('http')) {
    if (input.endsWith('js')) {
      callStack.push('link', input);
    } else {
      callStack.push('site', input);
    }
  } else if (ensurePathSync(input)) {
    callStack.push('local', input);
  } else if (isHtml(input)) {
    callStack.push('raw', input);
  } else {
    console.log('couldnt find '+input);
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

