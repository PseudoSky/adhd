import { isEqual } from './object'
import { sortBy } from "./collections";
import { isFunction, isValue, isArray, isDate } from './filters';

export const intMin = Number.MIN_SAFE_INTEGER;
export const intMax = Number.MAX_SAFE_INTEGER;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallbackFunctionVariadic = (...args: any[]) => void;
export type CallbackFunctionTyped<Params extends []> = (...args: Params) => void;

export const compose = (...funcs: CallbackFunctionVariadic[]) =>
  funcs.reduce(
    (a, b) => (...args) => a(b(...args)),
    arg => arg
  );


export function noop(){return null}

export function extractThen(key: string, callback: CallbackFunctionTyped<any>): (...args: Parameters<typeof callback>) => ReturnType<typeof callback> {
  return (...args) => callback(...(args as {[k: string]: any}[]).map(({[key]: value}) => value))
}

/*
 * Traversal & transform utils
 * Set and get based on string paths
 */

const STR_PATH_REGEX = /[,[\].]+?/ // ALT from site /[,[\]]+?/
export function toPath(path: string | string[]): string[]{
  return typeof path==='string' ? path.split(STR_PATH_REGEX)
                                .filter(Boolean) : path

}

// TODO falsey is unclear - seems like it's actually doing the opposite
export function isFalsey (obj: any){
  return obj !== null && obj !== undefined
}
export function doesObjectExists (obj: any){
  return !!obj && obj !== null && obj !== undefined;
}

export function makeGetter(_path?: string, obj?: any): (value?: any) => any  {
  if(!obj){
    return (_obj: any) => makeGetter(_path, _obj)()
  }
  if(!_path) {
    return (path: string) => makeGetter(path, obj)()
  }
  const path=toPath(_path)
  console.warn({path})
  if(!path.length) return (value: any) => obj||value
  return (value: any) => path.reduce(
    (previous, key: string, index: number) => {

      // parent needs to be defined at next key
      // const [parent, lastKey] = previous;
      const res = previous;
      // const parentTemplate = previous[3]
      const field = key.replace(/(^")|("$)/g,'') as keyof typeof res
      // If field is not in 
      const isEnd = index === path.length-1
      if(!isEnd){
        const nextType = !Number.isNaN(parseInt(path[index+1])) ? []: {};
        if(!(field in res)){
          res[field] = nextType
        }
      }

      const isInt = !Number.isNaN(parseInt(String(field)))
      // const isLastInt = lastKey!==null ? !Number.isNaN(parseInt(lastKey)) : false
      
      // const isParentDefined = doesObjectExists(parent);
      // const isLastKeyDefined = doesObjectExists(lastKey);
      // const isResultDefined = doesObjectExists(res);
      const fieldTemplate = isInt ? [] : {}
      console.warn({field, isInt, isEnd, fieldTemplate, value: res[field] || value})
      if(isEnd){
        // res[field] = value
        return res[field] || value
      }
      return res[field];
      // if(!isParentDefined){
      //   return [res, field, res[field]]
      // }
      // if(! isLastKeyDefined){
      //   return [res, field, res[field], fieldTemplate]
      // }
      // if(!isResultDefined){
      //   parent[lastKey] = parentTemplate
      //   res = parent[lastKey]
      //   return [res, field, undefined, fieldTemplate]
      // }
      // if(!(field in res)){
      //   // parent[field] = fieldTemplate;
      //   res = parent[field];
      //   return [parent, field, res]
      // } else {
      //   parent[field]
      //   return [parent, field, res[field]]
      // }

      // Field does not exist
      // if(!(field in res)) {
      //   if(isEnd){
      //     res[field] = value
      //     console.warn("isEnd",{obj, field, value})
      //     return obj
      //   } else{
      //     res[field] = fieldTemplate
      //     console.warn("Iterate",{obj: JSON.stringify(obj), field, value})
      //     return [res, field, res[field]]
      //   }
      // } else {
      //   return [res, field, res[field]]
      // }
  }, obj
  )
}

