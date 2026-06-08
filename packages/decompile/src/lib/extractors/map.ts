import 'babel-polyfill';
import sourceMap, { RawSourceMap } from 'source-map';
import { StackItem } from '../pipeline/stack';
const formatName = (f: string) => {
  return f.replace('webpack:///', '');
};

const SOURCEMAP_URL_REGEX = /sourceMappingURL=([/a-zA-Z._0-9-]+\.map)/gim;

export const extractMapLink = (raw: StackItem) => {
  const { path, data } = raw;
  console.log({ path });
  // TODO: should allow [?] ?
  let mfiles = ((data as string).match(SOURCEMAP_URL_REGEX) || [])
    .filter((e) => !!e).map((s) => s.split('=')[1]);
  if (mfiles.length) {
    mfiles = [mfiles[mfiles.length - 1]];
    return mfiles.map((mfile: string) => {
      if (mfile.startsWith('http')) {
        return mfile;
      } else {
        const newp = path.split('/');
        newp[newp.length - 1] = mfile;
        return newp.join('/');
      }
    });
  }
};

// type SourceType = { path: string; data: string | null };
export const extractSource = async (rawMap: RawSourceMap) => {
  try {
    const consumer = await new sourceMap.SourceMapConsumer(rawMap);
    const sources: Record<string, StackItem> = {}
    consumer.eachMapping((m) => {
      const s = m.source
      const outFile = formatName(s);
      if (m.source && !sources[outFile]) {
        const content = consumer.sourceContentFor(s, true);
        if (
          !(outFile.startsWith('external ') ||
            outFile.startsWith('(webpack)'))
        ) {
          // TODO: can depcheck check raw text for dependencies?
          // NOTE: this may remove chunked content, consider content hashing
          sources[outFile] = { path: outFile, data: content || "" };
          console.log("extractSource", { path: outFile })
        }
      }
    })
    return Object.values(sources).filter(e => !!e);
    // return await Promise.all(consumer.sources.map((s) => {
    //   const outFile = formatName(s);
    //   const content = consumer.sourceContentFor(s) || '';
    //   if (
    //     !(outFile.startsWith('external ') ||
    //       outFile.startsWith('(webpack)'))
    //   ) {
    //     // TODO: can depcheck check raw text for dependencies?
    //     return { name: outFile, data: content };
    //   } else {
    //     return null;
    //   }
    // })).then((r) => {
    //   // consumer.destroy();
    //   return r;
    // }).catch((e) => {
    //   console.error(e);
    //   // consumer.destroy();
    //   return null;
    // });
  } catch (e) {
    console.error('ERROR[extractSource]', e);
    return [];
  }
};

export default extractSource;
