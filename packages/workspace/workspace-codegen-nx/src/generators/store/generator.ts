import { type Tree } from '@nx/devkit';
import { scaffoldGenerator, type ScaffoldGeneratorSchema } from '../shared/generator';

interface SubGeneratorSchema {
  name: string;
  group: string;
  nxLayer: string;
  platform: 'node' | 'browser' | 'shared';
  access?: 'domain' | 'public';
  publish?: boolean;
}

export default async function (tree: Tree, opts: SubGeneratorSchema) {
  const full: ScaffoldGeneratorSchema = { ...opts, type: 'store' as const };
  await scaffoldGenerator(tree, full);
}
