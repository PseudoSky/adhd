/*  REFERENCE: https://www.npmjs.com/package/source-map#consuming-a-source-map
 *  - The properties below make up a standard source map
 *
 *  version: Which version of the source map spec this map is following.
 *
 *  sources: An array of URLs to the original source files.
 *
 *  names: An array of identifiers which can be referenced by individual mappings.
 *
 *  sourceRoot: Optional. The URL root from which all sources are relative.
 *
 *  sourcesContent: Optional. An array of contents of the original source files.
 *
 *  mappings: A string of base64 VLQs which contain the actual mappings.
 *
 *  file: Optional. The generated filename this source map is associated with.
 */

import isBase64 from './isBase64';

const MapShape = {
  version: ({version}) => Number.isInteger(version),
  sources: ({sources}) => Array.isArray(sources),
  names: ({names}) => Array.isArray(names),
  mappings: ({mappings}) => isBase64(mappings),
  file: ({file}) => !file || typeof(file)==='string',
  sourceRoot: ({sourceRoot}) => !sourceRoot || Array.isArray(sourceRoot),
  sourcesContent: ({sourcesContent}) => !sourcesContent || Array.isArray(sourcesContent),
};

const tryReadJson = (s) => {
  try {
    return JSON.parse(s);
  } catch (e) {
    return false;
  }
};

const isSourceMap = (_data) => {
  console.log('Parser(SourceMap:validate)');
  let data = _data;
  if (typeof(data)==='string') {
    if (data.length<30) return false;
    data = tryReadJson(data);
    if (!data) return false;
  }
  return Object.keys(MapShape).reduce((r, k) => {
    const check = MapShape[k](data);
    r = r===true && check;
    return r;
  }, true);
};

export default isSourceMap;
