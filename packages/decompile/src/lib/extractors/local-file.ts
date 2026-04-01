import fs from 'fs-extra';
export const extractLocal = (path) => {
  let files = path;
  if (typeof (path) === 'string') {
    files = [path];
  }
  // files = files.filter(f => fs.pathExistsSync(f))
  // files = files.map(f => fs.statSync(f).isFile())
  // const res = [];
  return files.map((f) => {
    let r = null;
    try {
      r = fs.readFileSync(f);
    }
    catch (e) {
      console.error(e);
    }
    if (r) {
      return { path: f, data: r.toString() };
    }
    return null;
  }).filter((o) => (!!o && !!o.data));
};
export default extractLocal;
