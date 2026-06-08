import fs from 'fs-extra';
import detect from 'language-detect';
import path from 'path';
import isCSS from './isCSS.js';
import isHTML from './isHTML.js';
import isJS from './isJS.js';
import isJSON from './isJson.js';
import isSourceMap from './isSourceMap.js';
// see https://github.com/tj/node-language-classifier

const removeQuery = (s: string) => {
  return s.split(/[?#]/)[0];
};

const checkIsDirSync = (f: string) => {
  return fs.statSync(f).isDirectory();
};

const checkIsFileSync = (f: string) => {
  const stat = fs.statSync(f);
  if (!stat.isFile()) {
    return stat.size > 0 ? 1 : 0;
  } else {
    return -1
  }
  // return stat.isFile() ? stat.size > 0 & 1 : -1;
};

export const assertIsFile = (f: string) => {
  if (checkIsFileSync(f) === -1) throw new Error('Should be a file: ' + f);
};

export const assertIsDir = (f: string) => {
  if (!checkIsDirSync(f)) throw new Error('Should be a directory: ' + f);
};

export const ensurePathSync = (f: string) => {
  return fs.pathExistsSync(f);
};

export const ensurePaths = async (files: string[]) => {
  return await Promise.all(files.map(fs.pathExists));
};

export const getFileInfo = async (f: string) => {
  const cleanName = removeQuery(f);
  try {
    const baseParsed = path.parse(cleanName);
    const parsed = {
      ...baseParsed,
      name: cleanName,
      ext: removeQuery(baseParsed.ext),
      state: checkIsFileSync(f),
      exists: checkIsFileSync(f) !== 0,
      empty: checkIsFileSync(f) === 0,
      type: detect.filename(cleanName) || 'unknown'
    };

    /* short circuit attempts to parse empty fole */
    if (parsed.empty) return parsed;
    if (parsed.type === 'JSON') {
      const data = (await fs.readFile(f)).toString();
      parsed.type = isSourceMap(data) ? 'SourceMap' : 'JSON';
      return parsed;
    } else if (parsed.ext === '.map') {
      parsed.type = 'SourceMap';
    }

    if (parsed.exists && (/unknown|JSON/i.test(parsed.type))) {
      const content = (await fs.readFile(f)).toString();
      if (isSourceMap(content)) {
        parsed.type = 'SourceMap';
      } else if (isJSON(content)) {
        parsed.type = 'JSON';
      } else if (isCSS(content)) {
        parsed.type = 'CSS';
      } else if (isJS(content)) {
        parsed.type = 'JavaScript';
      } else if (isHTML(content)) {
        parsed.type = 'HTML';
      } else {
        parsed.type = 'unknown:fallback';
      }
    }
    return parsed;
  } catch (e) {
    console.error('couldnt resolve type for', f);
    throw e;
  }
};

export default { ensure: ensurePathSync, ensurePaths, getFileInfo };
