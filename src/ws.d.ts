declare module 'ws' {
  import { EventEmitter } from 'events';
  class WebSocket extends EventEmitter {
    static OPEN: number;
    constructor(url: string, options?: any);
    readyState: number;
    send(data: any): void;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export default WebSocket;
}
