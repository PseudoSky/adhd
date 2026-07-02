import { type Tree } from '@nx/devkit';
import { scaffoldGenerator, type ScaffoldGeneratorSchema } from '../shared/generator';

interface EntrypointSchema {
  name: string;
  group?: string;
  nxLayer: string;
  platform: 'node' | 'browser' | 'shared';
  access?: 'domain' | 'public';
  publish?: boolean;
}

export default async function (tree: Tree, opts: EntrypointSchema) {
  const full: ScaffoldGeneratorSchema = {
    type: 'entrypoint' as const,
    name: opts.name,
    group: opts.group ?? 'entrypoint',
    nxLayer: opts.nxLayer,
    platform: opts.platform,
    access: opts.access,
    publish: opts.publish,
  };
  await scaffoldGenerator(tree, full);
}