export function makeSetter(_path: string, obj?: any)  {
  // if(!obj){
  //   return (_obj: any) => makeGetter(_path, _obj, useSetters)()
  // }
  // if(!_path) {
  //   return (path: string) => makeGetter(path, obj, useSetters)()
  // }
  const path=toPath(_path)
  console.warn({path})
  if(!path.length) return (defaultValue: any) => obj||defaultValue
  return (value: any) => path.reduce(
    (previous, key: string, index: number) => {

      // parent needs to be defined at next key
      // const [parent, lastKey] = previous;
      const res = previous;
      // const parentTemplate = previous[3]
      const field = key.replace(/(^")|("$)/g,'') as keyof typeof res
      // If field is not in 
      const isEnd = index === path.length-1
      if(!isEnd){
        const nextType = !Number.isNaN(parseInt(path[index+1])) ? []: {};
        if(!(field in res)){
          res[field] = nextType
        }
      }

      const isInt = !Number.isNaN(parseInt(String(field)))
      // const isLastInt = lastKey!==null ? !Number.isNaN(parseInt(lastKey)) : false
      
      // const isParentDefined = doesObjectExists(parent);
      // const isLastKeyDefined = doesObjectExists(lastKey);
      // const isResultDefined = doesObjectExists(res);
      const fieldTemplate = isInt ? [] : {}
      console.warn({field, isInt, isEnd, fieldTemplate})
      if(isEnd){
        res[field] = value
        return obj
      }
      return res[field];
      // if(!isParentDefined){
      //   return [res, field, res[field]]
      // }
      // if(! isLastKeyDefined){
      //   return [res, field, res[field], fieldTemplate]
      // }
      // if(!isResultDefined){
      //   parent[lastKey] = parentTemplate
      //   res = parent[lastKey]
      //   return [res, field, undefined, fieldTemplate]
      // }
      // if(!(field in res)){
      //   // parent[field] = fieldTemplate;
      //   res = parent[field];
      //   return [parent, field, res]
      // } else {
      //   parent[field]
      //   return [parent, field, res[field]]
      // }

      // Field does not exist
      // if(!(field in res)) {
      //   if(isEnd){
      //     res[field] = value
      //     console.warn("isEnd",{obj, field, value})
      //     return obj
      //   } else{
      //     res[field] = fieldTemplate
      //     console.warn("Iterate",{obj: JSON.stringify(obj), field, value})
      //     return [res, field, res[field]]
      //   }
      // } else {
      //   return [res, field, res[field]]
      // }
  }, obj
  )
}
// export function makeGetter(_path: string, obj?: any, useSetters=true) {
//   if(!obj){
//     return (_obj: any) => makeGetter(_path, _obj, useSetters)()
//   }
//   if(!_path) {
//     return (path: string) => makeGetter(path, obj, useSetters)()
//   }
//   const path=toPath(_path)
//   console.warn({path})
//   if(!path || !path.length) return (defaultValue: any) => obj||defaultValue
//   return (defaultValue: any) => path.reduce(
//     ([parent, lastKey, res]:any[], key: string, index: number) => {
//       console.warn([lastKey], {key, index})
//       if(isFalsey(res) && isFalsey(parent)) return defaultValue
//       const field = key.replace(/(^")|("$)/g,'')
//       const isInt = !Number.isNaN(parseInt(field))
//       const isEnd = index === path.length-1
//       console.warn("checking falsey setter !isFalsey(res)", {notIsFalsey: !isFalsey(res), lastKey})
//       if(!isFalsey(res)){
//         console.warn("checking falsey setter isFalsey(parent)", {isFalsey: isFalsey(res), lastKey})
//         if(isFalsey(parent)){
//           res = isInt && key === field ? [] : {}
//           if(useSetters){
//             parent[lastKey]=res
//             console.warn("applying setter", {lastKey, defaultValue})
//             if(isEnd){
//               res[field] = defaultValue
//             }
//           }
//         }
//         if(isEnd){
//           return defaultValue
//         }
//       } 
//       // else if(isEnd){
//       //   if(useSetters && !!defaultValue){
//       //     res = isInt && key === field ? [] : {}
//       //     res[field] = defaultValue
//       //     parent[lastKey] = res
//       //   }
//       // }
//       return isEnd ? res[field] : [res, field, res[field]]
//     }, [null, null, obj]
//   ) || defaultValue
// }

// TODO: doesn't look like it works
// export function makeSetter(path: string, obj: any) {
//   const getAttr = makeGetter(path, obj)
//   return (value: any) => {
//     const res = getAttr(value);
//     return obj
//   }
// }

export function get(obj: any, path: string, defaultValue: any=undefined) {
  return makeGetter(path, obj)(defaultValue)
}

export function set(data: any, path: string, value: any){
  return makeSetter(path, data)(value);
}

export function getAll(obj: any, paths: string[], into: any[]=[]){
  return paths.reduce((res, path) => {
    const value = get(obj, path, undefined)
    return res.concat([value])
    // return set(res, path, value)
  }, into);
}

// export getAll;
// export toPath;
// export makeGetter;
// export makeSetter;
// export get;
// export set;



/*
EXAMPLE

var object = { a: [{ b: { c: 3 } }] };
var result = get(object, 'a[0].b.c', 1);
// output: 3

*/

// export function get(obj, path, defaultValue){
//   const travel = regexp =>
//     String.prototype.split
//       .call(path, regexp)
//       .filter(Boolean)
//       .reduce((res, key) => (res !== null && res !== undefined ? res[key] : res), obj);
//   const result = travel(/[,[\]]+?/) || travel(/[,[\].]+?/);
//   return result === undefined || result === obj ? defaultValue : result;
// };

/* end traversal utils */


/*
 * Function modifiers
 */

export function runAfter(f: CallbackFunctionVariadic, t: number) {
  return function (...args: any[]) {
    // Original 
    // const args = arguments;
    // const self = this;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return setTimeout(() => f.apply(self, args), t);
  };
}

