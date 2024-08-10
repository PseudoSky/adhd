import exp from 'constants';
import util from 'util';
import DataView from './query';
import testingData from './test-data.json'
import { BooleanExpression, QueryExpression } from './expressions';
const data = [ 
  {'name': "B", "value": 18},
  {'name': "A", "value": 8},
  {'name': "E", "value": 18000},
  {'name': "D", "value": 128},
  {'name': "C", "value": 100},
]

describe('query', () => {
  it('(1) filter using provided raw query', () => {
    const query: QueryExpression = {
      where: { value: { _gt: 100 } },
      order_by: [{ value: "asc" }],
    }
    const dv = new DataView(data, query, true);
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);
  });
  it('(2) logical and to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{name: {_eq: "D"}}, {value: {_eq: 128}}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  })
  it('(3) logical not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_not: {name: {_eq: "D"}}}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual(data.filter(e => e.name!=="D").sort((a,b) => a.value-b.value));
  })
  it('(3) logical not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      name: {_eq: "D"},
      value: {
        _gt:0,
        _lt: 10000,
        _gte: 1,
        _lte: 9999,
      }
    }
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  })
  it('(4) logical tripple and', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{_and:[{_and:[{name: {_eq: "D"}}]}]}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  })
  it('(5) logical and or and', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{_or:[{_and:[{name: {_eq: "D"}}]}]}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  })
  it('(6) logical and or and 2 keys', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{_or:[{_and:[{name: {_eq: "D"}, value: {_eq: 128}}]}]}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  })
  it('(7) logical and or not 2 keys', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{_or:[{_not:{name: {_eq: "D"}, value: {_eq: 128}}}]}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([
      {'name': "A", "value": 8},
      {'name': "B", "value": 18},
      {'name': "C", "value": 100},
      {'name': "E", "value": 18000},
    ]);
  })
  it('(8) logical and or(2 entries) not(2 keys)', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_and: [{_or:[{name: {_eq: "D"}},{_not:{name: {_eq: "D"}, value: {_eq: 128}}}]}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([
      {'name': "A", "value": 8},
      {'name': "B", "value": 18},
      {'name': "C", "value": 100},
      {'name': "D", "value": 128},
      {'name': "E", "value": 18000},
    ]);
  })
  it('(9) logical or to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {_or: [{name: {_eq: "D"}}, {value: {_eq: 18000}}]}
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);
  })
  it('(10) logical complex or to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      _or: [
        {_and: [{name: {_eq: "D"}, value: {_ne: 128}}]}, // Not D
        {value: {_eq: 18000}} // IS E
      ]
    }
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual(data.filter(e => (e.name==="D" && e.value!==128)||(e.value===18000)).sort((a,b) => a.value-b.value));
  })
  it('(11) logical or with nested not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      _or: [
        {name: {_ne: "D"}, value: {_gt: 128}}, // Only E
        {_not: {value: {_in: [18,8,18000,100]}}} // Only D
      ]
    }
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);

  });  
  it('(11.1) nested properties', () => {
    const dv = new DataView([
      { a: { b: { c:1000 } } }, 
      { a: { b: { c:2000 } } }, 
      { a: { b: { c:1 } } }, 
      { a: { b: { c:-100 } } },
    ], undefined, true)//.orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      a:{b: {c: {_lt: 1001, _gt: 10}}}
    }
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{ a: { b: { c:1000 } } }]);

  });
  it('(12) logical or with and to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      _or: [
        {name: {_ne: "D"}, value: {_gt: 128}},
        {
          _and: [
            {value: {_in: [18,8,18000,100]}},
            {name: {_in: ["B", "A", "E"]}}
          ]
        }
      ]
    }
    dv.where(query)
    console.log(util.inspect(query, {showHidden: false, depth: null, colors: true}))
    expect(dv.view()).toEqual([{'name': "A", "value": 8}, {'name': "B", "value": 18},{ name: 'E', value: 18000 }]);
  });
  it.skip('produce a serialized version of a query from fluent interface', () => {
    const dv = new DataView(testingData, undefined);
    dv.orderBy([{"title": "asc"}])
    expect(dv.limit(1).view()[0].title).toEqual("Appian Connected Claims")
    expect(dv.offset(1).view()[0].title).toEqual("Appian Connected KYC")
    dv.orderBy([{"title": "desc"}])
    expect(dv.offset(0).view()[0].title).toEqual("WordPress")
    expect(dv.offset(1).view()[0].title).toEqual("Vertica by the Hour, Red Hat")
    // TEST: limit can be unset
    dv.limit().offset(0)
    // TEST: check the or count
    expect(dv.where({_or: [
      {"company_name":{_eq:'Freshworks Inc.'}},
      {"product_id":{_eq: "prodview-h54kdzendnnkm"}}
    ]}).view().length).toEqual(5)
    // TEST: check the and + or filters
    expect(dv.where({
      _and: [
        {_not: {
          reviews_aws_value: {_eq: 0}
        }},
        {_or: [
          {"company_name":{_eq:'Freshworks Inc.'}},
          {"product_id":{_eq: "prodview-h54kdzendnnkm"}}
        ]}
      ]
    }).view().length).toEqual(1)
  })
  it('test ordering', () => {
    const items = [
      { column1: 'B', column2: 2 },
      { column1: 'A', column2: 3 },
      { column1: "C", column2: null },
      { column1: 'A', column2: 1 },
      { column1: 'B', column2: 1 },
      { column1: null, column2: 1 }
    ];
    const dv = new DataView(items, undefined, true);
    dv.orderBy([{"column1": "asc_nulls_first"}, {column2: "desc"}])
    expect(dv.view()).toEqual([
      { column1: null, column2: 1 },
      { column1: 'A', column2: 3 },
      { column1: 'A', column2: 1 },
      { column1: 'B', column2: 2 },
      { column1: 'B', column2: 1 },
      { column1: 'C', column2: null }
    ]);
    dv.orderBy([{"column1": "asc_nulls_first"}])
    expect(dv.view()).toEqual([
      { column1: null, column2: 1 },
      { column1: 'A', column2: 3 },
      { column1: 'A', column2: 1 },
      { column1: 'B', column2: 2 },
      { column1: 'B', column2: 1 },
      { column1: 'C', column2: null }
    ]);
    dv.orderBy([{"column1": "asc_nulls_last"}])
    expect(dv.view()).toEqual([
      { column1: 'A', column2: 3 },
      { column1: 'A', column2: 1 },
      { column1: 'B', column2: 2 },
      { column1: 'B', column2: 1 },
      { column1: 'C', column2: null },
      { column1: null, column2: 1 }
    ]);
    dv.orderBy([{"column1": "asc_nulls_last"},{"column2": "asc_nulls_last"}])
    expect(dv.view()).toEqual([
      { column1: 'A', column2: 1 },
      { column1: 'A', column2: 3 },
      { column1: 'B', column2: 1 },
      { column1: 'B', column2: 2 },
      { column1: 'C', column2: null },
      { column1: null, column2: 1 }
    ]);
  })
});
