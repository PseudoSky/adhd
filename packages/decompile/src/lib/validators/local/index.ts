import fs from 'fs-extra';
import path from 'path';
import detect from 'language-detect';
import isJSON from './isJson';
import isCSS from './isCSS';
import isSourceMap from './isSourceMap';
import isJS from './isJS';
import isHTML from './isHTML';
// see https://github.com/tj/node-language-classifier

const removeQuery = (s) => {
  return s.split(/[?#]/)[0];
};

const checkIsDirSync = (f) => {
  return fs.statSync(f).isDir();
};

const checkIsFileSync = (f) => {
  const stat = fs.statSync(f);
  return stat.isFile() ? (stat.size>0 & 1) : -1;
};

export const assertIsFile = (f) => {
  if (checkIsFileSync(f)===-1) throw new Error('Should be a file: ' + f);
};

export const assertIsDir = (f) => {
  if (!checkIsDirSync(f)) throw new Error('Should be a directory: ' + f);
};

export const ensurePathSync = (f) => {
  return fs.pathExistsSync(f);
};

export const ensurePaths = async (files) =>{
  return await Promise.all(files.map(fs.pathExists));
};

export const getFileInfo = async (f) => {
  const cleanName = removeQuery(f);
  try {
    const parsed = path.parse(cleanName);
    parsed.name = cleanName;
    parsed.ext = removeQuery(parsed.ext);
    parsed.state = checkIsFileSync(f);
    parsed.exists = parsed.state!==0;
    parsed.empty = parsed.state===0;
    parsed.type = detect.filename(cleanName);
    parsed.type = parsed.type || 'unknown';

    /* short circuit attempts to parse empty fole */
    if (parsed.empty) return parsed;
    if (parsed.type==='JSON') {
      const data = (await fs.readFile(f)).toString();
      parsed.type=isSourceMap(data) ? 'SourceMap' : 'JSON';
      return parsed;
    } else if (parsed.ext ==='.map') {
      parsed.type = 'SourceMap';
    }

    if (parsed.exists && (/unknown|JSON/i.test(parsed.type)) ) {
      const content = (await fs.readFile(f)).toString();
      if (isSourceMap(content)) {
        parsed.type='SourceMap';
      } else if (isJSON(content)) {
        parsed.type = 'JSON';
      } else if (isCSS(content)) {
        parsed.type='CSS';
      } else if (isJS(content)) {
        parsed.type = 'JavaScript';
      } else if (isHTML(content)) {
        parsed.type='HTML';
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

export default {ensure: ensurePathSync, ensurePaths, getFileInfo};
