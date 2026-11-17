'use strict';

// SharedWorker: tells the local server that at least one app window is open.
//
// The server exits once no /api/events stream has been open for a while. All
// windows of the app share this one worker and therefore one stream, so many
// windows cannot use up Chrome's six connections per host. The worker ends
// with the last window, which closes the stream.

// Kept for the worker's lifetime; EventSource reconnects by itself.
const events = new EventSource('/api/events');

// Windows only need to connect to keep the worker alive; nothing is exchanged.
self.onconnect = () => {};
