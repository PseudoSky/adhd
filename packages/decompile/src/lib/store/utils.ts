import fs from 'fs';

export const read_map = (map_file) => {
    const fileContents = fs.readFileSync(map_file, 'utf8');
    return JSON.parse(fileContents);
};
export const cleanFilePath = (p) => p.replace(/^(\.\/)?(\.\.\/)+/gm, '').replace(/^(\.\/)?src\//, '');
export const isExternalRef = (f) => /(webpack\/bootstrap)|(\/external "\w+"$)/i.test(f);
