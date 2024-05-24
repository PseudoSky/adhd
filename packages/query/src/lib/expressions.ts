/**
 * Generic operators (all column types except json, jsonb)
 */
export interface GenericOperator<T> {
    _eq?: T
    _gt?: T
    _gte?: T
    _in?: Array<T>
    _is_null?: boolean
    _lt?: T
    _lte?: T
    _ne?: T
    _nin?: Array<T>
  }
  
  /** expression to compare columns of type Int. All fields are combined with logical 'AND'. */
  export type NumberOperator = GenericOperator<number>
  
  /** expression to compare columns of type String. All fields are combined with logical 'AND'. */
  export interface StringOperator extends GenericOperator<string> {
    _ilike?: string
    _like?: string
    _nilike?: string
    _nlike?: string
    _nsimilar?: string
    _similar?: string
    _regex?: string
    _iregex?: string
    _nregex?: string
    _niregex?: string
  }
  
  /** expression to compare columns of type json. All fields are combined with logical 'AND'. */
  export interface JsonOperator extends GenericOperator<number | string | object> {
    /* is the column contained in the given json value */
    _contained_in?: object
    /* does the column contain the given json value at the top level */
    _contains?: object
    /* does the string exist as a top-level key in the column */
    _has_key?: string
    /* do any of these strings exist as top-level keys in the column */
    _has_keys_any?: string[]
    /* do all of these strings exist as top-level keys in the column */
    _has_keys_all?: string[]
  }
  
  export type Operator = NumberOperator | StringOperator | JsonOperator
  
  export interface BooleanExpression {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    _and?: BooleanExpression[]
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    _or?: BooleanExpression[]
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    _not?: BooleanExpression
    [key: string]: Operator | BooleanExpression | BooleanExpression[]
  }


type OrderByValue = "asc" | // in ascending order, nulls last
                     "asc_nulls_first" | // in ascending order, nulls first
                     "asc_nulls_last" | // in ascending order, nulls last
                     "desc" | // in descending order, nulls first
                     "desc_nulls_first" | // in descending order, nulls first
                     "desc_nulls_last" // in descending order, nulls last

export interface OrderByExpression {
    [key: string]: OrderByValue
}


export interface QueryExpression {
    distinct_on?: string[]
    limit?: number
    offset?: number
    order_by?: OrderByExpression[]
    where?: BooleanExpression
}

export type QueryExpressionValues = QueryExpression | OrderByExpression[] | BooleanExpression