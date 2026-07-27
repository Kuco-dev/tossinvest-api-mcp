/**
 * 동일한 비동기 작업이 동시에 여러 번 실행되지 않도록 보장한다.
 * 진행 중인 작업이 있으면 새 작업을 시작하지 않고 같은 Promise 를 공유한다.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  get isInFlight(): boolean {
    return this.inFlight !== null;
  }

  async run(task: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight;

    const promise = (async () => task())();
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = null;
      }
    }
  }
}
