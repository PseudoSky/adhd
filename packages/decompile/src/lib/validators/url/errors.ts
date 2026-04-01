const renamedMap = {
  stripFragment: 'stripHash',
  normalizeHttp: 'forceHttps',
  normalizeHttps: 'forceHttp',
};

export const InvalidUrlError = (url) => new Error(`Invalid URL: ${url}`);
export const FunctionRenamedError = (kind) => new Error(`options.${kind} is renamed to options.${renamedMap[kind]}`);
export const BadOptionsError = () => new Error('The `forceHttp` and `forceHttps` options cannot be used together');


// export class InvalidUrlError extends Error() {
//   constructor ( url, extra ) {
//     super(`Invalid URL: ${url}`)
//     this.message = `Invalid URL: ${url}`
//     Error.captureStackTrace( this, this.constructor )
//     this.name = 'InvalidUrlError'
//     if ( extra ) this.extra = extra
//   }
// }
// export class FunctionRenamedError extends Error() {
//   constructor ( kind, extra ) {
//     super(`options.${kind} is renamed to options.${renamedMap[kind]}`)
//     this.message = `options.${kind} is renamed to options.${renamedMap[kind]}`
//     Error.captureStackTrace( this, this.constructor )
//     this.name = 'FunctionRenamedError'
//     if ( extra ) this.extra = extra
//   }
// }

// export class BadOptionsError extends Error() {
//   constructor(extra){
//     super('The `forceHttp` and `forceHttps` options cannot be used together')
//     this.message = 'The `forceHttp` and `forceHttps` options cannot be used together'
//     Error.captureStackTrace( this, this.constructor )
//     this.name = 'BadOptionsError'
//     if ( extra ) this.extra = extra
//   }
// }
