# Artillery - Add Task & Clear Session

This scenario uses WebSockets directly against the Meteor DDP endpoint (`/websocket`) to simulate client interaction:

- Connects to the Meteor server via DDP.
- Generates a unique `sessionId` per virtual user.
- Subscribes to the `links` publication to receive documents inserted by the server.
- Invokes `links.insert` 10 times with the same `sessionId`.
- Finishes by calling `links.clearSession` to remove the records created by that client.
- Each insertion measures the time between the `createdAt` assigned in the client (and passed to the server) and the receipt of the corresponding `added` message in the client, recording the metric `links_roundtrip_createdAt_ms`.

## How to run

1. Make sure the Meteor application is running (by default at `http://localhost:3000`).
2. Install Artillery if not already available:

   ```bash
   npm install --global artillery
   ```

   Or run via `npx` without global installation.

3. Execute the scenario:

   ```bash
   npx artillery run tests/artillery/add-task.yml
   ```

   Adjust the `phases` in the YAML according to the desired arrival rate.

## Customizations

- Modify `phases` to change duration and arrival rate.
- Adjust `count` in the YAML loop if you want more or fewer insertions per session.
- Change `context.vars.roundTripTimeoutMs` in `processors.js` if you need a different timeout for the `server -> client` replication.
