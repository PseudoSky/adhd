## @adhd/reverse

Reverse is a tool for reverse engineering code bundled with source maps.
Reverse accepts
**(remote) urls:** html, js, css, map, json
**(local) files:** html, js, ts, jsx..., css, etc

### Install

`npm install -g @adhd/reverse`
`yarn global add @adhd/reverse`


### Usage

To run in reverse, you have to supply a reference to the target. It can be in the form of a `url`, `domain`, or local `files`.

**currently supported types** (remote and local)
 - `html` extracts references (css, js)
 - `js*` extracts references (map, js deps)
 - `css` extracts references (map)
 - `map` uses the map to rebuild source code (src, fs, deps)
 - `json` currently checks to see if the json is a map


Run with


`npx @adhd/reverse`

or

```
> adhd-reverse -h

Usage: adhd-reverse
Usage:  [options] [source] <sources...>

Example: > adhd-reverse -o ./<output_directory> "https://<url_to_examine>" "./source.{html,js,css,map}"

crawl and extract source maps

Options:
  -V, --version  output the version number
  -o <output>    (optional) directory to write the source into
  -h, --help     output usage information
```

#### CLI


`[source] <sources...>` (required) one or more `urls` and or `file_paths`

`-o <output_dir>`






#### Pipeline

**with url for source arg**

request url
-> extract asset refs
-> request assets
-> extract source map references
-> request maps
-> reverse map the assets
-> dump source code
-> reverse the external dependencies
-> reconstruct entry point

For local files the pipeline skips to the 4th step
For source maps it skips to the 6th line




# @adhd/reverse

reverse is a tool for reverse engineering code bundled with source maps.
reverse accepts

* **(remote) urls:** html, js, css, map, json

* **(local) files:** html, js, ts, jsx..., css, etc

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites

What things you need to install the software and how to install them

```
Give examples
```

### Installing

A step by step series of examples that tell you how to get a development env running

With `npm`

```sh
npm install -g @adhd/reverse
```

With `npx`

```sh
npx @adhd/reverse <...>
```

With `yarn`

```
yarn global add @adhd/reverse
```

End with an example of getting some data out of the system or using it for a little demo

## Running the tests

`ava` or `yarn test`

### Break down into end to end tests

In [src/validators/local/__tests__](./src/validators/local/__tests__) each of the pattern matching utilities are tested

The data mocks are in [tests/fixtures](./tests/fixtures)

EX: [base64.sourcemap.js](./tests/fixtures/base64.sourcemap.js)

```js
    ).apply(__cjsWrapper.exports, __cjsWrapper.args);
}
)(System, System);
//# sourceURL=module://App.js.js!transpiled
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZTovL0FwcC5q...
```

### And coding style tests

Explain what these tests test and why

```
Give an example
```

## Deployment

Add additional notes about how to deploy this on a live system

## Built With

* [Dropwizard](http://www.dropwizard.io/1.0.2/docs/) - The web framework used
* [Maven](https://maven.apache.org/) - Dependency Management
* [ROME](https://rometools.github.io/rome/) - Used to generate RSS Feeds

## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/your/project/tags).

## Authors

* **Billie Thompson** - *Initial work* - [PurpleBooth](https://github.com/PurpleBooth)

See also the list of [contributors](https://github.com/your/project/contributors) who participated in this project.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Acknowledgments

* Hat tip to anyone whose code was used
* Inspiration
* etc
