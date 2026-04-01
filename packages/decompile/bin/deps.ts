#!/usr/bin/env node

import { Command } from "commander";
import { FileStore } from "../src/index.js";

const program = new Command();

function collect(value: string, previous: string[]) {
  return previous.concat([value]);
}

program
  .name("adhd-deps")
  .version("0.0.1")
  .description("get deps from path")
  // .arguments("<source> [sources...]")
  .option(
    "-a, --allowModule <module>",
    "allow only specific node_modules",
    collect,
    []
  )
  .option(
    "-x, --excludeModule <module>",
    "exclude specific node_modules",
    collect,
    []
  )
  .option("-m, --allowAllModules", "allow all node_modules")
  .option("-e, --excludeRegex <regex>", "regex to match paths for exclusion")
  .option("-i, --includeRegex <regex>", "regex to match paths for inclusion")
  .option("-j, --json", "output json string")
  .usage(
    `<source...>
    
    Example:
    adhd-deps "libs/my-lib/src" | jq .unimported`
  )
  .argument("<source...>", "entry point + optional src dirs");

program.action(async (sources: string[], opts) => {
  let options: any = {
    exclude: {
      path: ".*(node_modules).*",
    },
  };

  // precedence logic (same as your original)
  if (opts.exclude?.length) {
    options.exclude = {
      path: `.*(node_modules\\/(${opts.exclude.join("|")})\\/).*`,
    };
  } else if (opts.include?.length) {
    options.exclude = {
      path: `.*(?!node_modules\\/(?:${opts.include.join(
        "|"
      )})\\/)node_modules\\/.*`,
    };
  } else if (opts.allowModules) {
    delete options.exclude;
  }

  if (opts.excludeRegex) {
    options.exclude = {
      path: opts.excludeRegex,
    };
  }

  if (opts.includeRegex) {
    options.includeOnly = opts.includeRegex;
  }

  try {
    const data = await FileStore.getDeps(sources, options);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data);
    }
  } catch (err) {
    console.error("failed", err);
    process.exit(1);
  }
});

program.parseAsync(process.argv);