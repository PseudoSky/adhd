import fs from 'fs-extra';
export const extractLocal = (path: string) => {

  let r = null;
  try {
    r = fs.readFileSync(path);
  }
  catch (e) {
    console.error(e);
  }
  const data = r?.toString()
  if (r && data) {

    return { path: path, data };
  }
  return null;
  // files = files.filter(f => fs.pathExistsSync(f))
  // files = files.map(f => fs.statSync(f).isFile())
  // const res = [];
  // return path.map((f) => {
  // }).filter((o) => (!!o));
};
export default extractLocal;
