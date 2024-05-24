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
  it('produce a serialized version of a query from fluent interface', () => {
    const dv = new DataView(data);
    dv.where({_and: [{name: {_eq: "D"}}, {value: {_eq: "128"}}]})
    expect(dv.view()).toEqual([{'name': "D", "value": 128}]);
  });
  it('produce a serialized version of a query from fluent interface', () => {
    const dv = new DataView(testingData);
    dv.orderBy([{"title": "asc"}])
    expect(dv.limit(1).view()[0].title).toEqual("Appian Connected Claims")
    expect(dv.offset(1).view()[0].title).toEqual("Appian Connected KYC")
    dv.orderBy([{"title": "desc"}])
    expect(dv.offset(0).view()[0].title).toEqual("WordPress")
    expect(dv.offset(1).view()[0].title).toEqual("Vertica by the Hour, Red Hat")
  })
});
