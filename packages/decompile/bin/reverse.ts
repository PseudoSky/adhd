#!/usr/bin/env node

import { Command } from "commander";

// import "regenerator-runtime/runtime";
import { Extractors, FileStore } from "../src/index.js";

function collect(value: string, previous: string[]) {
  return previous.concat([value]);
}

const program = new Command();

program
  .command("reverse")
  .version("0.0.1")
  .description("crawl and extract source maps")
  .option("-o, --output <path>", "output path", "decompiled")
  .arguments("[sources...]")
  .usage(`
${program.helpInformation().split("\n")[0]}

Example:
  adhd -o ./output "https://example.com" "./source.{html,js,css,map}"
`).action(
    async (sources, _, tops) => {
      const allSources = sources

      try {
        const res = await Extractors.testpipeline(allSources, tops.output);
        console.log("finished", { ...res });
      } catch (e) {
        console.error("failed", { error: e });
        process.exit(1);
      }
    }
  );


program
  .command("deps")
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
  .argument("<source...>", "entry point + optional src dirs")
  .action(async (sources: string[], opts) => {
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
await program.parseAsync(process.argv);

// program.command('map <source> [sources...]').option('-o <output>', 'Output path')
// .storeOptionsAsProperties(false)
// .command('map <source> [sources...]', {isDefault: true})

// .action((options) => {
//   console.log(options.action);
// })
// .action((argz) => {
//   console.log(argz);
//   Extractor.testpipeline(argz);
// })
// program.exitOverride();
//

// const commands = program.commands.map(c => c.name());
// const cmdSet = new Set(commands);
// const args = program.commands[0].args.filter(e => !commands.has(e))
// console.log(), program.commands[0].args.filter(e => e!='map'))

// const programOptions = program._args;
// console.log(process.argv);
// const program = new commander.Command();

// console.log(program);
// async function main() {
// await program.parseAsync(process.argv);
// }
// if (!program.args.length || !process.argv.slice(2).length) {
//   program.outputHelp();
// } else {
//   Extractors.testpipeline(program.args, program.options)
//     .then((res) => {
//       console.log('finished', res);
//     })
//     .catch((e) => {
//       console.error('failed', { error: e });
//     });
// }
