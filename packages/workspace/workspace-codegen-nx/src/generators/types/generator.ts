import { type Tree } from '@nx/devkit';
import { scaffoldGenerator, type ScaffoldGeneratorSchema } from '../shared/generator';

interface TypesSchema {
  name: string;
  group: string;
}

export default async function (tree: Tree, opts: TypesSchema) {
  const full: ScaffoldGeneratorSchema = {
    type: 'types' as const,
    name: opts.name,
    group: opts.group,
    nxLayer: 'shared',
    platform: 'shared',
    access: 'public',
    publish: true,
  };
  await scaffoldGenerator(tree, full);
}
