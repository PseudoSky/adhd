export class Stack {
  data: any[];
  counters: {
    pushed: { [key: string]: number };
    popped: { [key: string]: number };
  };

  constructor() {
    this.data = [];
    this.counters = {
      'pushed': {
        'total': 0,
        'site': 0,
        'local': 0,
        'raw': 0,
        'link': 0,
        'map': 0,
        'source': 0,
        'write': 0,
      },
      'popped': {
        'total': 0,
        'site': 0,
        'local': 0,
        'raw': 0,
        'link': 0,
        'map': 0,
        'source': 0,
        'write': 0,
      }
    };
  }

  push = (type, value) => {
    this.data.push([type, value]);
    this.counters.pushed[type] += 1;
    this.counters.pushed['total'] += 1;
  }

  pop = () => {
    if (this.data.length) {
      const r = this.data.pop();
      this.counters.popped[r[0]] += 1
      this.counters.popped['total'] += 1
      // console.log(`ObjStack.pop[${r[0]}]`)
      return r
    } else {
      return null
    }
  }
  hasMore = () => this.data.length > 0;
  isComplete = () => this.counters.popped.total === this.counters.pushed.total;
}

type ObjStackType = {
  data: any[];
  counters: {
    pushed: { [key: string]: number };
    popped: { [key: string]: number };
  };
  push?: (type: string, value: any) => void;
  pop?: () => [string, any] | null;
};

const ObjStack: ObjStackType = {
  data: [],
  counters: {
    'pushed': {
      'total': 0,
      'site': 0,
      'local': 0,
      'raw': 0,
      'link': 0,
      'map': 0,
      'source': 0,
      'write': 0,
    },
    'popped': {
      'total': 0,
      'site': 0,
      'local': 0,
      'raw': 0,
      'link': 0,
      'map': 0,
      'source': 0,
      'write': 0,
    }
  }
}

ObjStack.push = (type, value) => {
  // console.log(`ObjStack.push[${type}]`)
  ObjStack.data.push([type, value]);
  ObjStack.counters.pushed[type] += 1
  ObjStack.counters.pushed['total'] += 1
}
// https://d301sr5gafysq2.cloudfront.net/frontbucket/navigation-next-repository.96cf4d7993173fe30d4c.js
ObjStack.pop = () => {
  if (ObjStack.data.length) {
    const r = ObjStack.data.pop();
    ObjStack.counters.popped[r[0]] += 1
    ObjStack.counters.popped['total'] += 1
    // console.log(`ObjStack.pop[${r[0]}]`)
    return r
  } else {
    return null
  }
}

export default Stack;
