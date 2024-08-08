import exp from 'constants';
import DataView from './query';
import testingData from './test-data.json'
const data = [ 
  {'name': "B", "value": 18},
  {'name': "A", "value": 8},
  {'name': "E", "value": 18000},
  {'name': "D", "value": 128},
  {'name': "C", "value": 100},
]

describe('query', () => {
  it('filter using provided raw query', () => {
    const dv = new DataView(data, {
      where: { value: { _gt: 100 } },
      order_by: [{ value: "asc" }],
    });
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);
  });
  it('logical operations in where clause', () => {
    const dv = new DataView(data).orderBy([{"value": "asc"}]);
    dv.where({_and: [{name: {_eq: "D"}}, {value: {_eq: 128}}]})
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
    dv.where({_or: [{name: {_eq: "D"}}, {value: {_eq: 18000}}]})
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);
    
    dv.where({_or: [{name: {_eq: "D"}, value: {_gt: 128}}, {value: {_eq: 18000}}]})
    expect(dv.view()).toEqual([{ name: 'E', value: 18000 }]);
    
    dv.where({_or: [{name: {_ne: "D"}, value: {_gt: 128}},{_not: {value: {_in: [18,8,18000,100]}}}]})
    expect(dv.view()).toEqual([{'name': "D", "value": 128}, { name: 'E', value: 18000 }]);

  });
  it('produce a serialized version of a query from fluent interface', () => {
    const dv = new DataView(testingData);
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
    const dv = new DataView(items);
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