export function throttle<T extends CallbackFunctionVariadic>(func: T, timeFrame: number) {
  let lastTime = 0;
  return function (...args: Parameters<T>) {
      const now = Number(new Date());
      if (now - lastTime >= timeFrame) {
          func.apply(this, args);
          lastTime = now;
      }
  };
}

export function flowPipe(...funcs: CallbackFunctionVariadic[]) {
  return (...props: any) => {
    return funcs.reduce((res, f) => {
      return Array.isArray(res) ? f.apply(this, res) : f(res);
    }, props);
  };
}

export function splitPipe(...funcs: CallbackFunctionVariadic[]) {
  return (...args: Parameters<typeof funcs[0]>) => funcs.map(function(f){
      return f(args)
    })
}


export function flow(funcs: CallbackFunctionVariadic[]){
  return (...args: Parameters<typeof funcs[0]>) => {
    return funcs.reduce((prev, fnc) => [fnc(...prev)], args)[0]
  }
}

export function partial<F extends CallbackFunctionVariadic>(func: CallbackFunctionVariadic, ...boundArgs: Parameters<F>){
  return (...remainingArgs: Parameters<F>) => func(...boundArgs, ...remainingArgs)
}

export class Differ {
  static VALUE_CREATED = "created"
  static VALUE_UPDATED = "updated"
  static VALUE_DELETED = "deleted"
  static VALUE_UNCHANGED = "unchanged"

  static map = <O1=Record<string,any> | any[],O2=Record<string,any> | any[]>(obj1?: O1, obj2?: O2) => {
    if (isFunction(obj1) || isFunction(obj2)) {
      throw "Invalid argument. Function given, object expected.";
    }
    
    // TODO: looks like this will short circuit the rest of the func (array is value)
    if (isValue(obj1) || isValue(obj2)) {
      const change = Differ.compareArrays(obj1 as any[], obj2 as any[])
      if(change===Differ.VALUE_UNCHANGED){
        return null
      }
      return obj2 === undefined ? obj1 : obj2
      // {
      //   type: Differ.compareValues(obj1, obj2),
      //   data: obj2 === undefined ? obj1 : obj2
      // };
    }

    if (isArray(obj1) || isArray(obj2)) {
      const change = Differ.compareArrays((obj1 as any[]), obj2 as any[])
      if(change===Differ.VALUE_UNCHANGED){
        return null
      }
      return Differ.getArrayDiffData(obj1 as any[], obj2 as any[]);
    }

    const diff: Record<string,any> = {};
    for (const key in obj1) {

      if (isFunction(obj1[key as keyof typeof obj1])) {
        continue;
      }

      let value2 = undefined;
      if (obj2 && obj2[key as keyof O2] !== undefined) {
        value2 = obj2[key as keyof O2];
      }

      const d = Differ.map(obj1[key], value2);
      if(d) {
        diff[key] = d
      }
    }
    for (const key in obj2) {
      if (isFunction(obj2[key]) || diff[key] !== undefined) {
        continue;
      }
      const d = Differ.map(undefined, obj2[key])
      if(d){
        diff[key] = d;
      }
    }

    return diff;

  }

  static getArrayDiffData = (arr1: any[], arr2: any[]) => {
    if (arr1 === undefined || arr2 === undefined) {
       return arr1 === undefined ? arr1 : arr2;
    }
    console.log({arr1,arr2})
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);

    const deleted = [...arr1].filter(x => !set2.has(x));

    const added = [...arr2].filter(x => !set1.has(x));

    return {
      added, deleted
    };

  }

  static compareArrays = (arr1: any[], arr2: any[]) => {
    // const set1 = new Set(arr1);
    // const set2 = new Set(arr2);
    if (isEqual(sortBy(arr1), sortBy(arr2))) {
      return Differ.VALUE_UNCHANGED;
    }
    if (arr1 === undefined) {
      return Differ.VALUE_CREATED;
    }
    if (arr2 === undefined) {
      return Differ.VALUE_DELETED;
    }
    return Differ.VALUE_UPDATED;
  }

  static compareValues = (value1: any, value2: any) => {
    if (value1 === value2) {
      return Differ.VALUE_UNCHANGED;
    }
    if (isDate(value1) && isDate(value2) && value1.getTime() === value2.getTime()) {
      return Differ.VALUE_UNCHANGED;
    }
    if (value1 === undefined) {
      return Differ.VALUE_CREATED;
    }
    if (value2 === undefined) {
      return Differ.VALUE_DELETED;
    }
    return Differ.VALUE_UPDATED;
  }
}

export default {
  intMin,
  intMax,
  compose,
  noop,
  extractThen,
  toPath,
  isFalsey,
  makeGetter,
  makeSetter,
  get,
  set,
  getAll,
  runAfter,
  throttle,
  flowPipe,
  splitPipe,
  flow,
  partial,
  Differ,
}
