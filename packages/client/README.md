# @earendil-works/pi-client

Transport-neutral client for remote pi sessions. `PiClient` exchanges length-prefixed CBOR messages through a small `ByteTransport` interface. The package has no Node-specific imports.

```ts
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver chunks in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = new PiClient({ token: bearerToken, transportFactory });
await client.connect();
const session = await client.createSession({ cwd: "/workspace" });
const unsubscribe = session.subscribe((snapshot) => render(snapshot));
await session.prompt("Inspect this project");
unsubscribe();
```

Call `handlers.onData(chunk)` for inbound bytes, `handlers.onClose()` for an orderly terminal close, and `handlers.onError(error)` for transport failures. A factory must create a fresh transport for every connection attempt.

`PiClient` does not reconnect automatically. Call `reconnect()` after disconnection. One connection can attach several sessions. Requests are correlated by ID. Server snapshots and successful response snapshots are authoritative, while progress events do not mutate snapshot state optimistically. Read cached session summaries from `client.snapshot?.sessions`; call `listSessions()` to request a refreshed list from the server.

`createSession()` and `attachSession()` return a `PiSessionHandle`; handles cannot be constructed directly. A returned handle is attached and remains a stable client-side reference for that session. Explicit detach, server removal, or disconnection makes a retained handle unavailable for commands. Its latest snapshot remains readable after detach or disconnection unless the server removes the session. Calling `attachSession()` again reacquires the session and returns the existing handle. Commands fail with `PiDisconnectedError` while the client is disconnected and `PiSessionDetachedError` when the client is connected but the session is detached.

`subscribe()` observes authoritative snapshots. `onEvent()` observes protocol events. Both return an unsubscribe function. Structured errors returned by the server are exposed as `PiServerError`.

## Limits and security

`PiClientOptions.maxFrameLength` bounds inbound and outbound CBOR payloads. Configure matching limits on the client and server. Transports should separately bound queued outbound bytes and preserve send order.

Treat peers as untrusted. Use a secure transport where required and protect the protocol bearer token.

Subscriber exceptions are isolated from protocol state. Set `onListenerError` in `PiClientOptions` to report them to application logging or diagnostics.
