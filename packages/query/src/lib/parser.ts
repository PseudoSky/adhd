import { Transform as _ } from '@adhd/transform';
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

export function compileWhere(query: BooleanExpression): (obj: any) => boolean {
    // Compile phase: analyze query tree once
    const logical = _.allPaths(query, (key) => ['_and', '_or', '_not'].includes(key.toString()))
    const filters = _.allPaths(query, (key) => key.toString().startsWith('_') && !['_and', '_or', '_not'].includes(key.toString()))
    const fields = _.allPaths(query, (key, _, o) => !/^[0-9]+$/.test(`${key}`) && !key.toString().startsWith('_') && Object.keys(o[key] as object).every(e => e.startsWith('_') && !['_and', '_or', '_not'].includes(e)))

    let deps = {} as Record<string, string[]>;
    const fieldDeps = {} as Record<string, string[]>;
    const compiledFilters = filters.reduce((res, item) => {
        const key = item.join('.')
        const depKey = item.slice(0, -1).join('.');
        const fieldKey = item.filter(e => (!e.startsWith('_') && ! /^[0-9]+$/.test(e))).join('.')
        const opName = item[item.length - 1]
        fieldDeps[depKey] = [...(fieldDeps[depKey] || []), key]
        const op = operators[opName]
        if (!op) {
            console.error(`@adhd/query where operation ${opName} does not exist. Try one of ${Object.keys(operators)}`)
        }
        return [...res, { field: fieldKey, key, op, value: _.get(query, item) }]
    }, [] as { field: string, op: ReturnType<typeof operators[string]> | undefined, key: string, value: any }[])

    deps = fields.reduce((res, item) => {
        const parent = findLogicalParent(item);
        const parentDeps = (parent in res ? res[parent] : [])
        if (/_or$/.test(parent)) {
            const implicitKey = item.slice(0, parent.split('.').length + 1).join('.') + '._and'
            res[implicitKey] = res[implicitKey] || []
            res[implicitKey].push(item.join('.'))
            if (!parentDeps.includes(implicitKey)) {
                parentDeps.push(implicitKey)
                logical.push(implicitKey.split('.'))
            }
        } else {
            parentDeps.push(item.join('.'))
        }
        return { ...res, [parent]: parentDeps };
    }, deps as Record<string, string[]>)

    const allDeps = logical.reduce((res, item) => {
        const parent = findLogicalParent(item);
        return { ...res, [parent]: (parent in res ? res[parent] : []).concat([item.join('.')]) };
    }, deps as Record<string, string[]>)

    const sortedLogical = [...logical].sort((a, b) => b.length - a.length);
    const nonLogicalFilters = fields.filter(e => !e.some(pk => ['_and', '_or', '_not'].includes(pk)));
    const hasRootDeps = "<root>" in allDeps;
    const fieldDepEntries = Object.entries(fieldDeps);

    // Execute phase: per-row evaluator
    return (obj: any): boolean => {
        const results = {} as Record<string, boolean>;

        for (const item of compiledFilters) {
            if (!item.op) continue;
            const input = _.get(obj, item.field);
            results[item.key] = item.op(input)(item.value);
        }

        for (const [fd, items] of fieldDepEntries) {
            results[fd] = items.every(e => results[e]);
        }

        for (const item of sortedLogical) {
            const itemPathKey = item.join('.');
            const opName = item[item.length - 1];
            const itemDeps = allDeps[itemPathKey];
            if (opName === '_not') {
                results[itemPathKey] = itemDeps.some(e => results[e] === false);
            } else if (opName === '_and') {
                results[itemPathKey] = itemDeps.every(e => results[e] === true);
            } else if (opName === '_or') {
                results[itemPathKey] = itemDeps.some(e => results[e] === true);
            }
        }

        const finalRoot = hasRootDeps ? allDeps["<root>"].every(e => results[e]) : true;
        const finalNonLogic = nonLogicalFilters.every(e => results[e.join('.')]);
        return finalRoot && finalNonLogic;
    };
}

export function parseWhere(query: BooleanExpression, obj: any) {
    return compileWhere(query)(obj);
}
// TODO: decide wether or not to support <field_direction_nulls> (probaby want to use regex in this case)
const parseOrderByOperation = (path: string[], value: string) => {
    const [dir, ___, nulls = 'last'] = value.split('_') as ['asc' | 'desc', string, 'first' | 'last'];
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
        const res = entries.map((e) => parseOrderByOperation(e, _.get(query, e)))
        return res;
    }
    return [] as OrderByOperation[];
}
