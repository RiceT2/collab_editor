declare module 'priorityqueuejs' {
  class PriorityQueue<T> {
    constructor(cmp?: (a: T, b: T) => number)
    enq(item: T): void
    deq(): T
    peek(): T
    size(): number
    isEmpty(): boolean
  }
  export default PriorityQueue
}
