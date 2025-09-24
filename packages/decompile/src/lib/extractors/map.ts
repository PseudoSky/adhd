import 'babel-polyfill'
import sourceMap from 'source-map';
const formatName = (f) => {
  return f.replace('webpack:///', '');
};

const SOURCEMAP_URL_REGEX = /sourceMappingURL=([/a-zA-Z\._0-9\-]+\.map)/gim;

export const extractMapLink = (raw) => {
  const {path, data} = raw;
  console.log({path});
  // TODO: should allow [?] ?
  let mfiles = (data.match(SOURCEMAP_URL_REGEX)||[])
      .filter((e)=> !!e).map((s) => s.split('=')[1]);
  if (mfiles.length) {
    mfiles = [mfiles[mfiles.length-1]];
    return mfiles.map((mfile) => {
      if (mfile.startsWith('http')) {
        return mfile;
      } else {
        const newp = path.split('/');
        newp[newp.length-1]=mfile;
        return newp.join('/');
      }
    });
  }
};


export const extractSource = async (rawMap) => {
  try {
    const consumer = await new sourceMap.SourceMapConsumer(rawMap);
    return await Promise.all(consumer.sources.map((s) => {
      const outFile = formatName(s);
      const content = consumer.sourceContentFor(s) || '';
      if (
        !(outFile.startsWith('external ') ||
            outFile.startsWith('(webpack)'))
      ) {
        // TODO: can depcheck check raw text for dependencies?
        return {name: outFile, data: content};
      } else {
        return null;
      }
    })).then((r) => {
      consumer.destroy();
      return r;
    }).catch((e) => {
      console.error(e);
      consumer.destroy();
      return null;
    });
  } catch (e) {
    console.error('ERROR[extractSource]', e);
    return null;
  }
};

export default extractSource;
