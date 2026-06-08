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

import { Transform } from '@adhd/transform';
import isBase64 from './isBase64.js';

type MapType = {
  version: number;
  sources: unknown[];
  names: unknown[];
  mappings: string;
  file?: string;
  sourceRoot?: unknown[]
  sourcesContent?: unknown[]
}

const MapShape = {
  version: ({ version }: MapType) => Transform.isInt(version),
  sources: ({ sources }: MapType) => Transform.isArray(sources),
  names: ({ names }: MapType) => Transform.isArray(names),
  mappings: ({ mappings }: MapType) => isBase64(mappings),
  file: ({ file }: MapType) => !file || Transform.isString(file),
  sourceRoot: ({ sourceRoot }: MapType) => !sourceRoot || Transform.isArray(sourceRoot),
  sourcesContent: ({ sourcesContent }: MapType) => !sourcesContent || Transform.isArray(sourcesContent),
};

const tryReadJson = (s: unknown) => {
  if (!Transform.isString(s)) {
    return false
  }
  try {
    return JSON.parse(s as string);
  } catch (e) {
    return false;
  }
};

const isSourceMap = (_data: string | MapType) => {
  console.log('Parser(SourceMap:validate)');
  let data = _data;
  if (typeof (data) === 'string') {
    if (data.length < 30) return false;
    data = tryReadJson(data) as MapType;
    if (!data) return false;
  }
  return Object.keys(MapShape).reduce((r, k) => {
    const check = MapShape[k as keyof typeof MapShape](data as MapType);
    r = r === true && check;
    return r;
  }, true);
};

export default isSourceMap;
