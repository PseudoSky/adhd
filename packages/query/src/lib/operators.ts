export const Operators = [
  { name: 'equals', value: '$eq', graphqlOp: '_eq' },
  { name: 'not equals', value: '$ne', graphqlOp: '_neq' },
  { name: 'in', value: '$in', graphqlOp: '_in', defaultValue: '[]' },
  { name: 'not in', value: '$nin', graphqlOp: '_nin', defaultValue: '[]' },
  { name: '>', value: '$gt', graphqlOp: '_gt' },
  { name: '<', value: '$lt', graphqlOp: '_lt' },
  { name: '>=', value: '$gte', graphqlOp: '_gte' },
  { name: '<=', value: '$lte', graphqlOp: '_lte' },
  { name: 'like', value: '$like', graphqlOp: '_like', defaultValue: '%%' },
  {
    name: 'not like',
    value: '$nlike',
    graphqlOp: '_nlike',
    defaultValue: '%%',
  },
  {
    name: 'like (case-insensitive)',
    value: '$ilike',
    graphqlOp: '_ilike',
    defaultValue: '%%',
  },
  {
    name: 'not like (case-insensitive)',
    value: '$nilike',
    graphqlOp: '_nilike',
    defaultValue: '%%',
  },
  { name: 'similar', value: '$similar', graphqlOp: '_similar' },
  { name: 'not similar', value: '$nsimilar', graphqlOp: '_nsimilar' },
  {
    name: '~',
    value: '$regex',
    graphqlOp: '_regex',
  },
  {
    name: '~*',
    value: '$iregex',
    graphqlOp: '_iregex',
  },
  {
    name: '!~',
    value: '$nregex',
    graphqlOp: '_nregex',
  },
  {
    name: '!~*',
    value: '$niregex',
    graphqlOp: '_niregex',
  },
];

export type OrderByOperation = {
  key: string;
  dir: "asc" | "desc";
  nulls: "first" | "last";
}