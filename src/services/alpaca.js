const timeoutMs = 15000;
const deadline = 45000;

(async function fetchAll() {
  const toFetch = [
    this._fetch(`/v1beta1/options/snapshots/${upper}`, params, 20000)
  ];
  const results = await Promise.allSettled(toFetch.map(req => 
    req.final().catch(err => Promise.resolve({ error: err.message })))
  );
  // Handle results array
})();