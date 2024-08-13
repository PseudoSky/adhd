import _ from '@adhd/transform'
import { BooleanExpression, OrderByExpression } from "./expressions";
import { operators } from './filters';
import { OrderByOperation } from "./operators";

function findLogicalParent(path: string[]): string {
    const stack = ([...path]).slice(0, -1)
    while (stack.length) {
        const k = stack.pop();
        if (k && ['_and', '_or', '_not'].includes(k)) {
            return stack.length ? stack.join('.') + `.${k}` : k
        }
    }
    return "<root>"
}

export function parseWhere(query: BooleanExpression, obj: any) {
    const logical = _.allPaths(query, (key) => ['_and', '_or', '_not'].includes(key.toString()))
    const filters = _.allPaths(query, (key, _, o) => key.toString().startsWith('_') && !['_and', '_or', '_not'].includes(key.toString()))
    const fields = _.allPaths(query, (key, _, o) => !/^[0-9]+$/.test(`${key}`) && !key.toString().startsWith('_') && Object.keys(o[key] as object).every(e => e.startsWith('_') && !['_and', '_or', '_not'].includes(e)))
    let deps = {} as Record<string, string[]>;
    const fieldDeps = {} as Record<string, string[]>;
    const fieldFilters = filters.reduce((res, item) => {
        const key = item.join('.')
        const depKey = item.slice(0, -1).join('.');
        const fieldKey = item.filter(e => (!e.startsWith('_') && ! /^[0-9]+$/.test(e))).join('.')
        const opName = item[item.length - 1]
        fieldDeps[depKey] = [...(fieldDeps[depKey]||[]), key]
        return [...res, {field: fieldKey, key, opName, value: _.get(query, item)}]
    }, [] as {field: string,opName: string, key:string, value: any}[])
    const results = {} as Record<string, boolean>
    deps = fields.reduce((res, item) => {
        const parent = findLogicalParent(item);
        const parentDeps = (parent in res ? res[parent] : [])
        if(/_or$/.test(parent)){
            const implicitKey = item.slice(0, parent.split('.').length+1).join('.')+'._and'
            res[implicitKey] = res[implicitKey]||[]
            res[implicitKey].push(item.join('.'))
            if(!parentDeps.includes(implicitKey)) {
                parentDeps.push(implicitKey)
                logical.push(implicitKey.split('.'))
            }
        } else{
            parentDeps.push(item.join('.'))
        }
        return { ...res, [parent]: parentDeps };
    }, deps as Record<string, string[]>)
    const allDeps = logical.reduce((res, item) => {
        const parent = findLogicalParent(item);
        return { ...res, [parent]: (parent in res ? res[parent] : []).concat([item.join('.')]) };
    }, deps as Record<string, string[]>)
    for (const item of fieldFilters) {
        const {field, opName, value, key} = item
        const op = operators[opName]
        const input = _.get(obj, field)
        const result = op(input)(value)
        results[key] = result;
    }
    for (const [fd, items] of Object.entries(fieldDeps)) {
        results[fd] = items.every(e => results[e])
    }
    // NOTE: sort is necessary to ensure logical children are resolved first
    for (const item of logical.sort((a,b) => b.length-a.length)) {
        const itemPathKey = item.join('.')
        const opName = item[item.length-1]
        const deps = allDeps[itemPathKey];
        if(opName == '_not'){
            results[itemPathKey] = deps.some(e => results[e] == false);
        } else if(opName == '_and'){
            results[itemPathKey] = deps.every(e => results[e] == true);
        } else if(opName == '_or'){
            results[itemPathKey] = deps.some(e => results[e] == true);
        }
    }
    const nonLogicalFilters = fields.filter(e => !e.some(pk => ['_and', '_or', '_not'].includes(pk)))
    const finalRoot = ("<root>" in allDeps ? allDeps["<root>"].every(e => results[e]) : true )
    const finalNonLogic = nonLogicalFilters.every(e => results[e.join('.')])
    return finalRoot && finalNonLogic
}
// TODO: decide wether or not to support <field_direction_nulls> (probaby want to use regex in this case)
const parseOrderByOperation = (path: string[], value: string) => {
    const [dir, ___, nulls = 'last'] = value.split('_') as ['asc'|'desc', string, 'first'|'last'];
    return { key: path.join('.'), dir, nulls } as OrderByOperation
}

// TODO: decide wether or not to support <field_direction_nulls> (probaby want to use regex in this case)
export function parseOrderBy(query: string | OrderByExpression | OrderByExpression[], paths: string[] = []): OrderByOperation[] {
  // If query is "<field_name>" default to descending nulls last
  if (_.isString(query)) {
    return [{ key: (query as string), dir: 'desc', nulls: 'last' }];
  } else if (_.isArray(query)) {
    const apaths = _.allPaths(query)
    const sorts = apaths.map((e) => parseOrderByOperation(e.slice(1), _.get(query, e)))
    return sorts;
  } else if (_.isObject(query)) {
    // Sort object keys to be deterministic
    const entries = _.allPaths(query).sort(([k1], [k2]) => _.defaultSort(k1, k2));
    const res = entries.map((e) =>  parseOrderByOperation(e, _.get(query, e)))
    return res;
  }
  return [] as OrderByOperation[];
}
 