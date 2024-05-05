import DataView from './query';
const data = [
  {'name': "A", "value": 18},
  {'name': "B", "value": 8},
  {'name': "C", "value": 128},
  {'name': "D", "value": 100},
  {'name': "E", "value": 18000},
]
describe('query', () => {
  it('should work', () => {
    const dv = new DataView(data, {
      where: { value: { _gt: 100 } },
      order_by: { value: "asc" },
    });
    expect(dv.view()).toEqual([{'name': "C", "value": 128}, { name: 'E', value: 18000 }]);
  });
});
