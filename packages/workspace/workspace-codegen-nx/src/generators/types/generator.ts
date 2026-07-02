import { type Tree, joinPathFragments, readJson, writeJson } from '@nx/devkit';
import { scaffoldGenerator, type ScaffoldGeneratorSchema } from '../shared/generator';

interface TypesSchema {
  name?: string;
  group: string;
}

export default async function (tree: Tree, opts: TypesSchema) {
  const typesName = opts.name ?? 'types';
  const full: ScaffoldGeneratorSchema = {
    type: 'base' as const,
    name: typesName,
    group: opts.group,
    nxLayer: 'shared',
    platform: 'shared',
    access: 'public',
    publish: true,
  };
  await scaffoldGenerator(tree, full);

  // Override pkg-kind and pkg-class to reflect "types" not "base"
  const pkgName = `${opts.group}-base-${typesName}`;
  const projectJsonPath = joinPathFragments('packages', opts.group, pkgName, 'project.json');
  if (tree.exists(projectJsonPath)) {
    const projectJson = readJson(tree, projectJsonPath);
    projectJson.tags = projectJson.tags.map((t: string) => {
      if (t.startsWith('pkg-kind:')) return `pkg-kind:types`;
      if (t.startsWith('pkg-class:')) return `pkg-class:types`;
      return t;
    });
    writeJson(tree, projectJsonPath, projectJson);
  }
}
