import fs from 'fs';

export const read_map = (map_file: string) => {
    const fileContents = fs.readFileSync(map_file, 'utf8');
    return JSON.parse(fileContents);
};
export const cleanFilePath = (p: string) => p.replace(/^(\.\/)?(\.\.\/)+/gm, '').replace(/^(\.\/)?src\//, '');
export const isExternalRef = (f: string) => /(webpack\/bootstrap)|(\/external "\w+"$)/i.test(f);
