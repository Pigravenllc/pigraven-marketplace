// The address rules both copies must agree on: the mod's (hooks/mod.tsx, by hand) and pair.js's (the URL class). plugin/tests/mod.test.tsx
// runs the mod over it and hooks/test/address-parity.test.js runs pair.js over it, reading the JSON after "= [" below.
export const cases: { url: string; key: string | null; safe: boolean }[] = [
  { "url": "https://Steerline.Example:443/", "key": "https://steerline.example", "safe": true },
  { "url": "https://steerline.example/base/", "key": "https://steerline.example/base", "safe": true },
  { "url": "https://user@Steerline.Example/", "key": "https://steerline.example", "safe": true },
  { "url": "http://localhost:5311", "key": "http://localhost:5311", "safe": true },
  { "url": "http://LOCALHOST:80/", "key": "http://localhost", "safe": true },
  { "url": "http://127.0.0.1:5311", "key": "http://127.0.0.1:5311", "safe": true },
  { "url": "http://[::1]:5311", "key": "http://[::1]:5311", "safe": true },
  { "url": "http://steerline.example", "key": "http://steerline.example", "safe": false },
  { "url": "http://localhost@steerline.example", "key": "http://steerline.example", "safe": false },
  { "url": "http://127.0.0.1:1@steerline.example", "key": "http://steerline.example", "safe": false },
  { "url": "http://steerline.example\\@localhost", "key": "http://steerline.example/@localhost", "safe": false },
  { "url": "ftp://steerline.example", "key": null, "safe": false }
]
