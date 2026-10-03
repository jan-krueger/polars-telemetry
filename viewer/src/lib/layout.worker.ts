import { layout, type Graph } from "./graph";

const scope = self as unknown as { onmessage: (event: MessageEvent<Graph>) => void; postMessage: (message: unknown) => void };
scope.onmessage = (event) => scope.postMessage(layout(event.data));
