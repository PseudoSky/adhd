import { QueryExpression, BooleanExpression } from './expressions';
import { DataView } from './query';
import util from 'util';
import { parseOrderBy, parseWhere } from './parser';
const data = [ 
  {'name': "B", "value": 18},
  {'name': "A", "value": 8},
  {'name': "E", "value": 18000},
  {'name': "D", "value": 128},
  {'name': "C", "value": 100},
]

describe('query.parseWhere', () => {

      it('(2) logical and to work', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {_and: [{name: {_eq: "D"}}, {value: {_eq: 128}}]}
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        // dv.where(query)
        console.log(util.inspect({query, res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([{'name': "D", "value": 128}]);
      })
      it('(3) logical not to work', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {
          name: {_eq: "D"},
          value: {
            _gt:0,
            _lt: 10000,
            _gte: 1,
            _lte: 9999,
          }
        }
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query, res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([{'name': "D", "value": 128}]);
      })
      it('(4) logical tripple and', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {_and: [{_and:[{_and:[{name: {_eq: "D"}}]}]}]}
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query,res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([{'name': "D", "value": 128}]);
      })
      it('(5) logical and or and', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {_and: [{_or:[{_and:[{name: {_eq: "D"}}]}]}]}
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query,res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([{'name': "D", "value": 128}]);
      })
      it('(6) logical and or and 2 keys', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {_and: [{_or:[{_and:[{name: {_eq: "D"}, value: {_eq: 128}}]}]}]}
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query,res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([{'name': "D", "value": 128}]);
      })
      it('(7) logical and or not 2 keys', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {_and: [{_or:[{_not:{name: {_eq: "D"}, value: {_eq: 128}}}]}]}
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query,res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([
          {'name': "A", "value": 8},
          {'name': "B", "value": 18},
          {'name': "C", "value": 100},
          {'name': "E", "value": 18000},
        ]);
      })
      it('(8) logical and or(2 entries) not(2 keys)', () => {
        // const dv = new DataView(data, undefined, true).orderBy([{"value": "asc"}]);
        const query: BooleanExpression = {
            _and: [
                {
                    _or:[
                        {name: {_eq: "D"}},
                        {_not:{name: {_eq: "D"}, value: {_eq: 128}}}
                    ]
                }
                ]
            }
        // dv.where(query)
        const res = data.filter( d => parseWhere(query, d)).sort((a, b) => a.value-b.value)
        console.log(util.inspect({query,res}, {showHidden: false, depth: null, colors: true}))
        expect(res).toEqual([
          {'name': "A", "value": 8},
          {'name': "B", "value": 18},
          {'name': "C", "value": 100},
          {'name': "D", "value": 128},
          {'name': "E", "value": 18000},
        ]);
      })
})

describe('query.parseOrderBy', () => {

    it('(1) basic field object', () => {
      parseOrderBy({name: "asc"})
    })
    // it('(2) basic string', () => {
    //     parseOrderBy("name_asc_nulls_first")
    // })
    // it('(2) basic array', () => {
    //     parseOrderBy(["name_asc_nulls_first", "value"])
    // })
})