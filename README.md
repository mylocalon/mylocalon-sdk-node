# @mylocalon/sdk-node

Open mylocalon tunnels from Node.js code. The `mylocalon` CLI is built on it.

```ts
import { Tunnel } from "@mylocalon/sdk-node";

const tunnel = new Tunnel({
  gatewayUrl: "wss://gateway.mylocalon.com/tunnel",
  tokenProvider: async () => getJwtFromPlatform(), // POST https://mylocalon.com/api/v1/tokens with your API key
  target: "http://localhost:3000",
});
tunnel.on("request", (r) => console.log(r.method, r.path, r.status));
const { url } = await tunnel.connect();
console.log(url);
```
