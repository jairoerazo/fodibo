import type { FodiboApi } from '../shared/ipc.js';

declare global {
  interface Window {
    fodibo: FodiboApi;
  }
}
